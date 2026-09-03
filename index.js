require('dotenv').config();
const express = require('express');
const QRCode = require('qrcode');
const { Client, LocalAuth } = require('whatsapp-web.js');
const { analyzePair } = require('./analysis');

const ALLOWED_NUMBER = process.env.ALLOWED_NUMBER; // e.g. 923001234567
const PORT = process.env.PORT || 3000;

let latestQrDataUrl = null;
let isReady = false;

const app = express();

app.get('/qr', (req, res) => {
  if (isReady) {
    res.send('<h2>✅ Bot already connected. No QR needed.</h2>');
    return;
  }
  if (!latestQrDataUrl) {
    res.send('<h2>QR abhi generate nahi hua. 10-15 second baad refresh karo.</h2>');
    return;
  }
  res.send(`
    <html>
      <body style="text-align:center; font-family:sans-serif; padding-top:40px;">
        <h2>WhatsApp se QR scan karo</h2>
        <img src="${latestQrDataUrl}" style="width:300px; height:300px;" />
        <p>WhatsApp app kholo &gt; Linked Devices &gt; Link a device &gt; ye QR scan karo</p>
        <p>QR expire ho jaye to page refresh karo.</p>
      </body>
    </html>
  `);
});

app.listen(PORT, () => {
  console.log(`QR page live hai: apna Railway public URL + /qr par jao (e.g. https://<your-app>.up.railway.app/qr)`);
});

const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  },
  webVersionCache: {
    type: 'remote',
    remotePath:
      'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html',
  },
});

client.on('qr', async (qr) => {
  try {
    latestQrDataUrl = await QRCode.toDataURL(qr);
    console.log('Naya QR ready hai. Apne Railway public URL ke aage /qr lagao aur browser mein kholo.');
  } catch (err) {
    console.log('QR generate karne mein error:', err.message);
  }
});

client.on('ready', () => {
  isReady = true;
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

  // Optional: restrict to your own number only
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
