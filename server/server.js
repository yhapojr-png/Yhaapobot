require('dotenv').config();
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');

const BOT_TOKEN = process.env.BOT_TOKEN;
const MINI_APP_URL = process.env.MINI_APP_URL; // e.g. https://yourusername.github.io/yhaapobot-app/
const PORT = process.env.PORT || 3000;

if (!BOT_TOKEN) {
  console.error('Missing BOT_TOKEN in environment variables. Set it before starting.');
  process.exit(1);
}
if (!MINI_APP_URL) {
  console.error('Missing MINI_APP_URL in environment variables. Set it before starting.');
  process.exit(1);
}

// ---------- Plan / add-on definitions (must match the mini app's ids) ----------
// Amounts are in Telegram Stars (integers, no decimals). Adjust freely.
const PLANS = {
  basic:   { name: 'Basic',   stars: 350 },
  pro:     { name: 'Pro',     stars: 700 },
  premium: { name: 'Premium', stars: 1400 },
};

const ADDONS = {
  storage: { name: 'Extra Storage',    stars: 200 },
  support: { name: 'Priority Support', stars: 300 },
};

const SUBSCRIPTION_PERIOD_SECONDS = 30 * 24 * 60 * 60; // 30 days — the only period Telegram currently allows

// ---------- Very simple local "database" (swap for a real DB before scaling) ----------
const DB_PATH = path.join(__dirname, 'subscribers.json');
function readDB() {
  try { return JSON.parse(fs.readFileSync(DB_PATH, 'utf8')); } catch { return {}; }
}
function writeDB(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

// ---------- Bot ----------
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, "Let's get you set up 🎟️\n\nTap below to choose a plan.", {
    reply_markup: {
      inline_keyboard: [[{ text: 'View Plans', web_app: { url: MINI_APP_URL } }]],
    },
  });
});

bot.onText(/\/help/, (msg) => {
  bot.sendMessage(msg.chat.id, 'Yhaapo gives you tiered membership access, billed monthly in Telegram Stars. Use /start to view plans or manage your subscription.');
});

// Mini app sends its selection back here via tg.sendData(...)
bot.on('message', async (msg) => {
  if (!msg.web_app_data) return;

  const chatId = msg.chat.id;
  let payload;
  try {
    payload = JSON.parse(msg.web_app_data.data);
  } catch (e) {
    return bot.sendMessage(chatId, "Something went wrong reading your selection — please try again.");
  }

  const plan = PLANS[payload.plan];
  if (!plan) {
    return bot.sendMessage(chatId, "That plan isn't recognized — please pick again from /start.");
  }

  const addonIds = Array.isArray(payload.addons) ? payload.addons : [];
  const addonLines = addonIds
    .filter((id) => ADDONS[id])
    .map((id) => ADDONS[id]);

  const totalStars = plan.stars + addonLines.reduce((sum, a) => sum + a.stars, 0);
  const descriptionParts = [plan.name, ...addonLines.map((a) => a.name)];

  try {
    await bot.sendInvoice(
      chatId,
      `Yhaapo — ${plan.name} membership`,
      `Monthly access: ${descriptionParts.join(' + ')}`,
      JSON.stringify({ plan: payload.plan, addons: addonIds }), // invoice payload, echoed back on payment
      '', // provider_token — must be empty string for Telegram Stars
      'XTR', // currency code for Telegram Stars
      [{ label: descriptionParts.join(' + '), amount: totalStars }], // exactly one price line for Stars
      {
        subscription_period: SUBSCRIPTION_PERIOD_SECONDS, // makes this a recurring monthly charge
      }
    );
  } catch (err) {
    console.error('sendInvoice failed:', err.response ? err.response.body : err);
    bot.sendMessage(chatId, "Couldn't create the payment — please try again in a moment.");
  }
});

// Confirm the order can actually be fulfilled before Telegram charges the user
bot.on('pre_checkout_query', async (query) => {
  await bot.answerPreCheckoutQuery(query.id, true);
});

// Payment succeeded — record it
bot.on('message', (msg) => {
  if (!msg.successful_payment) return;
  const chatId = msg.chat.id;
  const sp = msg.successful_payment;
  let payload = {};
  try { payload = JSON.parse(sp.invoice_payload); } catch {}

  const db = readDB();
  db[chatId] = {
    plan: payload.plan,
    addons: payload.addons || [],
    starsPaid: sp.total_amount,
    chargeId: sp.telegram_payment_charge_id,
    isFirstRecurring: !!sp.is_first_recurring,
    subscriptionExpirationDate: sp.subscription_expiration_date || null,
    updatedAt: new Date().toISOString(),
  };
  writeDB(db);

  bot.sendMessage(chatId, `You're in ✓ ${payload.plan ? PLANS[payload.plan]?.name : 'Plan'} is active. This renews automatically each month — cancel any time from your Telegram Stars settings.`);
});

// ---------- Minimal web server so free hosts see the service as "up" ----------
const app = express();
app.get('/', (req, res) => res.send('Yhaapobot is running.'));
app.listen(PORT, () => console.log(`Health check server listening on port ${PORT}`));

console.log('Yhaapobot polling for messages...');
