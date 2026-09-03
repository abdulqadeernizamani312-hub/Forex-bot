require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const { analyzePair } = require('./analysis');

const ALLOWED_NUMBER = process.env.ALLOWED_NUMBER; // e.g. 923001234567
const PAIRING_NUMBER = process.env.PAIRING_NUMBER; // your WhatsApp number, e.g. 923001234567 (no +, no spaces)

const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  },
  // Pin a known-stable WhatsApp Web version.
  // Fixes "Invariant Violation #6748" that breaks pairing codes on some
  // auto-fetched WhatsApp Web versions.
  webVersionCache: {
    type: 'remote',
    remotePath:
      'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.3000.1023537762-alpha.html',
  },
});

let pairingRequested = false;

client.on('qr', async (qr) => {
  if (!PAIRING_NUMBER) {
    console.log('PAIRING_NUMBER not set — cannot request a pairing code.');
    return;
  }
  if (pairingRequested) return; // only ask once per run
  pairingRequested = true;
  try {
    const code = await client.requestPairingCode(PAIRING_NUMBER);
    console.log('================================');
    console.log('WHATSAPP PAIRING CODE:', code);
    console.log('================================');
    console.log('WhatsApp app kholo > Linked Devices > Link with phone number > ye code enter karo.');
  } catch (err) {
    console.log('Pairing code error:', err.message);
    pairingRequested = false; // allow retry on next qr refresh
  }
});

client.on('ready', () => {
  console.log('✅ Bot is ready and connected to WhatsApp!');
});

client.on('auth_failure', (msg) => {
  console.log('❌ Auth failure:', msg);
});

client.on('disconnected', (reason) => {
  console.log('⚠️ Disconnected:', reason);
});

client.on('message', async (msg) => {
  const from = msg.from.replace('@c.us', '');

  if (ALLOWED_NUMBER && from !== ALLOWED_NUMBER) return;

  const text = msg.body.trim();

  if (text.toLowerCase() === '!help' || text.toLowerCase() === 'help') {
    await msg.reply(
      '*Forex Analysis Bot*\n\n' +
      'Commands:\n' +
      '!analyze EURUSD - get technical analysis for a pair\n' +
      '!analyze XAUUSD - gold vs USD\n\n' +
      'Supported shortcuts: EURUSD, GBPUSD, USDJPY, USDPKR, USDINR, AUDUSD, USDCAD, USDCHF, NZDUSD, EURGBP, XAUUSD'
    );
    return;
  }

  const match = text.match(/^!analyze\s+(\S+)/i);
  if (match) {
    const pair = match[1];
    try {
      await msg.reply('⏳ Fetching analysis for ' + pair.toUpperCase() + '...');
      const result = await analyzePair(pair);
      await msg.reply(result);
    } catch (err) {
      await msg.reply('❌ Error: ' + err.message + '\n\nCheck the pair name or try !help');
    }
  }
});

client.initialize();
