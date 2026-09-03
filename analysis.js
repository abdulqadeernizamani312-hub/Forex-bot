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

async function fetchRSI(symbol, interval) {
  const data = await apiGet('rsi', { symbol, interval });
  return parseFloat(data.values[0].rsi);
}

async function fetchSMA(symbol, interval, time_period) {
  const data = await apiGet('sma', { symbol, interval, time_period });
  return parseFloat(data.values[0].sma);
}

async function fetchATR(symbol, interval = '1h') {
  const data = await apiGet('atr', { symbol, interval });
  return parseFloat(data.values[0].atr);
}

async function fetchCandles(symbol, interval, outputsize = 30) {
  const data = await apiGet('time_series', { symbol, interval, outputsize });
  return data.values.map(v => ({
    time: v.datetime,
    open: parseFloat(v.open),
    high: parseFloat(v.high),
    low: parseFloat(v.low),
    close: parseFloat(v.close),
  }));
}

async function trendForTimeframe(symbol, interval) {
  const [sma20, sma50] = await Promise.all([
    fetchSMA(symbol, interval, 20),
    fetchSMA(symbol, interval, 50),
  ]);
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

function interpretRSI(rsi) {
  if (rsi >= 70) return 'Overbought (stretched, watch for pullback)';
  if (rsi <= 30) return 'Oversold (stretched, watch for bounce)';
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

async function analyzePair(rawInput) {
  const symbol = normalizePair(rawInput);

  const [quote, rsi1h, trend1h, trend4h, trend1d, atr1h, candles] = await Promise.all([
    fetchQuote(symbol),
    fetchRSI(symbol, '1h'),
    trendForTimeframe(symbol, '1h'),
    trendForTimeframe(symbol, '4h'),
    trendForTimeframe(symbol, '1day'),
    fetchATR(symbol, '1h'),
    fetchCandles(symbol, '1h', 30),
  ]);

  const price = parseFloat(quote.close);
  const changePct = parseFloat(quote.percent_change);
  const { support, resistance } = findSupportResistance(candles);
  const structure = detectStructure(candles);
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

module.exports = { analyzePair, normalizePair };
