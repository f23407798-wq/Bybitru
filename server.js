/**
 * server.js
 * -----------------------------------------------------------------------
 * Always-on Bybit auto-scanner WITH a web dashboard.
 * - Login-protected page with an ON / OFF button for the bot.
 * - Runs the SAME scan+trade logic (lib/scanner.js, lib/bybit.js) on an
 *   internal timer, instead of GitHub Actions cron.
 * - Shows recent signals/trades on the page (auto-refreshes every 10s).
 *
 * Deploy target: Render.com free web service — see DEPLOY-SINHALA.md.
 * Render's free tier sleeps after ~15 min with no HTTP traffic, so pair
 * this with a free UptimeRobot monitor pinging "/status" every ~10 min
 * to keep the bot actually running around the clock.
 * -----------------------------------------------------------------------
 */
const express = require("express");
const session = require("express-session");
const crypto = require("crypto");

const { fetchTopSymbols, fetchClosedKlines, getOpenPosition, placeMarketShort } = require("./lib/bybit");
const { getFreshTriggeredSignal } = require("./lib/scanner");
const { notify } = require("./lib/telegram");

const PORT = process.env.PORT || 3000;
const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASS = process.env.ADMIN_PASS || "changeme";
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");

const TOP_N = parseInt(process.env.TOP_N || "100", 10);
const INTERVAL = process.env.INTERVAL || "15m";
const REQUIRE_CLEAN_LINE = String(process.env.REQUIRE_CLEAN_LINE || "true").toLowerCase() === "true";
const MARGIN_USDT = parseFloat(process.env.MARGIN_USDT || "25");
const LEVERAGE = parseInt(process.env.LEVERAGE || "5", 10);
const CONCURRENCY = parseInt(process.env.CONCURRENCY || "6", 10);
const DRY_RUN = String(process.env.DRY_RUN || "true").toLowerCase() === "true";
const SCAN_EVERY_MINUTES = parseInt(process.env.SCAN_EVERY_MINUTES || "15", 10);

/* ---------------------------- in-memory state ---------------------------- */
// NOTE: this resets whenever the server restarts (e.g. Render free tier
// waking from sleep runs a fresh instance). Bot defaults to OFF on boot —
// you always have to press "Turn ON" after a restart, on purpose.
const state = {
  botOn: false,
  lastScanAt: null,
  lastScanCount: null,
  scanning: false,
  log: [], // most-recent-first, capped at 100
};

function pushLog(entry) {
  state.log.unshift({ time: new Date().toISOString(), ...entry });
  if (state.log.length > 100) state.log.length = 100;
}

/* ---------------------------- scan cycle (same logic as the old index.js) ---------------------------- */
async function runPool(items, worker, concurrency) {
  let idx = 0;
  const results = new Array(items.length);
  async function next() {
    while (idx < items.length) {
      const my = idx++;
      try {
        results[my] = await worker(items[my]);
      } catch (e) {
        pushLog({ type: "error", symbol: items[my].symbol, message: e.message });
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

  pushLog({ type: "signal", symbol, message: `Fresh SELL signal @ ${signal.entryPrice}` });

  const existing = await getOpenPosition(symbol);
  if (existing) {
    await notify(`⚠️ ${symbol}: fresh SELL signal but a position is already open (amt ${existing.positionAmt}) — skipped.`);
    pushLog({ type: "skipped", symbol, message: "Signal seen but a position is already open." });
    return { symbol, skipped: "existing_position" };
  }

  if (DRY_RUN) {
    await notify(
      `🧪 DRY_RUN — would SHORT ${symbol} @ ~${signal.entryPrice}, margin ${MARGIN_USDT} USDT, ${LEVERAGE}x. Set DRY_RUN=false to go live.`
    );
    pushLog({ type: "dry_run", symbol, message: `Would SHORT @ ~${signal.entryPrice}` });
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

  pushLog({ type: "trade", symbol, message: `SHORT placed @ ~${signal.entryPrice}, qty ${quantity}, order ${order.orderId}` });
  return { symbol, order };
}

async function runScanCycle() {
  if (!state.botOn || state.scanning) return;
  state.scanning = true;
  try {
    const top = await fetchTopSymbols(TOP_N);
    const results = await runPool(top, processSymbol, CONCURRENCY);
    const acted = results.filter(Boolean);
    state.lastScanAt = new Date().toISOString();
    state.lastScanCount = acted.length;
    if (!acted.length) pushLog({ type: "info", message: "Scan complete — no fresh triggered signals." });
  } catch (e) {
    pushLog({ type: "error", message: `Scan cycle crashed: ${e.message}` });
    await notify(`🔥 Scanner crashed: ${e.message}`);
  } finally {
    state.scanning = false;
  }
}

setInterval(runScanCycle, SCAN_EVERY_MINUTES * 60 * 1000);

/* ---------------------------- web app ---------------------------- */
const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 12 },
  })
);

function requireLogin(req, res, next) {
  if (req.session && req.session.loggedIn) return next();
  return res.redirect("/login");
}

app.get("/login", (req, res) => res.send(loginPage(req.query.error)));

