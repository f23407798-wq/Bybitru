/**
 * bybit.js
 * -----------------------------------------------------------------------
 * Thin wrapper around Bybit V5 USDT Perpetual (linear) API.
 * - Public endpoints (kline, tickers, instruments-info) need no key.
 * - Private endpoints (order, position, leverage) are HMAC-SHA256
 *   signed using BYBIT_API_KEY / BYBIT_API_SECRET from env vars.
 *
 * LIVE by default. If you ever want to dry-run against Bybit's Testnet
 * instead, set BYBIT_TESTNET=true and use testnet-only API keys from
 * https://testnet.bybit.com
 *
 * Exposes the exact same function names/shapes as the old binance.js so
 * index.js and scanner.js did not need to change.
 * -----------------------------------------------------------------------
 */
const crypto = require("crypto");

const TESTNET = String(process.env.BYBIT_TESTNET || "false").toLowerCase() === "true";
const BASE_URL = TESTNET ? "https://api-testnet.bybit.com" : "https://api.bybit.com";

const API_KEY = process.env.BYBIT_API_KEY;
const API_SECRET = process.env.BYBIT_API_SECRET;
const RECV_WINDOW = "10000";
const CATEGORY = "linear"; // USDT-M perpetual futures

/* ---------------------------- interval mapping ---------------------------- */
// Your INTERVAL env var (e.g. "15m", "1h", "4h", "1d") -> Bybit kline interval codes
const INTERVAL_MAP = {
  "1m": "1", "3m": "3", "5m": "5", "15m": "15", "30m": "30",
  "1h": "60", "2h": "120", "4h": "240", "6h": "360", "12h": "720",
  "1d": "D", "1w": "W", "1M": "M",
};
const INTERVAL_MS = {
  "1": 60000, "3": 180000, "5": 300000, "15": 900000, "30": 1800000,
  "60": 3600000, "120": 7200000, "240": 14400000, "360": 21600000, "720": 43200000,
  D: 86400000, W: 604800000, M: 2592000000,
};

function toBybitInterval(interval) {
  return INTERVAL_MAP[interval] || interval; // allow passing a raw Bybit code too
}

function sign(payload) {
  return crypto.createHmac("sha256", API_SECRET).update(payload).digest("hex");
}

function toQueryString(params) {
  return Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
}

async function publicGet(path, params = {}) {
  const qs = toQueryString(params);
  const url = `${BASE_URL}${path}${qs ? "?" + qs : ""}`;
  const res = await fetch(url);
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.retCode !== 0) {
    throw new Error(`GET ${path} failed: HTTP ${res.status} ${JSON.stringify(body)}`);
  }
  return body.result;
}

async function signedGet(path, params = {}) {
  if (!API_KEY || !API_SECRET) {
    throw new Error("BYBIT_API_KEY / BYBIT_API_SECRET are not set (check your GitHub Actions secrets).");
  }
  const timestamp = Date.now().toString();
  const qs = toQueryString(params);
  const signature = sign(timestamp + API_KEY + RECV_WINDOW + qs);
  const url = `${BASE_URL}${path}${qs ? "?" + qs : ""}`;
  const res = await fetch(url, {
    headers: {
      "X-BAPI-API-KEY": API_KEY,
      "X-BAPI-SIGN": signature,
      "X-BAPI-SIGN-TYPE": "2",
      "X-BAPI-TIMESTAMP": timestamp,
      "X-BAPI-RECV-WINDOW": RECV_WINDOW,
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.retCode !== 0) {
    throw new Error(`GET ${path} failed: HTTP ${res.status} ${JSON.stringify(body)}`);
  }
  return body.result;
}

async function signedPost(path, params = {}, { ignoreRetCodes = [] } = {}) {
  if (!API_KEY || !API_SECRET) {
    throw new Error("BYBIT_API_KEY / BYBIT_API_SECRET are not set (check your GitHub Actions secrets).");
  }
  const timestamp = Date.now().toString();
  const bodyStr = JSON.stringify(params);
  const signature = sign(timestamp + API_KEY + RECV_WINDOW + bodyStr);
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-BAPI-API-KEY": API_KEY,
      "X-BAPI-SIGN": signature,
      "X-BAPI-SIGN-TYPE": "2",
      "X-BAPI-TIMESTAMP": timestamp,
      "X-BAPI-RECV-WINDOW": RECV_WINDOW,
    },
    body: bodyStr,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || (body.retCode !== 0 && !ignoreRetCodes.includes(body.retCode))) {
    throw new Error(`POST ${path} failed: HTTP ${res.status} ${JSON.stringify(body)}`);
  }
  return body.result;
}

/* ---------------------------- market data ---------------------------- */

