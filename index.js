require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const { analyzePair, quickSignal, predictAllDurations, fullHistoryAnalysis, isForexMarketLikelyClosed, fetchQuote, getKeyLevelsWithStats, backtestMethod, crossPairConfirmation, masterAnalysis } = require('./analysis');
const axios = require('axios');

const startTime = Date.now();

// ---- Persistent storage (Upstash Redis REST API) ----
// Free tier, no Volume needed — just a URL + token from upstash.com.
// If these env vars aren't set, the bot falls back to in-memory (resets on restart).
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const PERSISTENCE_ENABLED = Boolean(REDIS_URL && REDIS_TOKEN);

async function redisGet(key) {
  if (!PERSISTENCE_ENABLED) return null;
  try {
    const { data } = await axios.get(`${REDIS_URL}/get/${key}`, {
      headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
    });
    return data.result ? JSON.parse(data.result) : null;
  } catch (e) {
    console.log('⚠️ Redis GET failed:', e.message);
    return null;
  }
}

async function redisSet(key, value) {
  if (!PERSISTENCE_ENABLED) return;
  try {
    await axios.post(`${REDIS_URL}/set/${key}`, JSON.stringify(value), {
      headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'text/plain' },
    });
  } catch (e) {
    console.log('⚠️ Redis SET failed:', e.message);
  }
}

// In-memory cache of the prediction log — loaded from Redis at startup (if
// configured), kept in sync on every mutation. Falls back to pure in-memory
// (resets on restart) if Redis env vars aren't set.
let predictionLog = [];
(async () => {
  if (PERSISTENCE_ENABLED) {
    const saved = await redisGet('prediction_log');
    if (saved) predictionLog = saved;
    console.log(`📦 Persistent storage ON — loaded ${predictionLog.length} past predictions.`);
  } else {
    console.log('📦 Persistent storage OFF — UPSTASH_REDIS_REST_URL/TOKEN not set. Track record will reset on restart.');
  }
})();

async function savePredictionLog() {
  if (predictionLog.length > 5000) predictionLog = predictionLog.slice(-5000);
  await redisSet('prediction_log', predictionLog);
}

// Chat to send proactive level-hit alerts to — captured from the first
// allowed message we receive (avoids @c.us vs @lid addressing issues).
let notifyChatId = null;

// Levels the bot is actively watching. Resets on restart.
const watchList = [];

const ALLOWED_NUMBER = process.env.ALLOWED_NUMBER; // e.g. 923001234567
const PAIRING_NUMBER = process.env.PAIRING_NUMBER; // your WhatsApp number, e.g. 923001234567 (no +, no spaces)

// In-memory track record of !signal predictions. Resets on restart (no
// persistent storage set up) but still useful for "since last restart" stats.
// (persistent predictionLog declared above near Redis helpers)

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

let hasBeenReady = false;

client.on('ready', () => {
  hasBeenReady = true;
  console.log('✅ Bot is ready and connected to WhatsApp!');
});

client.on('auth_failure', (msg) => {
  console.log('❌ Auth failure:', msg);
});

client.on('disconnected', (reason) => {
  console.log('⚠️ Disconnected:', reason);
  if (hasBeenReady) {
    // Only force-restart if we had a working connection that then broke.
    // During initial pairing, disconnect-like events are normal — don't kill
    // the process before the user has a chance to enter the pairing code.
    process.exit(1);
  }
});

// Watchdog: whatsapp-web.js can silently lose its connection without ever
// firing the 'disconnected' event. Every 3 minutes, actively ask the client
// for its real state; if it's not CONNECTED, restart the process — but ONLY
// once we've successfully connected at least once (otherwise this would
// kill the process mid-pairing, before the user can enter the code).
setInterval(async () => {
  if (!hasBeenReady) return; // still waiting on initial pairing — don't interfere
  try {
    const state = await Promise.race([
      client.getState(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('getState timed out')), 20000)),
    ]);
    console.log('🩺 Watchdog check — client state:', state);
    if (state !== 'CONNECTED') {
      console.log('⚠️ Watchdog: state is not CONNECTED, restarting process...');
      process.exit(1);
    }
  } catch (err) {
    console.log('⚠️ Watchdog: health check failed (' + err.message + '), restarting process...');
    process.exit(1);
  }
}, 3 * 60 * 1000);

