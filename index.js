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
  // Pin a known-stable WhatsApp Web version — newer/alpha versions
  // break pairing codes with an internal "Evaluation failed" error.
  webVersionCache: {
    type: 'remote',
    remotePath:
      'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html',
  },
});

let pairingRequested = false;
let pairingAttempts = 0;
const MAX_ATTEMPTS = 2; // kam rakha hai taake dobara rate-limit na lage

client.on('qr', async () => {
  if (!PAIRING_NUMBER) {
    console.log('PAIRING_NUMBER env variable set nahi hai. Railway Variables mein PAIRING_NUMBER add karo (e.g. 923001234567).');
    return;
  }
  if (pairingRequested) return;
  if (pairingAttempts >= MAX_ATTEMPTS) {
    console.log('❌ Max pairing attempts reached is run mein. Agar phir bhi rate-limit error aaye, kai ghante wait karke dobara try karna.');
    return;
  }
  pairingRequested = true;
  pairingAttempts++;
  try {
    const code = await client.requestPairingCode(PAIRING_NUMBER);
    console.log('================================');
    console.log('WHATSAPP PAIRING CODE:', code);
    console.log('================================');
    console.log('WhatsApp app kholo > Linked Devices > Link with phone number > ye code TURANT (30-60 sec ke andar) enter karo.');
  } catch (err) {
    console.log('Pairing code error (attempt ' + pairingAttempts + '/' + MAX_ATTEMPTS + ')');
    console.log('  name:', err && err.name);
    console.log('  message:', err && err.message);
    console.log('  string:', String(err));
    setTimeout(() => {
      pairingRequested = false;
    }, 15000);
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

  console.log('📩 Message received from:', from, '| ALLOWED_NUMBER is:', ALLOWED_NUMBER, '| text:', msg.body);

  // Optional: restrict to your own number only
  if (ALLOWED_NUMBER && from !== ALLOWED_NUMBER) {
    console.log('   -> Ignored (number does not match ALLOWED_NUMBER)');
    return;
  }

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
