/**
 * index.js — one scan + (maybe) trade cycle.
 * Run manually with `node index.js`, or on a schedule via GitHub Actions
 * (see .github/workflows/scanner.yml).
 */
const { fetchTopSymbols, fetchClosedKlines, getOpenPosition, placeMarketShort } = require("./lib/bybit");
const { getFreshTriggeredSignal } = require("./lib/scanner");
const { notify } = require("./lib/telegram");

const TOP_N = parseInt(process.env.TOP_N || "100", 10);
const INTERVAL = process.env.INTERVAL || "15m";
const REQUIRE_CLEAN_LINE = String(process.env.REQUIRE_CLEAN_LINE || "true").toLowerCase() === "true";
const MARGIN_USDT = parseFloat(process.env.MARGIN_USDT || "25");
const LEVERAGE = parseInt(process.env.LEVERAGE || "5", 10);
const CONCURRENCY = parseInt(process.env.CONCURRENCY || "6", 10);
const DRY_RUN = String(process.env.DRY_RUN || "false").toLowerCase() === "true";

async function runPool(items, worker, concurrency) {
  let idx = 0;
  const results = new Array(items.length);
  async function next() {
    while (idx < items.length) {
      const my = idx++;
      try {
        results[my] = await worker(items[my]);
      } catch (e) {
        console.error(`[${items[my].symbol}] error:`, e.message);
        results[my] = null;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, next));
  return results;
}

async function processSymbol(t) {
  const symbol = t.symbol;
  const candles = await fetchClosedKlines(symbol, INTERVAL, 500);
  if (candles.length < 60) return null;

  const signal = getFreshTriggeredSignal(candles, REQUIRE_CLEAN_LINE);
  if (!signal) return null;

  console.log(`[${symbol}] FRESH SELL SIGNAL — entry ${signal.entryPrice} @ ${new Date(signal.entryTime).toISOString()}`);

  const existing = await getOpenPosition(symbol);
  if (existing) {
    await notify(`⚠️ ${symbol}: fresh SELL signal but a position is already open (amt ${existing.positionAmt}) — skipped.`);
    return { symbol, skipped: "existing_position" };
  }

  if (DRY_RUN) {
    await notify(
      `🧪 DRY_RUN — would SHORT ${symbol} @ ~${signal.entryPrice}, margin ${MARGIN_USDT} USDT, ${LEVERAGE}x. Set DRY_RUN=false to go live.`
    );
    return { symbol, dryRun: true };
  }

  const { order, quantity, notional } = await placeMarketShort({
    symbol,
    marginUsdt: MARGIN_USDT,
    leverage: LEVERAGE,
    price: signal.entryPrice,
  });

  await notify(
    `🔴 SHORT placed: <b>${symbol}</b>\n` +
      `Entry (signal close): ${signal.entryPrice}\n` +
      `Qty: ${quantity} (~${notional.toFixed(2)} USDT notional, ${LEVERAGE}x)\n` +
      `Order ID: ${order.orderId}\n` +
      `Interval: ${INTERVAL}\n` +
      `⚠️ SL/TP not auto-placed — manage manually.`
  );

  return { symbol, order };
}

async function main() {
  console.log(`Scan start — top ${TOP_N} by volume, interval ${INTERVAL}, ${new Date().toISOString()}`);
  const top = await fetchTopSymbols(TOP_N);
  const results = await runPool(top, processSymbol, CONCURRENCY);
  const acted = results.filter(Boolean);
  console.log(`Scan complete. ${acted.length} symbol(s) actioned.`);
  if (!acted.length) console.log("No fresh triggered signals this cycle.");
}

main().catch(async (e) => {
  console.error("Fatal error:", e);
  await notify(`🔥 Scanner bot crashed: ${e.message}`);
  process.exit(1);
});
