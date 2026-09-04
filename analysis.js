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

async function quickSignal(rawInput) {
  const symbol = normalizePair(rawInput);

  // Just 1 API call: recent 5-minute candles.
  const candles = await fetchCandles(symbol, '5min', 50);

  const price = candles[0].close;
  const rsi5 = rsi(candles, 14);
  const emaFast = sma(candles, 5);
  const emaSlow = sma(candles, 20);
  const lastFew = candles.slice(0, 3).map(c => c.close);
  const momentumUp = lastFew[0] > lastFew[2];

  let votesUp = 0;
  let votesDown = 0;
  const reasons = [];

  if (emaFast > emaSlow) { votesUp++; reasons.push('Short-term average (5) is above (20) — up momentum'); }
  else { votesDown++; reasons.push('Short-term average (5) is below (20) — down momentum'); }

  if (momentumUp) { votesUp++; reasons.push('Last few candles trending up'); }
  else { votesDown++; reasons.push('Last few candles trending down'); }

  if (rsi5 >= 60) { votesUp += 0.5; reasons.push('RSI leaning strong'); }
  else if (rsi5 <= 40) { votesDown += 0.5; reasons.push('RSI leaning weak'); }

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
    `⚠️ *Zaroori warning:* Itni choti timeframe (1-5 min) mein price movement bohot random hoti hai. Koi bhi indicator isko reliably predict nahi kar sakta — professional traders bhi is duration ko high-risk mante hain. Ye sirf ek quick technical lean hai, coin-flip se thoda behtar ho sakta hai, guarantee bilkul nahi. Apna paisa soch samajh kar lagayein.`,
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

module.exports = { analyzePair, quickSignal, normalizePair };