// Every 5 minutes, check any !signal predictions that have "matured" (their
// forward window has passed) and score them against the real market price.
setInterval(async () => {
  const now = Date.now();
  const due = predictionLog.filter(p => !p.evaluated && now - p.createdAt >= p.forwardMinutes * 60 * 1000);
  if (due.length === 0) return;

  const symbols = [...new Set(due.map(p => p.symbol))];
  const prices = {};
  for (const sym of symbols) {
    try {
      const q = await fetchQuote(sym);
      prices[sym] = parseFloat(q.close);
    } catch (e) {
      console.log('⚠️ Accuracy check: could not fetch price for', sym, e.message);
    }
  }

  let anyEvaluated = false;
  for (const p of due) {
    if (prices[p.symbol] === undefined) continue;
    p.evaluated = true;
    p.exitPrice = prices[p.symbol];
    p.correct = p.direction === 'UP' ? prices[p.symbol] > p.entryPrice : prices[p.symbol] < p.entryPrice;
    anyEvaluated = true;
  }
  if (anyEvaluated) await savePredictionLog();
}, 5 * 60 * 1000);

// Every 2 minutes, check watched price levels. If price is close to a
// watched level and we haven't alerted on it recently, send a proactive
// WhatsApp message with the real historical bounce/break stat for that level.
const ALERT_COOLDOWN_MS = 30 * 60 * 1000; // don't spam the same level more than once per 30 min
const TOLERANCE_PCT = 0.08;

setInterval(async () => {
  if (watchList.length === 0 || !notifyChatId) return;

  const symbols = [...new Set(watchList.map(w => w.symbol))];
  const prices = {};
  for (const sym of symbols) {
    try {
      const q = await fetchQuote(sym);
      prices[sym] = parseFloat(q.close);
    } catch (e) {
      console.log('⚠️ Watchlist: could not fetch price for', sym, e.message);
    }
  }

  const now = Date.now();
  for (const w of watchList) {
    const price = prices[w.symbol];
    if (price === undefined) continue;
    const distPct = (Math.abs(price - w.level) / w.level) * 100;
    if (distPct > TOLERANCE_PCT) continue;
    if (w.lastAlertAt && now - w.lastAlertAt < ALERT_COOLDOWN_MS) continue;

    w.lastAlertAt = now;
    const statLine = w.stats
      ? `Historically, after touching this zone, price went UP ${w.stats.upPct}% / DOWN ${w.stats.downPct}% (n=${w.stats.sampleSize}, ${w.stats.confidence}).`
      : `Not enough historical data on this exact level to give a reliable stat.`;

    try {
      await client.sendMessage(
        notifyChatId,
        `🔔 *Price Alert: ${w.symbol}*\n\n` +
        `Price ${price} is near your watched ${w.type} level (${w.level}).\n\n` +
        `📊 ${statLine}\n\n` +
        `⚠️ Ye history ka statistic hai, guarantee nahi. Apna paisa soch samajh kar lagayein.`
      );
    } catch (e) {
      console.log('⚠️ Could not send watch alert:', e.message);
    }
  }
}, 2 * 60 * 1000);

