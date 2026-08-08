/**
 * telegram.js
 * Optional: sends a Telegram message whenever the bot places a trade,
 * or hits an error. Leave TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID unset
 * to disable — the bot will just log to the GitHub Actions console instead.
 *
 * Setup: message @BotFather on Telegram -> /newbot -> get token.
 * Get your chat id by messaging your new bot then visiting:
 * https://api.telegram.org/bot<TOKEN>/getUpdates
 */
async function notify(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  console.log(text);
  if (!token || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
    });
  } catch (e) {
    console.error("Telegram notify failed:", e.message);
  }
}

module.exports = { notify };
