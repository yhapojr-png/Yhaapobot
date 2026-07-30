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
  prem