client.on('message', async (msg) => {
  let from = msg.from.replace('@c.us', '').replace('@lid', '');
  const rawLid = msg.from.endsWith('@lid') ? msg.from.replace('@lid', '') : null;

  if (msg.from === 'status@broadcast') return;

  console.log('📩 Message received from:', from, '(raw:', msg.from, ') | ALLOWED_NUMBER is:', ALLOWED_NUMBER, '| text:', msg.body);

  const isAllowed = !ALLOWED_NUMBER || from === ALLOWED_NUMBER || rawLid === ALLOWED_NUMBER;
  if (!isAllowed) {
    console.log('   -> Ignored (number/LID does not match ALLOWED_NUMBER)');
    return;
  }

  const text = msg.body.trim();

  // Capture the chat to use for proactive watch alerts.
  notifyChatId = msg.from;

  if (text.toLowerCase() === '!help' || text.toLowerCase() === 'help') {
    await msg.reply(
      '*Forex Analysis Bot*\n\n' +
      'Commands:\n' +
      '!status - bot online hai ya nahi, check karo\n' +
      '!analyze EURUSD - detailed multi-timeframe analysis (hours/days ke liye)\n' +
      '!full EURUSD - poori history, har timeframe pe pattern analysis\n' +
      '!signal EURUSD - quick UP/DOWN guess (5-min, short expiry ke liye)\n' +
      '!predict EURUSD - 1 se 60 minute tak har duration ka history-based stat\n' +
      '!accuracy - bot ke pichle !signal calls kitne sahi nikle (since last restart)\n' +
      '!watch EURUSD - key support/resistance level watch karo, auto-alert milega\n' +
      '!watchlist - abhi kya watch ho raha hai dekho\n' +
      '!unwatch EURUSD - watch hatao\n' +
      '!backtest EURUSD - method ka real out-of-sample historical accuracy dekho\n' +
      '!master EURUSD - sabse detailed analysis (5 timeframes + cross-pair, ~7-8 API calls)\n\n' +
      'Supported shortcuts: EURUSD, GBPUSD, USDJPY, USDPKR, USDINR, AUDUSD, USDCAD, USDCHF, NZDUSD, EURGBP, XAUUSD'
    );
    return;
  }

  const masterMatch = text.match(/^!master\s+(\S+)/i);
  if (masterMatch) {
    const pair = masterMatch[1];
    try {
      await msg.reply('⏳ Master analysis chal raha hai ' + pair.toUpperCase() + '... (5 timeframes + cross-pair, thoda time lagega)');
      const result = await masterAnalysis(pair);
      await msg.reply(result);
    } catch (err) {
      await msg.reply('❌ Error: ' + err.message + '\n\nCheck the pair name or try !help');
    }
    return;
  }

  const backtestMatch = text.match(/^!backtest\s+(\S+)/i);
  if (backtestMatch) {
    const pair = backtestMatch[1];
    try {
      await msg.reply('⏳ Backtest chal raha hai ' + pair.toUpperCase() + '... (thoda time lagega)');
      const result = await backtestMethod(pair);
      await msg.reply(result);
    } catch (err) {
      await msg.reply('❌ Error: ' + err.message + '\n\nCheck the pair name or try !help');
    }
    return;
  }

  if (text.toLowerCase() === '!watchlist') {
    if (watchList.length === 0) {
      await msg.reply('Abhi koi pair watch nahi ho raha. !watch EURUSD jaisa command bhejo.');
      return;
    }
    const lines = watchList.map(w => `${w.symbol} — ${w.type} @ ${w.level}${w.stats ? ` (UP ${w.stats.upPct}%/DOWN ${w.stats.downPct}%, n=${w.stats.sampleSize})` : ' (not enough history)'}`);
    await msg.reply('*Currently watching:*\n' + lines.join('\n'));
    return;
  }

  const unwatchMatch = text.match(/^!unwatch\s+(\S+)/i);
  if (unwatchMatch) {
    const { normalizePair } = require('./analysis');
    const symbol = normalizePair(unwatchMatch[1]);
    const before = watchList.length;
    for (let i = watchList.length - 1; i >= 0; i--) {
      if (watchList[i].symbol === symbol) watchList.splice(i, 1);
    }
    await msg.reply(before > watchList.length ? `${symbol} ka watch hata diya.` : `${symbol} watch mein nahi tha.`);
    return;
  }

  const watchMatch = text.match(/^!watch\s+(\S+)/i);
  if (watchMatch) {
    const pair = watchMatch[1];
    try {
      await msg.reply('⏳ Key levels detect ho rahe hain ' + pair.toUpperCase() + '...');
      const info = await getKeyLevelsWithStats(pair);

      // remove any existing watch for this symbol before adding fresh ones
      for (let i = watchList.length - 1; i >= 0; i--) {
        if (watchList[i].symbol === info.symbol) watchList.splice(i, 1);
      }
      watchList.push({ symbol: info.symbol, level: info.resistance, type: 'resistance', stats: info.resistanceStats, lastAlertAt: null });
      watchList.push({ symbol: info.symbol, level: info.support, type: 'support', stats: info.supportStats, lastAlertAt: null });

      const resLine = info.resistanceStats
        ? `UP ${info.resistanceStats.upPct}% / DOWN ${info.resistanceStats.downPct}% (n=${info.resistanceStats.sampleSize}, ${info.resistanceStats.confidence})`
        : 'not enough historical touches yet';
      const supLine = info.supportStats
        ? `UP ${info.supportStats.upPct}% / DOWN ${info.supportStats.downPct}% (n=${info.supportStats.sampleSize}, ${info.supportStats.confidence})`
        : 'not enough historical touches yet';

      await msg.reply(
        `*${info.symbol} — Now Watching*\n\n` +
        `Price: ${info.price}\n\n` +
        `Resistance: ${info.resistance}\n  History: ${resLine}\n\n` +
        `Support: ${info.support}\n  History: ${supLine}\n\n` +
        `Jab bhi price in levels ke paas (±${TOLERANCE_PCT}%) aayega, bot khud message bhejega (max har 30 min mein ek baar per level).\n\n` +
        `⚠️ Ye history ka statistic hai, guarantee nahi.`
      );
    } catch (err) {
      await msg.reply('❌ Error: ' + err.message + '\n\nCheck the pair name or try !help');
    }
    return;
  }

  if (text.toLowerCase() === '!status') {
    const uptimeMin = Math.floor((Date.now() - startTime) / 60000);
    const marketNote = isForexMarketLikelyClosed() ? '\n⚠️ Forex market abhi likely CLOSED hai (weekend).' : '';
    await msg.reply(
      '✅ Bot online hai aur WhatsApp se connected hai.\n' +
      `Uptime: ${uptimeMin} minute` + marketNote + '\n\n' +
      'Commands ke liye !help bhejo.'
    );
    return;
  }

  if (text.toLowerCase() === '!accuracy') {
    const evaluated = predictionLog.filter(p => p.evaluated);
    const pending = predictionLog.filter(p => !p.evaluated);
    const persistenceNote = PERSISTENCE_ENABLED
      ? 'Ye permanent record hai — restart hone par bhi safe rahega.'
      : 'Note: Permanent storage set up nahi hai (UPSTASH_REDIS_REST_URL/TOKEN missing) — restart hone par ye data reset ho jayega.';
    if (evaluated.length === 0) {
      await msg.reply(
        `Abhi tak koi !signal prediction matured nahi hui (evaluate hone mein 15 minute lagte hain).\n` +
        `Pending: ${pending.length}\n\n${persistenceNote}`
      );
      return;
    }
    const correct = evaluated.filter(p => p.correct).length;
    const pct = Math.round((correct / evaluated.length) * 100);
    await msg.reply(
      `*Bot's Track Record*\n\n` +
      `${correct}/${evaluated.length} correct (${pct}%)\n` +
      `Pending evaluation: ${pending.length}\n\n${persistenceNote}`
    );
    return;
  }

  const fullMatch = text.match(/^!full\s+(\S+)/i);
  if (fullMatch) {
    const pair = fullMatch[1];
    try {
      await msg.reply('⏳ Poori history fetch aur analyze ho rahi hai ' + pair.toUpperCase() + '... (thoda time lagega)');
      const result = await fullHistoryAnalysis(pair);
      await msg.reply(result);
    } catch (err) {
      await msg.reply('❌ Error: ' + err.message + '\n\nCheck the pair name or try !help');
    }
    return;
  }

  const predictMatch = text.match(/^!predict\s+(\S+)/i);
  if (predictMatch) {
    const pair = predictMatch[1];
    try {
      await msg.reply('⏳ Multi-duration prediction fetch ho raha hai ' + pair.toUpperCase() + '... (thoda time lagega)');
      const result = await predictAllDurations(pair);
      await msg.reply(result);
    } catch (err) {
      await msg.reply('❌ Error: ' + err.message + '\n\nCheck the pair name or try !help');
    }
    return;
  }

  const signalMatch = text.match(/^!signal\s+(\S+)/i);
  if (signalMatch) {
    const pair = signalMatch[1];
    try {
      await msg.reply('⏳ Quick signal fetch ho raha hai ' + pair.toUpperCase() + '...');
      const result = await quickSignal(pair);
      let fullMessage = result.message;

      try {
        const crossInfo = await crossPairConfirmation(result.meta.symbol);
        if (crossInfo && crossInfo.length) {
          const crossLines = crossInfo.map(c => `${c.pair}: ${c.changePct > 0 ? '+' : ''}${c.changePct}% today`);
          fullMessage += `\n\n🔗 *Related pairs (context):*\n${crossLines.join('\n')}`;
        }
      } catch (e) {
        // cross-pair check is best-effort; ignore failures silently
      }

      await msg.reply(fullMessage);
      if (result.meta.direction !== 'UNCLEAR') {
        predictionLog.push({
          symbol: result.meta.symbol,
          entryPrice: result.meta.price,
          direction: result.meta.direction,
          forwardMinutes: result.meta.forwardMinutes,
          createdAt: Date.now(),
          evaluated: false,
        });
        await savePredictionLog();
      }
    } catch (err) {
      await msg.reply('❌ Error: ' + err.message + '\n\nCheck the pair name or try !help');
    }
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
