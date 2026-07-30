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
      keyboard: [[{ text: 'View Plans', web_app: { url: MINI_APP_URL } }]],
      resize_keyboard: true,
    },
  });
});

bot.onText(/\/help/, (msg) => {
  bot.sendMessage(msg.chat.id, 'Yhaapo gives you tiered membership access, billed monthly in Telegram Stars. Use /start to view plans or manage your subscription.');
});

// Log every incoming update so we can see what Telegram is actually sending us
bot.on('message', (msg) => {
  console.log('Incoming message:', JSON.stringify({
    chat_id: msg.chat.id,
    text: msg.text,
    has_web_app_data: !!msg.web_app_data,
    has_successful_payment: !!msg.successful_payment,
  }));
});

// Mini app sends its selection back here via tg.sendData(...)
bot.on('message', async (msg) => {
  if (!msg.web_app_data) return;
  console.log('web_app_data received:', msg.web_app_data.data);

  const chatId = msg.chat.id;
  let payload;
  try {
    payload = JSON.parse(msg.web_app_data.data);
  } catch (e) {
    console.log('Failed to parse web_app_data payload:', e.message);
    return bot.sendMessage(chatId, "Something went wrong reading your selection — please try again.");
  }

  const plan = PLANS[payload.plan];
  if (!plan) {
    console.log('Unrecognized plan id:', payload.plan);
    return bot.sendMessage(chatId, "That plan isn't recognized — please pick again from /start.");
  }

  const addonIds = Array.isArray(payload.addons) ? payload.addons : [];
  const addonLines = addonIds
    .filter((id) => ADDONS[id])
    .map((id) => ADDONS[id]);

  const totalStars = plan.stars + addonLines.reduce((sum, a) => sum + a.stars, 0);
  const descriptionParts = [plan.name, ...addonLines.map((a) => a.name)];

  console.log(`Sending invoice: plan=${payload.plan}, addons=${JSON.stringify(addonIds)}, totalStars=${totalStars}`);

  console.log(`Creating invoice link: plan=${payload.plan}, addons=${JSON.stringify(addonIds)}, totalStars=${totalStars}`);

  try {
    // subscription_period is only supported by createInvoiceLink, not sendInvoice —
    // so for recurring Stars payments we build a link first, then send it as a Pay button.
    const invoiceUrl = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/createInvoiceLink`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: `Yhaapo — ${plan.name} membership`,
        description: `Monthly access: ${descriptionParts.join(' + ')}`,
        payload: JSON.stringify({ plan: payload.plan, addons: addonIds }),
        provider_token: '', // empty for Telegram Stars
        currency: 'XTR',
        prices: [{ label: descriptionParts.join(' + '), amount: totalStars }],
        subscription_period: SUBSCRIPTION_PERIOD_SECONDS,
      }),
    }).then((r) => r.json());

    if (!invoiceUrl.ok) {
      throw new Error(JSON.stringify(invoiceUrl));
    }

    await bot.sendMessage(chatId, `Ready to subscribe: ${plan.name}${addonLines.length ? ' + ' + addonLines.map((a) => a.name).join(' + ') : ''} — ${totalStars} Stars/month`, {
      reply_markup: {
        inline_keyboard: [[{ text: `Pay ${totalStars} ⭐️/month`, url: invoiceUrl.result }]],
      },
    });
    console.log('Invoice link sent for chat', chatId);
  } catch (err) {
    console.error('createInvoiceLink failed:', err.message);
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
