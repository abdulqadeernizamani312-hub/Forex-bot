const axios = require('axios');

const BASE_URL = 'https://api.twelvedata.com';
const API_KEY = process.env.TWELVE_DATA_API_KEY;

const PAIR_ALIASES = {
  eurusd: 'EUR/USD',
  gbpusd: 'GBP/USD',
  usdjpy: 'USD/JPY',
  usdpkr: 'USD/PKR',
  usdinr: 'USD/INR',
  audusd: 'AUD/USD',
  usdcad: 'USD/CAD',
  usdchf: 'USD/CHF',
  nzdusd: 'NZD/USD',
  eurgbp: 'EUR/GBP',
  xauusd: 'XAU/USD',
};

function normalizePair(input) {
  const clean = input.trim().toLowerCase().replace(/[\/\s]/g, '');
  if (PAIR_ALIASES[clean]) return PAIR_ALIASES[clean];
  if (/^[a-z]{6}$/.test(clean)) {
    return `${clean.slice(0, 3).toUpperCase()}/${clean.slice(3).toUpperCase()}`;
  }
  return input.toUpperCase();
}

async function apiGet(path, params) {
  const { data } = await axios.get(`${BASE_URL}/${path}`, {
    params: { ...params, apikey: API_KEY },
  });
  if (data.code && data.code !== 200) throw new Error(data.message || `Failed: ${path}`);
  return data;
}

async function fetchQuote(symbol) {
  return apiGet('quote', { symbol });
}

// candles come back newest-first from Twelve Data
async function fetchCandles(symbol, interval, outputsize = 60) {
  const data = await apiGet('time_series', { symbol, interval, outputsize });
  return data.values.map(v => ({
    time: v.datetime,
    open: parseFloat(v.open),
    high: parseFloat(v.high),
    low: parseFloat(v.low),
    close: parseFloat(v.close),
  }));
}

// ---- Locally-computed indicators (no extra API calls) ----

// Simple Moving Average over the most recent `period` closes.
// candles[0] is the newest candle.
function sma(candles, period) {
  const closes = candles.slice(0, period).map(c => c.close);
  return closes.reduce((a, b) => a + b, 0) / closes.length;
}

