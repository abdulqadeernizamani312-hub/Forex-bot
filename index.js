require('dotenv').config();
const express = require('express');
const QRCode = require('qrcode');
const { Client, LocalAuth } = require('whatsapp-web.js');
const { analyzePair } = require('./analysis');

const ALLOWED_NUMBER = process.env.ALLOWED_NUMBER; // e.g. 923001234567
const PORT = process.env.PORT || 3000;

let currentQR = null;
let botStatus = 'starting'; // starting | qr | ready

const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  },
});

client.on('qr', (qr) => {
  currentQR = qr;
  botStatus = 'qr';
  console.log('QR code updated — open the web URL to scan it.');
});

client.on('ready', () => {
  botStatus = 'ready';
  currentQR = null;
  console.log('✅ Bot is ready and connected to WhatsApp!');
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

// ---- Tiny web server just to show the QR code ----
const app = express();

app.get('/', async (req, res) => {
  if (botStatus === 'ready') {
    return res.send('<h2>✅ Bot is connected and running!</h2><p>You can close this page.</p>');
  }
  if (botStatus === 'qr' && currentQR) {
    const dataUrl = await QRCode.toDataURL(currentQR);
    return res.send(`
      <html>
        <body style="text-align:center; font-family: sans-serif; padding-top: 40px;">
          <h2>Scan this QR code with WhatsApp</h2>
          <p>WhatsApp &gt; Settings &gt; Linked Devices &gt; Link a Device</p>
          <img src="${dataUrl}" style="width:300px;height:300px;" />
          <p><small>Refresh this page if the code expires.</small></p>
        </body>
      </html>
    `);
  }
  return res.send('<h2>⏳ Starting up... refresh in a few seconds.</h2>');
});

app.listen(PORT, () => {
  console.log(`Web server running on port ${PORT}`);
});