app.post("/login", (req, res) => {
  const { username, password } = req.body;
  if (username === ADMIN_USER && password === ADMIN_PASS) {
    req.session.loggedIn = true;
    return res.redirect("/");
  }
  res.redirect("/login?error=1");
});

app.post("/logout", requireLogin, (req, res) => {
  req.session.destroy(() => res.redirect("/login"));
});

app.get("/", requireLogin, (req, res) => res.send(dashboardPage()));

app.post("/toggle", requireLogin, (req, res) => {
  state.botOn = !state.botOn;
  pushLog({ type: "info", message: `Bot turned ${state.botOn ? "ON" : "OFF"}.` });
  if (state.botOn) runScanCycle(); // kick off immediately instead of waiting for the next tick
  res.redirect("/");
});

// Polled by the dashboard page every 10s. Also a good keep-alive ping target
// for UptimeRobot — it's a cheap GET with no login required.
app.get("/status", (req, res) => {
  res.json({
    botOn: state.botOn,
    scanning: state.scanning,
    lastScanAt: state.lastScanAt,
    lastScanCount: state.lastScanCount,
    dryRun: DRY_RUN,
    interval: INTERVAL,
    scanEveryMinutes: SCAN_EVERY_MINUTES,
    log: state.log.slice(0, 50),
  });
});

/* ---------------------------- pages ---------------------------- */
function loginPage(error) {
  return `<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Bybit Scanner — Login</title>
<style>
body{font-family:system-ui,sans-serif;background:#0b0f14;color:#e6edf3;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
form{background:#161b22;padding:32px;border-radius:12px;width:280px}
input{width:100%;padding:10px;margin:8px 0;border-radius:6px;border:1px solid #30363d;background:#0d1117;color:#e6edf3;box-sizing:border-box}
button{width:100%;padding:10px;border-radius:6px;border:none;background:#238636;color:#fff;font-weight:600;cursor:pointer}
h2{margin-top:0} .err{color:#f85149;font-size:14px}
</style></head><body>
<form method="POST" action="/login">
  <h2>Bybit Scanner Login</h2>
  ${error ? '<p class="err">Wrong username or password.</p>' : ""}
  <input name="username" placeholder="Username" required>
  <input name="password" type="password" placeholder="Password" required>
  <button type="submit">Login</button>
</form>
</body></html>`;
}

function dashboardPage() {
  return `<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Bybit Scanner</title>
<style>
body{font-family:system-ui,sans-serif;background:#0b0f14;color:#e6edf3;margin:0;padding:16px}
.card{background:#161b22;border-radius:12px;padding:16px;margin-bottom:16px}
.row{display:flex;justify-content:space-between;align-items:center}
.badge{padding:4px 10px;border-radius:999px;font-size:12px;font-weight:700}
.on{background:#238636}.off{background:#484f58}
button{padding:10px 20px;border-radius:8px;border:none;font-weight:700;cursor:pointer}
.toggle-on{background:#da3633;color:#fff}.toggle-off{background:#238636;color:#fff}
.log{font-family:ui-monospace,monospace;font-size:12px;max-height:50vh;overflow-y:auto}
.log div{padding:6px 0;border-bottom:1px solid #21262d}
.muted{color:#8b949e;font-size:12px}
form.logout{display:inline}
</style></head><body>
<div class="card row">
  <div>
    <div>Bot status: <span id="badge" class="badge off">…</span></div>
    <div class="muted" id="meta">loading…</div>
  </div>
  <div style="text-align:right">
    <form method="POST" action="/toggle" id="toggleForm"><button id="toggleBtn" type="submit">…</button></form>
    <form class="logout" method="POST" action="/logout"><button type="submit" style="background:#30363d;color:#e6edf3;margin-top:8px">Logout</button></form>
  </div>
</div>
<div class="card">
  <h3 style="margin-top:0">Recent activity</h3>
  <div class="log" id="log">loading…</div>
</div>
<script>
async function refresh() {
  const r = await fetch('/status'); const s = await r.json();
  const badge = document.getElementById('badge');
  badge.textContent = s.botOn ? 'ON' : 'OFF';
  badge.className = 'badge ' + (s.botOn ? 'on' : 'off');
  document.getElementById('toggleBtn').textContent = s.botOn ? 'Turn OFF' : 'Turn ON';
  document.getElementById('toggleBtn').className = s.botOn ? 'toggle-on' : 'toggle-off';
  document.getElementById('meta').textContent =
    (s.dryRun ? 'DRY RUN — ' : 'LIVE — ') + 'interval ' + s.interval +
    ', scans every ' + s.scanEveryMinutes + 'm' +
    (s.lastScanAt ? ', last scan ' + new Date(s.lastScanAt).toLocaleTimeString() : '') +
    (s.scanning ? ' (scanning now…)' : '');
  document.getElementById('log').innerHTML = s.log.map(function(e) {
    return '<div><b>' + new Date(e.time).toLocaleTimeString() + '</b> [' + e.type + '] ' +
      (e.symbol ? e.symbol + ' — ' : '') + (e.message || '') + '</div>';
  }).join('') || '<div class="muted">No activity yet.</div>';
}
refresh();
setInterval(refresh, 10000);
</script>
</body></html>`;
}

app.listen(PORT, () => console.log(`Dashboard listening on :${PORT}`));