// Standard RSI (Wilder's smoothing), computed oldest -> newest.
function rsi(candles, period = 14) {
  const chron = [...candles].reverse(); // oldest first
  if (chron.length < period + 1) return 50; // not enough data, neutral fallback

  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = chron[i].close - chron[i - 1].close;
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period + 1; i < chron.length; i++) {
    const diff = chron[i].close - chron[i - 1].close;
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

// Average True Range (simple average, period candles).
function atr(candles, period = 14) {
  const chron = [...candles].reverse(); // oldest first
  if (chron.length < period + 1) return 0;

  const trueRanges = [];
  for (let i = 1; i < chron.length; i++) {
    const cur = chron[i];
    const prev = chron[i - 1];
    const tr = Math.max(
      cur.high - cur.low,
      Math.abs(cur.high - prev.close),
      Math.abs(cur.low - prev.close)
    );
    trueRanges.push(tr);
  }
  const recent = trueRanges.slice(-period);
  return recent.reduce((a, b) => a + b, 0) / recent.length;
}

// ---- Rolling series versions (value at every point in history, not just latest) ----
// These let us look back through history and ask "what was RSI/trend at each
// past candle" so we can find similar past setups.

function rsiSeries(closesChron, period = 14) {
  const out = new Array(closesChron.length).fill(null);
  if (closesChron.length < period + 1) return out;

  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closesChron[i] - closesChron[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  for (let i = period + 1; i < closesChron.length; i++) {
    const diff = closesChron[i] - closesChron[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

function smaSeries(closesChron, period) {
  const out = new Array(closesChron.length).fill(null);
  for (let i = period - 1; i < closesChron.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += closesChron[j];
    out[i] = sum / period;
  }
  return out;
}

// Looks through history for past moments where RSI + short/long-average
// momentum matched the current setup, and reports how often price ended up
// higher vs lower a few candles later. This is an actual data-backed
// statistic (from this pair's real price history), not a guess.
function historicalPatternStats(candlesNewestFirst, { period = 14, fastP = 5, slowP = 20, forwardSteps = 3, rsiBucketSize = 10 } = {}) {
  const chron = [...candlesNewestFirst].reverse().map(c => c.close); // oldest -> newest
  const n = chron.length;
  const rsiArr = rsiSeries(chron, period);
  const fastArr = smaSeries(chron, fastP);
  const slowArr = smaSeries(chron, slowP);

  const currentIdx = n - 1;
  const currentRSI = rsiArr[currentIdx];
  const currentFast = fastArr[currentIdx];
  const currentSlow = slowArr[currentIdx];
  if (currentRSI === null || currentFast === null || currentSlow === null) return null;

  const currentBucket = Math.floor(currentRSI / rsiBucketSize);
  const currentTrendUp = currentFast > currentSlow;

  let up = 0;
  let down = 0;
  const startIdx = Math.max(period, fastP, slowP);
  const endIdx = n - 1 - forwardSteps; // need forward data to check outcome

  for (let i = startIdx; i < endIdx; i++) {
    if (rsiArr[i] === null || fastArr[i] === null || slowArr[i] === null) continue;
    const bucket = Math.floor(rsiArr[i] / rsiBucketSize);
    const trendUp = fastArr[i] > slowArr[i];
    if (bucket === currentBucket && trendUp === currentTrendUp) {
      if (chron[i + forwardSteps] > chron[i]) up++;
      else down++;
    }
  }

  const total = up + down;
  if (total < 8) return null; // not enough similar historical setups to trust

  return {
    upPct: Math.round((up / total) * 100),
    downPct: Math.round((down / total) * 100),
    sampleSize: total,
    forwardSteps,
  };
}

// Full-history version: pulls the maximum available history for EVERY
// timeframe (1h, 4h, 1day) and runs the historical pattern-match on each —
// not just current trend/RSI, but "in this pair's whole available history,
// what usually happened next from a setup like this, on this timeframe."
async function fullHistoryAnalysis(rawInput) {
  const symbol = normalizePair(rawInput);

  // Still only 3 API calls total (1 per timeframe) — Twelve Data charges per
  // call, not per outputsize, so we ask for the max history each time.
  const [candles1h, candles4h, candles1d] = await Promise.all([
    fetchCandles(symbol, '1h', 5000),
    fetchCandles(symbol, '4h', 5000),
    fetchCandles(symbol, '1day', 5000),
  ]);

  const price = candles1h[0].close;

  const timeframes = [
    { label: '1 Hour', candles: candles1h, forwardSteps: 4, forwardLabel: '~4 hours' },
    { label: '4 Hour', candles: candles4h, forwardSteps: 3, forwardLabel: '~12 hours' },
    { label: 'Daily', candles: candles1d, forwardSteps: 3, forwardLabel: '~3 days' },
  ];

  const lines = [
    `*${symbol} — Full History Analysis*`,
    ``,
    `Price: ${price}`,
    ``,
    `Har timeframe ki poori available history se pattern nikala gaya hai — jab bhi is pair mein abhi jaisa RSI+momentum setup pehle bana tha, uske baad price kis taraf gaya.`,
    ``,
  ];

  let bullScore = 0;
  let bearScore = 0;
  const summaryReasons = [];

  for (const tf of timeframes) {
    const rsiVal = rsi(tf.candles, 14);
    const trend = trendFromCandles(tf.candles);
    const pattern = historicalPatternStats(tf.candles, { forwardSteps: tf.forwardSteps });

    lines.push(`*${tf.label} timeframe:*`);
    lines.push(`  Trend: ${trend} | RSI: ${rsiVal.toFixed(1)} — ${interpretRSI(rsiVal)}`);
    if (pattern) {
      lines.push(`  History: ${pattern.sampleSize} similar past setups → UP ${pattern.upPct}% / DOWN ${pattern.downPct}% over next ${tf.forwardLabel}`);
      if (pattern.upPct > pattern.downPct) { bullScore++; summaryReasons.push(`${tf.label}: history leans UP (${pattern.upPct}%)`); }
      else if (pattern.downPct > pattern.upPct) { bearScore++; summaryReasons.push(`${tf.label}: history leans DOWN (${pattern.downPct}%)`); }
    } else {
      lines.push(`  History: not enough similar past setups found on this timeframe yet`);
    }
    lines.push(``);
  }

  let overall;
  if (bullScore > bearScore) overall = `Overall lean: BUY (${bullScore}/${bullScore + bearScore} timeframes agree)`;
  else if (bearScore > bullScore) overall = `Overall lean: SELL (${bearScore}/${bullScore + bearScore} timeframes agree)`;
  else overall = `Overall lean: NO CLEAR AGREEMENT across timeframes`;

  lines.push(`*${overall}*`);
  if (summaryReasons.length) {
    lines.push(...summaryReasons.map(r => `• ${r}`));
  }

  lines.push(
    ``,
    `⚠️ *Zaroori warning:* Ye poori history ka statistic hai, lekin history repeat hone ki guarantee kabhi nahi hoti. Bade timeframes (4H, Daily) ka lean thoda zyada meaningful hota hai chhote (1H) se, lekin risk hamesha rehta hai. Stop-loss zaroor use karein.`
  );

  return lines.join('\n');
}

function trendFromCandles(candles) {
  const sma20 = sma(candles, 20);
  const sma50 = sma(candles, Math.min(50, candles.length));
  return sma20 > sma50 ? 'UP' : 'DOWN';
}

function findSupportResistance(candles) {
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
  const resistance = Math.max(...highs);
  const support = Math.min(...lows);
  return { support, resistance };
}

function detectStructure(candles) {
  const recent = candles.slice(0, 10);
  const highs = recent.map(c => c.high);
  const lows = recent.map(c => c.low);
  const higherHighs = highs[0] > highs[highs.length - 1];
  const higherLows = lows[0] > lows[lows.length - 1];

  if (higherHighs && higherLows) return 'Higher highs & higher lows — bullish structure';
  if (!higherHighs && !higherLows) return 'Lower highs & lower lows — bearish structure';
  return 'Mixed / ranging structure — no clear direction';
}

function interpretRSI(r) {
  if (r >= 70) return 'Overbought (stretched, watch for pullback)';
  if (r <= 30) return 'Oversold (stretched, watch for bounce)';
  return 'Neutral';
}

function buildBias({ trend1h, trend4h, trend1d, structure, rsi1h }) {
  const reasons = [];
  let bullScore = 0;
  let bearScore = 0;

  if (trend1h === 'UP') { bullScore++; reasons.push('1H trend is UP'); }
  else { bearScore++; reasons.push('1H trend is DOWN'); }

  if (trend4h === 'UP') { bullScore++; reasons.push('4H trend is UP'); }
  else { bearScore++; reasons.push('4H trend is DOWN'); }

  if (trend1d === 'UP') { bullScore++; reasons.push('Daily trend is UP'); }
  else { bearScore++; reasons.push('Daily trend is DOWN'); }

  if (structure.includes('bullish')) { bullScore++; reasons.push('Recent structure is bullish (higher highs/lows)'); }
  else if (structure.includes('bearish')) { bearScore++; reasons.push('Recent structure is bearish (lower highs/lows)'); }
  else { reasons.push('Structure is mixed/ranging — no clear edge here'); }

  if (rsi1h >= 70) { bearScore += 0.5; reasons.push('RSI overbought — pullback risk'); }
  else if (rsi1h <= 30) { bullScore += 0.5; reasons.push('RSI oversold — bounce possible'); }

  let bias, confidence;
  const total = bullScore + bearScore;
  if (bullScore > bearScore) {
    bias = 'BUY lean';
    confidence = `${bullScore}/${total.toFixed(1)} signals lean up`;
  } else if (bearScore > bullScore) {
    bias = 'SELL lean';
    confidence = `${bearScore}/${total.toFixed(1)} signals lean down`;
  } else {
    bias = 'NO CLEAR LEAN — signals are split';
    confidence = 'mixed signals';
  }

  return { bias, confidence, reasons };
}

// For a single duration (in minutes, using 1-min candles so 1 candle = 1 min),
// count how often price went up vs down `duration` minutes after each past
// point that had a similar RSI + momentum setup to right now.
function statsForDuration(chron, rsiArr, fastArr, slowArr, currentBucket, currentTrendUp, duration, rsiBucketSize, minSample) {
  const n = chron.length;
  const startIdx = Math.max(rsiArr.findIndex(v => v !== null), fastArr.findIndex(v => v !== null), slowArr.findIndex(v => v !== null));
  const endIdx = n - 1 - duration;

  let up = 0;
  let down = 0;
  for (let i = startIdx; i < endIdx; i++) {
    if (rsiArr[i] === null || fastArr[i] === null || slowArr[i] === null) continue;
    const bucket = Math.floor(rsiArr[i] / rsiBucketSize);
    const trendUp = fastArr[i] > slowArr[i];
    if (bucket === currentBucket && trendUp === currentTrendUp) {
      if (chron[i + duration] > chron[i]) up++;
      else down++;
    }
  }

  const total = up + down;
  if (total < minSample) return null;
  return { upPct: Math.round((up / total) * 100), downPct: Math.round((down / total) * 100), sampleSize: total };
}

// Runs the historical pattern match across many durations (in minutes) at
// once, reusing the same RSI/SMA series so it's cheap even for 20+ durations.
function multiDurationStats(candlesNewestFirst, durations, { period = 14, fastP = 5, slowP = 20, rsiBucketSize = 10, minSample = 8 } = {}) {
  const chron = [...candlesNewestFirst].reverse().map(c => c.close); // oldest -> newest
  const rsiArr = rsiSeries(chron, period);
  const fastArr = smaSeries(chron, fastP);
  const slowArr = smaSeries(chron, slowP);

  const currentIdx = chron.length - 1;
  const currentRSI = rsiArr[currentIdx];
  const currentFast = fastArr[currentIdx];
  const currentSlow = slowArr[currentIdx];
  if (currentRSI === null || currentFast === null || currentSlow === null) return null;

  const currentBucket = Math.floor(currentRSI / rsiBucketSize);
  const currentTrendUp = currentFast > currentSlow;

  const results = {};
  for (const d of durations) {
    results[d] = statsForDuration(chron, rsiArr, fastArr, slowArr, currentBucket, currentTrendUp, d, rsiBucketSize, minSample);
  }
  return results;
}

async function predictAllDurations(rawInput) {
  const symbol = normalizePair(rawInput);
  const durations = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 30, 40, 50, 60];

  // Still 1 API call. 1-minute candles so each candle = 1 minute, letting us
  // check every duration from 1 to 60 minutes directly. Twelve Data's max
  // outputsize per call is used to get as much history as possible.
  const candles = await fetchCandles(symbol, '1min', 5000);
  const price = candles[0].close;

  const stats = multiDurationStats(candles, durations);

  const lines = [
    `*${symbol} — Multi-Duration Prediction*`,
    ``,
    `Price: ${price}`,
    ``,
    `Har duration ke liye: is pair ki apni history mein, jab bhi abhi jaisa RSI+momentum setup tha, uske "N" minute baad price kitni baar UP gaya vs DOWN.`,
    ``,
  ];

  if (!stats) {
    lines.push('Not enough data right now to compute this — try again in a bit.');
  } else {
    for (const d of durations) {
      const s = stats[d];
      if (!s) {
        lines.push(`${d}min: not enough historical samples yet`);
      } else {
        const lean = s.upPct > s.downPct ? 'UP' : s.upPct < s.downPct ? 'DOWN' : 'FLAT';
        lines.push(`${d}min: ${lean} — UP ${s.upPct}% / DOWN ${s.downPct}% (n=${s.sampleSize})`);
      }
    }
  }

  lines.push(
    ``,
    `⚠️ *Zaroori warning:* Ye sab sirf past data ka statistic hai — "pehle aisa hua tha", future ki guarantee nahi. Chhoti durations (1-10 min) ka sample size chota hota hai (limited history ki wajah se), isliye kam reliable hain. Bade durations (30-60 min) thoda zyada meaningful ho sakte hain lekin phir bhi risk hamesha rehta hai. Apna paisa soch samajh kar lagayein.`
  );

  return lines.join('\n');
}

async function quickSignal(rawInput) {
  const symbol = normalizePair(rawInput);

  // Still just 1 API call — Twelve Data charges 1 credit per call regardless
  // of outputsize, so we can pull a large chunk of history for pattern
  // matching at no extra cost.
  const candles = await fetchCandles(symbol, '5min', 2000);

  const price = candles[0].close;
  const rsi5 = rsi(candles, 14);
  const emaFast = sma(candles, 5);
  const emaSlow = sma(candles, 20);
  const lastFew = candles.slice(0, 3).map(c => c.close);
  const momentumUp = lastFew[0] > lastFew[2];

  const pattern = historicalPatternStats(candles, { forwardSteps: 3 }); // ~15 min ahead

  let votesUp = 0;
  let votesDown = 0;
  const reasons = [];

  if (emaFast > emaSlow) { votesUp++; reasons.push('Short-term average (5) is above (20) — up momentum'); }
  else { votesDown++; reasons.push('Short-term average (5) is below (20) — down momentum'); }

  if (momentumUp) { votesUp++; reasons.push('Last few candles trending up'); }
  else { votesDown++; reasons.push('Last few candles trending down'); }

  if (rsi5 >= 60) { votesUp += 0.5; reasons.push('RSI leaning strong'); }
  else if (rsi5 <= 40) { votesDown += 0.5; reasons.push('RSI leaning weak'); }

  let patternLine = 'Not enough similar historical setups found for this pair yet.';
  if (pattern) {
    // Weight the historical statistic like 2 votes — it's the most data-backed signal we have.
    if (pattern.upPct > pattern.downPct) votesUp += 2;
    else if (pattern.downPct > pattern.upPct) votesDown += 2;
    patternLine = `In ${pattern.sampleSize} similar past setups (same RSI range + momentum) on this pair, price went UP ${pattern.upPct}% of the time and DOWN ${pattern.downPct}% of the time over the next ~${pattern.forwardSteps * 5} minutes.`;
  }

  const direction = votesUp > votesDown ? 'UP ⬆️' : votesDown > votesUp ? 'DOWN ⬇️' : 'UNCLEAR ↔️';
  const total = votesUp + votesDown;
  const strength = total > 0 ? Math.round((Math.max(votesUp, votesDown) / total) * 100) : 50;

  const lines = [
    `*${symbol} — Quick Signal (5min)*`,
    ``,
    `Price: ${price}`,
    `Guess: *${direction}*  (${strength}% of signals agree)`,
    `Reasons:`,
    ...reasons.map(r => `• ${r}`),
    ``,
    `📊 *Historical pattern:* ${patternLine}`,
    ``,
    `⚠️ *Zaroori warning:* Itni choti timeframe (1-5 min) mein price movement bohot random hoti hai. Historical pattern stat bhi sirf "pehle kya hua tha" batata hai — future ki guarantee nahi deta. Professional traders bhi is duration ko high-risk mante hain. Apna paisa soch samajh kar lagayein.`,
  ];

  return lines.join('\n');
}

async function analyzePair(rawInput) {
  const symbol = normalizePair(rawInput);

  // Only 4 API calls total per analysis (well under the 8/minute free-tier limit):
  // 1 live quote + 3 candle series (1h, 4h, 1day). Every indicator (RSI, SMA
  // trend, ATR, support/resistance, structure) is computed locally from the
  // candle data instead of calling separate indicator endpoints.
  const [quote, candles1h, candles4h, candles1d] = await Promise.all([
    fetchQuote(symbol),
    fetchCandles(symbol, '1h', 60),
    fetchCandles(symbol, '4h', 60),
    fetchCandles(symbol, '1day', 60),
  ]);

  const price = parseFloat(quote.close);
  const changePct = parseFloat(quote.percent_change);

  const rsi1h = rsi(candles1h, 14);
  const atr1h = atr(candles1h, 14);
  const trend1h = trendFromCandles(candles1h);
  const trend4h = trendFromCandles(candles4h);
  const trend1d = trendFromCandles(candles1d);

  const { support, resistance } = findSupportResistance(candles1h);
  const structure = detectStructure(candles1h);
  const { bias, confidence, reasons } = buildBias({ trend1h, trend4h, trend1d, structure, rsi1h });

  const longStop = (price - atr1h * 1.5).toFixed(5);
  const longTarget = (price + atr1h * 2).toFixed(5);
  const shortStop = (price + atr1h * 1.5).toFixed(5);
  const shortTarget = (price - atr1h * 2).toFixed(5);

  const lines = [
    `*${symbol} — Analysis*`,
    ``,
    `Price: ${price}  (${changePct}% today)`,
    ``,
    `*Bot's lean: ${bias}* (${confidence})`,
    `Reasons:`,
    ...reasons.map(r => `• ${r}`),
    ``,
    `RSI (1h): ${rsi1h.toFixed(2)} — ${interpretRSI(rsi1h)}`,
    `Structure: ${structure}`,
    `Resistance: ${resistance}  |  Support: ${support}`,
    ``,
    bias.includes('BUY')
      ? `If you go long: Stop ${longStop} | Target ${longTarget}`
      : bias.includes('SELL')
        ? `If you go short: Stop ${shortStop} | Target ${shortTarget}`
        : `No clean setup right now — waiting is a valid choice.`,
    ``,
    `_Ye bot ka data-based lean hai, guarantee nahi. Bot kabhi bhi galat ho sakta hai — final decision aapka hai. Stop-loss hamesha use karein._`,
  ];

  return lines.join('\n');
}

module.exports = { analyzePair, quickSignal, predictAllDurations, fullHistoryAnalysis, normalizePair };