async function fetchTopSymbols(n) {
  const result = await publicGet("/v5/market/tickers", { category: CATEGORY });
  const usdt = (result.list || []).filter((d) => d.symbol.endsWith("USDT"));
  usdt.sort((a, b) => parseFloat(b.turnover24h) - parseFloat(a.turnover24h));
  return usdt.slice(0, n).map((d) => ({ symbol: d.symbol }));
}

/**
 * Fetches klines and DROPS the last candle if it is still forming
 * (unclosed), so the scanner only ever evaluates fully-closed candles.
 * This matters for a bot — a partially-formed last candle could look
 * like a fresh trend-line break that then reverses before the candle
 * actually closes.
 */
async function fetchClosedKlines(symbol, interval, limit = 500) {
  const bybitInterval = toBybitInterval(interval);
  const result = await publicGet("/v5/market/kline", {
    category: CATEGORY,
    symbol,
    interval: bybitInterval,
    limit,
  });
  const intervalMs = INTERVAL_MS[bybitInterval] || 0;
  // Bybit returns candles most-recent-first — reverse to chronological order
  // (same order the scanner logic expects, matching the old Binance shape).
  const raw = (result.list || []).slice().reverse();
  const candles = raw.map((k) => {
    const start = Number(k[0]);
    return { time: start, open: +k[1], high: +k[2], low: +k[3], close: +k[4], closeTime: start + intervalMs };
  });
  const now = Date.now();
  if (candles.length && candles[candles.length - 1].closeTime > now) {
    candles.pop(); // last candle hasn't closed yet
  }
  return candles;
}

/* ---------------------------- symbol precision ---------------------------- */

const instrumentInfoCache = {};
async function getSymbolFilters(symbol) {
  if (!instrumentInfoCache[symbol]) {
    const result = await publicGet("/v5/market/instruments-info", { category: CATEGORY, symbol });
    const info = (result.list || [])[0];
    if (!info) throw new Error(`Symbol ${symbol} not found in instruments-info`);
    const qtyStepStr = info.lotSizeFilter.qtyStep;
    const stepSize = parseFloat(qtyStepStr);
    const minQty = parseFloat(info.lotSizeFilter.minOrderQty);
    const quantityPrecision = (qtyStepStr.split(".")[1] || "").length;
    instrumentInfoCache[symbol] = { stepSize, minQty, quantityPrecision };
  }
  return instrumentInfoCache[symbol];
}

function roundToStep(qty, stepSize, precision) {
  const stepped = Math.floor(qty / stepSize) * stepSize;
  return parseFloat(stepped.toFixed(precision));
}

/* ---------------------------- account / positions ---------------------------- */

async function getOpenPosition(symbol) {
  const result = await signedGet("/v5/position/list", { category: CATEGORY, symbol });
  const pos = (result.list || []).find((p) => parseFloat(p.size) !== 0);
  if (!pos) return null;
  // Keep a `positionAmt` field (Binance-style) so index.js's notify message
  // needed no changes — negative for a short, matching Binance's convention.
  return { ...pos, positionAmt: pos.side === "Sell" ? `-${pos.size}` : pos.size };
}

async function setLeverage(symbol, leverage) {
  const lev = String(leverage);
  // 110043 = "leverage not modified" (already set to this value) — harmless, ignore it.
  return signedPost(
    "/v5/position/set-leverage",
    { category: CATEGORY, symbol, buyLeverage: lev, sellLeverage: lev },
    { ignoreRetCodes: [110043] }
  );
}

/* ---------------------------- orders ---------------------------- */

/**
 * Places a MARKET SELL (short entry) order sized by fixed USDT margin.
 * No SL/TP orders are placed — per your setup, you manage those manually.
 */
async function placeMarketShort({ symbol, marginUsdt, leverage, price }) {
  await setLeverage(symbol, leverage);
  const { stepSize, minQty, quantityPrecision } = await getSymbolFilters(symbol);

  const notional = marginUsdt * leverage;
  let quantity = roundToStep(notional / price, stepSize, quantityPrecision);
  if (quantity < minQty) {
    throw new Error(
      `Computed quantity ${quantity} for ${symbol} is below exchange minQty ${minQty}. Increase MARGIN_USDT or LEVERAGE.`
    );
  }

  const result = await signedPost("/v5/order/create", {
    category: CATEGORY,
    symbol,
    side: "Sell",
    orderType: "Market",
    qty: String(quantity),
    positionIdx: 0, // one-way position mode
  });

  return { order: { orderId: result.orderId }, quantity, notional };
}

module.exports = {
  TESTNET,
  BASE_URL,
  fetchTopSymbols,
  fetchClosedKlines,
  getSymbolFilters,
  getOpenPosition,
  setLeverage,
  placeMarketShort,
};
