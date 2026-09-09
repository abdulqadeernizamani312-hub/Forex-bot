const axios = require('axios');

const BASE_URL = 'https://api.twelvedata.com';
const API_KEY = process.env.TWELVE_DATA_API_KEY;

const PAIR_ALIASES = {
  eurusd: 'EUR/USD', gbpusd: 'GBP/USD', usdjpy: 'USD/JPY', usdpkr: 'USD/PKR',
  usdinr: 'USD/INR', audusd: 'AUD/USD', usdcad: 'USD/CAD', usdchf: 'USD/CHF',
  nzdusd: 'NZD/USD', eurgbp: 'EUR/GBP', xauusd: 'XAU/USD',
};

function normalizePair(input) {
  const clean = input.trim().toLowerCase().replace(/[\/\s]/g, '');
  if (PAIR_ALIASES[clean]) return PAIR_ALIASES[clean];
  if (/^[a-z]{6}$/.test(clean)) {
    return `${clean.slice(0, 3).toUpperCase()}/${clean.slice(3).toUpperCase()}`;
  }
  return input.toUpperCase();
}

function isForexMarketLikelyClosed(date = new Date()) {
  const day = date.getUTCDay();
  const hour = date.getUTCHours();
  if (day === 6) return true;
  if (day === 0 && hour < 21) return true;
  if (day === 5 && hour >= 21) return true;
  return false;
}

// Rough major-session windows (UTC). Not exact, but good enough to flag
// which markets are actively driving liquidity right now.
function getSessionInfo(date = new Date()) {
  const hour = date.getUTCHours();
  const sydney = hour >= 21 || hour < 6;
  const tokyo = hour >= 0 && hour < 9;
  const london = hour >= 7 && hour < 16;
  const newyork = hour >= 12 && hour < 21;
  const active = [];
  if (sydney) active.push('Sydney');
  if (tokyo) active.push('Tokyo');
  if (london) active.push('London');
  if (newyork) active.push('New York');
  return { sydney, tokyo, london, newyork, active };
}

// Very rough, hardcoded heuristic for predictable high-impact news timing —
// NOT a live calendar (no reliable free calendar API without a paid key was
// found). This only catches the most predictable recurring events.
function newsRiskWarning(date = new Date()) {
  const day = date.getUTCDay();
  const hour = date.getUTCHours();
  const dayOfMonth = date.getUTCDate();
  const warnings = [];

  // US NFP: first Friday of the month, ~12:30 UTC
  if (day === 5 && dayOfMonth <= 7 && hour >= 12 && hour < 14) {
    warnings.push('Aaj US Non-Farm Payrolls (NFP) ka din ho sakta hai (~12:30 UTC) — high volatility expected.');
  }
  // Generic: most central bank decisions & major US data land 12:30-15:00 UTC on weekdays
  if (day >= 1 && day <= 5 && hour >= 12 && hour < 15) {
    warnings.push('Ye time window (12:30-15:00 UTC) mein aksar major US economic data / Fed announcements aate hain — thoda extra ehtiyaat.');
  }
  return warnings;
}

async function apiGet(path, params) {
  const { data } = await axios.get(`${BASE_URL}/${path}`, { params: { ...params, apikey: API_KEY } });
  if (data.code && data.code !== 200) throw new Error(data.message || `Failed: ${path}`);
  return data;
}

async function fetchQuote(symbol) {
  return apiGet('quote', { symbol });
}

async function fetchCandles(symbol, interval, outputsize = 60) {
  const data = await apiGet('time_series', { symbol, interval, outputsize });
  return data.values.map(v => ({
    time: v.datetime,
    open: parseFloat(v.open), high: parseFloat(v.high),
    low: parseFloat(v.low), close: parseFloat(v.close),
  }));
}

// ---- Basic indicators ----
function sma(candles, period) {
  const closes = candles.slice(0, period).map(c => c.close);
  return closes.reduce((a, b) => a + b, 0) / closes.length;
}

function rsi(candles, period = 14) {
  const chron = [...candles].reverse();
  if (chron.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = chron[i].close - chron[i - 1].close;
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  let avgGain = gains / period, avgLoss = losses / period;
  for (let i = period + 1; i < chron.length; i++) {
    const diff = chron[i].close - chron[i - 1].close;
    const gain = diff > 0 ? diff : 0, loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

function atr(candles, period = 14) {
  const chron = [...candles].reverse();
  if (chron.length < period + 1) return 0;
  const trueRanges = [];
  for (let i = 1; i < chron.length; i++) {
    const cur = chron[i], prev = chron[i - 1];
    trueRanges.push(Math.max(cur.high - cur.low, Math.abs(cur.high - prev.close), Math.abs(cur.low - prev.close)));
  }
  const recent = trueRanges.slice(-period);
  return recent.reduce((a, b) => a + b, 0) / recent.length;
}

// ---- Rolling series ----
function rsiSeries(closesChron, period = 14) {
  const out = new Array(closesChron.length).fill(null);
  if (closesChron.length < period + 1) return out;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closesChron[i] - closesChron[i - 1];
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  let avgGain = gains / period, avgLoss = losses / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < closesChron.length; i++) {
    const diff = closesChron[i] - closesChron[i - 1];
    const gain = diff > 0 ? diff : 0, loss = diff < 0 ? -diff : 0;
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

function atrPctSeries(candlesChron, period = 14) {
  const n = candlesChron.length;
  const out = new Array(n).fill(null);
  const trueRanges = new Array(n).fill(null);
  for (let i = 1; i < n; i++) {
    const cur = candlesChron[i], prev = candlesChron[i - 1];
    trueRanges[i] = Math.max(cur.high - cur.low, Math.abs(cur.high - prev.close), Math.abs(cur.low - prev.close));
  }
  for (let i = period; i < n; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += trueRanges[j];
    out[i] = ((sum / period) / candlesChron[i].close) * 100;
  }
  return out;
}

function marginOfError(pct, sampleSize) {
  const p = pct / 100;
  return Math.round(1.96 * Math.sqrt((p * (1 - p)) / sampleSize) * 100);
}

function confidenceLabel(margin) {
  if (margin <= 6) return 'High confidence (large sample)';
  if (margin <= 12) return 'Medium confidence';
  return 'Low confidence (small sample)';
}

// ---- Candlestick pattern detection (simple heuristics) ----
// Returns 'bullish', 'bearish', or null for the candle at chronIndex i
// (needs candlesChron[i] and candlesChron[i-1]).
function candlePatternAt(candlesChron, i) {
  if (i < 1) return null;
  const cur = candlesChron[i], prev = candlesChron[i - 1];
  const body = Math.abs(cur.close - cur.open);
  const range = cur.high - cur.low || 1e-9;
  const upperWick = cur.high - Math.max(cur.close, cur.open);
  const lowerWick = Math.min(cur.close, cur.open) - cur.low;
  const prevBody = Math.abs(prev.close - prev.open);

  // Engulfing
  const curBull = cur.close > cur.open;
  const prevBull = prev.close > prev.open;
  if (curBull && !prevBull && cur.close >= prev.open && cur.open <= prev.close && body > prevBody) return 'bullish';
  if (!curBull && prevBull && cur.open >= prev.close && cur.close <= prev.open && body > prevBody) return 'bearish';

  // Hammer (small body, long lower wick, near top of range) — bullish
  if (body / range < 0.35 && lowerWick > body * 2 && upperWick < body) return 'bullish';
  // Shooting star (small body, long upper wick, near bottom) — bearish
  if (body / range < 0.35 && upperWick > body * 2 && lowerWick < body) return 'bearish';

  return null;
}

// Generic backtest helper: given a boolean/null "predicts up?" array aligned
// to chron closes, measure how often that prediction matched what actually
// happened `forwardSteps` candles later. Used to auto-weight each factor by
// its own real historical accuracy instead of a fixed guess.
function factorAccuracy(chronCloses, predictArr, forwardSteps) {
  let correct = 0, total = 0;
  const n = chronCloses.length;
  for (let i = 0; i < n - forwardSteps; i++) {
    if (predictArr[i] === null || predictArr[i] === undefined) continue;
    const actualUp = chronCloses[i + forwardSteps] > chronCloses[i];
    if (predictArr[i] === actualUp) correct++;
    total++;
  }
  if (total < 20) return { accuracy: 0.5, total };
  return { accuracy: correct / total, total };
}

// Builds an auto-weighted ensemble signal: several simple factors are each
// backtested against this pair's own history to find their real standalone
// accuracy, then combined weighted by (accuracy - 0.5) — factors that
// historically did no better than a coin flip contribute ~nothing.
function ensembleSignal(candlesNewestFirst, { forwardSteps = 3, period = 14, fastP = 5, slowP = 20, longP = 200 } = {}) {
  const chronCandles = [...candlesNewestFirst].reverse();
  const chron = chronCandles.map(c => c.close);
  const n = chron.length;

  const rsiArr = rsiSeries(chron, period);
  const fastArr = smaSeries(chron, fastP);
  const slowArr = smaSeries(chron, slowP);
  const longArr = n >= longP ? smaSeries(chron, longP) : null;

  // Factor 1: fast/slow SMA cross
  const f1 = chron.map((_, i) => (fastArr[i] !== null && slowArr[i] !== null) ? fastArr[i] > slowArr[i] : null);
  // Factor 2: last-3-candle momentum
  const f2 = chron.map((_, i) => (i >= 2) ? chron[i] > chron[i - 2] : null);
  // Factor 3: RSI extreme (only signals at extremes, else null)
  const f3 = chron.map((_, i) => {
    if (rsiArr[i] === null) return null;
    if (rsiArr[i] >= 60) return true;
    if (rsiArr[i] <= 40) return false;
    return null;
  });
  // Factor 4: medium/long-term SMA cross
  const f4 = longArr ? chron.map((_, i) => (fastArr[i] !== null && longArr[i] !== null) ? fastArr[i] > longArr[i] : null) : null;
  // Factor 5: candlestick pattern
  const f5 = chronCandles.map((_, i) => {
    const p = candlePatternAt(chronCandles, i);
    if (p === 'bullish') return true;
    if (p === 'bearish') return false;
    return null;
  });

  const factors = [
    { name: 'Short/long average cross', arr: f1 },
    { name: 'Recent candle momentum', arr: f2 },
    { name: 'RSI extreme', arr: f3 },
    { name: 'Candlestick pattern', arr: f5 },
  ];
  if (f4) factors.push({ name: 'Medium-term trend', arr: f4 });

  let weightedUp = 0;
  let weightedDown = 0;
  let totalWeight = 0;
  const reasons = [];

  for (const f of factors) {
    const currentVal = f.arr[n - 1];
    if (currentVal === null || currentVal === undefined) continue;
    const { accuracy, total } = factorAccuracy(chron, f.arr, forwardSteps);
    // Give every fired factor at least a small baseline weight so a pair
    // with no single strong factor doesn't collapse to a hard "UNCLEAR" —
    // factors with a real historical edge (accuracy > 50%) get extra weight
    // on top of that baseline.
    const edge = Math.max(0, accuracy - 0.5);
    const weight = 0.05 + edge;
    totalWeight += weight;
    const edgeNote = edge > 0.01 ? `real edge, accuracy ${Math.round(accuracy * 100)}%` : `weak/no edge, accuracy ${Math.round(accuracy * 100)}%`;
    if (currentVal) { weightedUp += weight; reasons.push(`${f.name}: says UP (${edgeNote}, n=${total})`); }
    else { weightedDown += weight; reasons.push(`${f.name}: says DOWN (${edgeNote}, n=${total})`); }
  }

  const direction = weightedUp > weightedDown ? 'UP' : weightedDown > weightedUp ? 'DOWN' : 'UNCLEAR';
  const strength = totalWeight > 0 ? Math.round((Math.max(weightedUp, weightedDown) / totalWeight) * 100) : 50;

  return { direction, strength, reasons, factorsUsed: reasons.length };
}

// Proper out-of-sample backtest: split history into train/test, build a
// lookup of (RSI-bucket, trend) -> outcome using ONLY the training portion,
// then test predictions on the later (test) portion the method never saw.
function backtestSetup(candlesNewestFirst, { forwardSteps = 3, rsiBucketSize = 10, trainFraction = 0.7 } = {}) {
  const chronCandles = [...candlesNewestFirst].reverse();
  const chron = chronCandles.map(c => c.close);
  const n = chron.length;
  const rsiArr = rsiSeries(chron, 14);
  const fastArr = smaSeries(chron, 5);
  const slowArr = smaSeries(chron, 20);

  const splitIdx = Math.floor(n * trainFraction);
  const lookup = {}; // key -> {up, down}

  for (let j = 20; j < splitIdx - forwardSteps; j++) {
    if (rsiArr[j] === null || fastArr[j] === null || slowArr[j] === null) continue;
    const bucket = Math.floor(rsiArr[j] / rsiBucketSize);
    const trendUp = fastArr[j] > slowArr[j];
    const key = `${bucket}_${trendUp}`;
    if (!lookup[key]) lookup[key] = { up: 0, down: 0 };
    if (chron[j + forwardSteps] > chron[j]) lookup[key].up++;
    else lookup[key].down++;
  }

  let correct = 0, wrong = 0, skipped = 0;
  let baselineUp = 0, baselineDown = 0;

  for (let i = splitIdx; i < n - forwardSteps; i++) {
    if (rsiArr[i] === null || fastArr[i] === null || slowArr[i] === null) continue;
    const actualUp = chron[i + forwardSteps] > chron[i];
    if (actualUp) baselineUp++; else baselineDown++;

    const bucket = Math.floor(rsiArr[i] / rsiBucketSize);
    const trendUp = fastArr[i] > slowArr[i];
    const key = `${bucket}_${trendUp}`;
    const stat = lookup[key];
    if (!stat || stat.up + stat.down < 8) { skipped++; continue; }

    const predictedUp = stat.up > stat.down;
    if (predictedUp === actualUp) correct++; else wrong++;
  }

  const totalPredicted = correct + wrong;
  const baselineTotal = baselineUp + baselineDown;
  return {
    totalTestPoints: n - splitIdx - forwardSteps,
    predicted: totalPredicted,
    skipped,
    correct,
    wrong,
    accuracyPct: totalPredicted > 0 ? Math.round((correct / totalPredicted) * 100) : null,
    baselinePct: baselineTotal > 0 ? Math.round((Math.max(baselineUp, baselineDown) / baselineTotal) * 100) : null,
  };
}

async function backtestMethod(rawInput) {
  const symbol = normalizePair(rawInput);
  const candles = await fetchCandles(symbol, '5min', 3000); // 1 API call
  const result = backtestSetup(candles, { forwardSteps: 3 });

  const lines = [
    `*${symbol} — Backtest (out-of-sample, 5min/15min-ahead)*`,
    ``,
    `Test period: last ~30% of available history (method trained only on the earlier ~70%, never saw this part).`,
    ``,
    `Predictions made: ${result.predicted} (skipped ${result.skipped} — not enough training data for that setup)`,
    result.accuracyPct !== null ? `*Method accuracy: ${result.accuracyPct}%*` : 'Not enough data to score.',
    result.baselinePct !== null ? `Naive baseline (always guess the more common direction): ${result.baselinePct}%` : '',
    ``,
    result.accuracyPct !== null && result.baselinePct !== null
      ? (result.accuracyPct > result.baselinePct
          ? `✅ Method beat the naive baseline by ${result.accuracyPct - result.baselinePct} points — some real (if modest) historical edge on this pair.`
          : `⚠️ Method did NOT beat the naive baseline — no real edge found on this pair/timeframe right now.`)
      : '',
    ``,
    `⚠️ Ye ek single train/test split hai (poori proper cross-validation nahi), aur past performance future ki guarantee kabhi nahi hoti — market conditions badalte rehte hain.`,
  ].filter(Boolean);

  return lines.join('\n');
}

function bounceStats(candlesNewestFirst, level, { tolerancePct = 0.08, forwardSteps = 6, minGap = 5 } = {}) {
  const chron = [...candlesNewestFirst].reverse();
  const n = chron.length;
  let lastTouchIdx = -Infinity, up = 0, down = 0;
  for (let i = 1; i < n - forwardSteps; i++) {
    if (i - lastTouchIdx < minGap) continue;
    const price = chron[i].close;
    const distPct = (Math.abs(price - level) / level) * 100;
    if (distPct <= tolerancePct) {
      lastTouchIdx = i;
      if (chron[i + forwardSteps].close > price) up++; else down++;
    }
  }
  const total = up + down;
  if (total < 5) return null;
  const upPct = Math.round((up / total) * 100), downPct = Math.round((down / total) * 100);
  return { upPct, downPct, sampleSize: total, margin: marginOfError(upPct, total), confidence: confidenceLabel(marginOfError(upPct, total)) };
}

async function getKeyLevelsWithStats(rawInput) {
  const symbol = normalizePair(rawInput);
  const candles = await fetchCandles(symbol, '1h', 2000);
  const price = candles[0].close;
  const recent = candles.slice(0, 100);
  const { support, resistance } = findSupportResistance(recent);
  return {
    symbol, price, resistance, support,
    resistanceStats: bounceStats(candles, resistance),
    supportStats: bounceStats(candles, support),
  };
}

function trendFromCandles(candles) {
  const sma20 = sma(candles, 20);
  const sma50 = sma(candles, Math.min(50, candles.length));
  return sma20 > sma50 ? 'UP' : 'DOWN';
}

function findSupportResistance(candles) {
  const highs = candles.map(c => c.high), lows = candles.map(c => c.low);
  return { support: Math.min(...lows), resistance: Math.max(...highs) };
}

function detectStructure(candles) {
  const recent = candles.slice(0, 10);
  const highs = recent.map(c => c.high), lows = recent.map(c => c.low);
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
  let bullScore = 0, bearScore = 0;
  if (trend1h === 'UP') { bullScore++; reasons.push('1H trend is UP'); } else { bearScore++; reasons.push('1H trend is DOWN'); }
  if (trend4h === 'UP') { bullScore++; reasons.push('4H trend is UP'); } else { bearScore++; reasons.push('4H trend is DOWN'); }
  if (trend1d === 'UP') { bullScore++; reasons.push('Daily trend is UP'); } else { bearScore++; reasons.push('Daily trend is DOWN'); }
  if (structure.includes('bullish')) { bullScore++; reasons.push('Recent structure is bullish (higher highs/lows)'); }
  else if (structure.includes('bearish')) { bearScore++; reasons.push('Recent structure is bearish (lower highs/lows)'); }
  else { reasons.push('Structure is mixed/ranging — no clear edge here'); }
  if (rsi1h >= 70) { bearScore += 0.5; reasons.push('RSI overbought — pullback risk'); }
  else if (rsi1h <= 30) { bullScore += 0.5; reasons.push('RSI oversold — bounce possible'); }

  let bias, confidence;
  const total = bullScore + bearScore;
  if (bullScore > bearScore) { bias = 'BUY lean'; confidence = `${bullScore}/${total.toFixed(1)} signals lean up`; }
  else if (bearScore > bullScore) { bias = 'SELL lean'; confidence = `${bearScore}/${total.toFixed(1)} signals lean down`; }
  else { bias = 'NO CLEAR LEAN — signals are split'; confidence = 'mixed signals'; }
  return { bias, confidence, reasons };
}

function statsForDuration(chron, rsiArr, fastArr, slowArr, currentBucket, currentTrendUp, duration, rsiBucketSize, minSample) {
  const n = chron.length;
  const startIdx = Math.max(rsiArr.findIndex(v => v !== null), fastArr.findIndex(v => v !== null), slowArr.findIndex(v => v !== null));
  const endIdx = n - 1 - duration;
  let up = 0, down = 0;
  for (let i = startIdx; i < endIdx; i++) {
    if (rsiArr[i] === null || fastArr[i] === null || slowArr[i] === null) continue;
    const bucket = Math.floor(rsiArr[i] / rsiBucketSize);
    const trendUp = fastArr[i] > slowArr[i];
    if (bucket === currentBucket && trendUp === currentTrendUp) {
      if (chron[i + duration] > chron[i]) up++; else down++;
    }
  }
  const total = up + down;
  if (total < minSample) return null;
  const upPct = Math.round((up / total) * 100), downPct = Math.round((down / total) * 100);
  const margin = marginOfError(upPct, total);
  return { upPct, downPct, sampleSize: total, margin, confidence: confidenceLabel(margin) };
}

function multiDurationStats(candlesNewestFirst, durations, { period = 14, fastP = 5, slowP = 20, rsiBucketSize = 10, minSample = 8 } = {}) {
  const chron = [...candlesNewestFirst].reverse().map(c => c.close);
  const rsiArr = rsiSeries(chron, period);
  const fastArr = smaSeries(chron, fastP);
  const slowArr = smaSeries(chron, slowP);
  const currentIdx = chron.length - 1;
  const currentRSI = rsiArr[currentIdx], currentFast = fastArr[currentIdx], currentSlow = slowArr[currentIdx];
  if (currentRSI === null || currentFast === null || currentSlow === null) return null;
  const currentBucket = Math.floor(currentRSI / rsiBucketSize);
  const currentTrendUp = currentFast > currentSlow;
  const results = {};
  for (const d of durations) results[d] = statsForDuration(chron, rsiArr, fastArr, slowArr, currentBucket, currentTrendUp, d, rsiBucketSize, minSample);
  return results;
}

async function predictAllDurations(rawInput) {
  const symbol = normalizePair(rawInput);
  const durations = [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,30,40,50,60];
  const candles = await fetchCandles(symbol, '1min', 5000);
  const price = candles[0].close;
  const stats = multiDurationStats(candles, durations);

  const lines = [`*${symbol} — Multi-Duration Prediction*`, ``, `Price: ${price}`, ``];
  if (isForexMarketLikelyClosed()) lines.push('⚠️ Forex market is likely CLOSED right now (weekend).', ``);
  lines.push(`Har duration ke liye history-based stat. (H)=High confidence, (M)=Medium, (L)=Low.`, ``);

  if (!stats) {
    lines.push('Not enough data right now — try again in a bit.');
  } else {
    for (const d of durations) {
      const s = stats[d];
      if (!s) { lines.push(`${d}min: not enough historical samples yet`); continue; }
      const lean = s.upPct > s.downPct ? 'UP' : s.upPct < s.downPct ? 'DOWN' : 'FLAT';
      const tag = s.confidence.startsWith('High') ? 'H' : s.confidence.startsWith('Medium') ? 'M' : 'L';
      lines.push(`${d}min: ${lean} (${tag}) — UP ${s.upPct}% / DOWN ${s.downPct}% (n=${s.sampleSize}, ±${s.margin}%)`);
    }
  }
  lines.push(``, `⚠️ Sirf past data ka statistic hai, future ki guarantee nahi.`);
  return lines.join('\n');
}

// Checks 2 other major pairs sharing a currency with `symbol` to see if the
// broader currency-strength picture agrees with the local signal. Costs a
// couple of extra API calls (cheap `quote` calls).
async function crossPairConfirmation(symbol) {
  const [base, quote] = symbol.split('/');
  const relatedMap = {
    USD: ['EUR/USD', 'GBP/USD'], EUR: ['EUR/USD', 'EUR/GBP'], GBP: ['GBP/USD', 'EUR/GBP'],
    JPY: ['USD/JPY', 'EUR/JPY'], AUD: ['AUD/USD', 'AUD/JPY'], CAD: ['USD/CAD'],
    CHF: ['USD/CHF'], NZD: ['NZD/USD'],
  };
  const candidates = (relatedMap[base] || []).concat(relatedMap[quote] || []);
  const uniquePairs = [...new Set(candidates)].filter(p => p !== symbol).slice(0, 2);
  if (uniquePairs.length === 0) return null;

  try {
    const quotes = await Promise.all(uniquePairs.map(p => fetchQuote(p)));
    const info = quotes.map((q, idx) => ({ pair: uniquePairs[idx], changePct: parseFloat(q.percent_change) }));
    return info;
  } catch (e) {
    return null;
  }
}

async function quickSignal(rawInput) {
  const symbol = normalizePair(rawInput);
  const candles = await fetchCandles(symbol, '5min', 2000); // 1 call

  const price = candles[0].close;
  const ensemble = ensembleSignal(candles, { forwardSteps: 3 });
  const pattern = (function () {
    const chronCandles = [...candles].reverse();
    const chron = chronCandles.map(c => c.close);
    const rsiArr = rsiSeries(chron, 14);
    const fastArr = smaSeries(chron, 5);
    const slowArr = smaSeries(chron, 20);
    const idx = chron.length - 1;
    if (rsiArr[idx] === null) return null;
    // reuse bucket-based historical stat as before, for the headline number
    const rsiBucketSize = 10;
    const currentBucket = Math.floor(rsiArr[idx] / rsiBucketSize);
    const currentTrendUp = fastArr[idx] > slowArr[idx];
    let up = 0, down = 0;
    for (let i = 20; i < chron.length - 3; i++) {
      if (rsiArr[i] === null) continue;
      const bucket = Math.floor(rsiArr[i] / rsiBucketSize);
      const trendUp = fastArr[i] > slowArr[i];
      if (bucket === currentBucket && trendUp === currentTrendUp) {
        if (chron[i + 3] > chron[i]) up++; else down++;
      }
    }
    const total = up + down;
    if (total < 8) return null;
    const upPct = Math.round((up / total) * 100), downPct = Math.round((down / total) * 100);
    return { upPct, downPct, sampleSize: total, margin: marginOfError(upPct, total), confidence: confidenceLabel(marginOfError(upPct, total)) };
  })();

  const session = getSessionInfo();
  const newsWarnings = newsRiskWarning();

  const lines = [`*${symbol} — Quick Signal (5min)*`, ``, `Price: ${price}`];
  if (isForexMarketLikelyClosed()) lines.push('⚠️ Forex market is likely CLOSED right now (weekend) — won\'t match Quotex OTC prices.');

  const directionLabel = ensemble.direction === 'UP' ? 'UP ⬆️' : ensemble.direction === 'DOWN' ? 'DOWN ⬇️' : 'UNCLEAR ↔️';
  lines.push(
    `Guess: *${directionLabel}*  (${ensemble.strength}% weighted agreement, ${ensemble.factorsUsed} factors used)`,
    `Reasons (each auto-weighted by its OWN historical accuracy on this pair):`,
    ...ensemble.reasons.map(r => `• ${r}`),
    ``,
  );

  if (pattern) {
    lines.push(`📊 *Historical pattern:* In ${pattern.sampleSize} similar past setups, price went UP ${pattern.upPct}% / DOWN ${pattern.downPct}% over next ~15 min. Reliability: ${pattern.confidence} (±${pattern.margin}%).`, ``);
  }

  lines.push(`🌍 Active sessions right now: ${session.active.join(', ') || 'none major'}`);
  if (newsWarnings.length) lines.push(...newsWarnings.map(w => `📰 ${w}`));

  lines.push(``, `⚠️ *Zaroori warning:* Itni choti timeframe mein price movement bohot random hoti hai. Ye ensemble/history statistic hai, guarantee nahi. Apna paisa soch samajh kar lagayein.`);

  return {
    message: lines.join('\n'),
    meta: { symbol, price, direction: ensemble.direction, forwardMinutes: 15 },
  };
}

async function analyzePair(rawInput) {
  const symbol = normalizePair(rawInput);
  const [quote, candles1h, candles4h, candles1d] = await Promise.all([
    fetchQuote(symbol), fetchCandles(symbol, '1h', 60), fetchCandles(symbol, '4h', 60), fetchCandles(symbol, '1day', 60),
  ]);
  const price = parseFloat(quote.close);
  const changePct = parseFloat(quote.percent_change);
  const rsi1h = rsi(candles1h, 14);
  const atr1h = atr(candles1h, 14);
  const trend1h = trendFromCandles(candles1h), trend4h = trendFromCandles(candles4h), trend1d = trendFromCandles(candles1d);
  const { support, resistance } = findSupportResistance(candles1h);
  const structure = detectStructure(candles1h);
  const { bias, confidence, reasons } = buildBias({ trend1h, trend4h, trend1d, structure, rsi1h });
  const longStop = (price - atr1h * 1.5).toFixed(5), longTarget = (price + atr1h * 2).toFixed(5);
  const shortStop = (price + atr1h * 1.5).toFixed(5), shortTarget = (price - atr1h * 2).toFixed(5);

  const lines = [`*${symbol} — Analysis*`, ``, `Price: ${price}  (${changePct}% today)`, ``];
  if (isForexMarketLikelyClosed()) lines.push('⚠️ Forex market is likely CLOSED right now (weekend).', ``);
  lines.push(
    `*Bot's lean: ${bias}* (${confidence})`, `Reasons:`, ...reasons.map(r => `• ${r}`), ``,
    `RSI (1h): ${rsi1h.toFixed(2)} — ${interpretRSI(rsi1h)}`, `Structure: ${structure}`,
    `Resistance: ${resistance}  |  Support: ${support}`, ``,
    bias.includes('BUY') ? `If you go long: Stop ${longStop} | Target ${longTarget}`
      : bias.includes('SELL') ? `If you go short: Stop ${shortStop} | Target ${shortTarget}`
      : `No clean setup right now — waiting is a valid choice.`,
    ``, `_Ye bot ka data-based lean hai, guarantee nahi. Stop-loss hamesha use karein._`
  );
  return lines.join('\n');
}

async function fullHistoryAnalysis(rawInput) {
  const symbol = normalizePair(rawInput);
  const [candles1h, candles4h, candles1d] = await Promise.all([
    fetchCandles(symbol, '1h', 5000), fetchCandles(symbol, '4h', 5000), fetchCandles(symbol, '1day', 5000),
  ]);
  const price = candles1h[0].close;
  const timeframes = [
    { label: '1 Hour', candles: candles1h, forwardSteps: 4, forwardLabel: '~4 hours' },
    { label: '4 Hour', candles: candles4h, forwardSteps: 3, forwardLabel: '~12 hours' },
    { label: 'Daily', candles: candles1d, forwardSteps: 3, forwardLabel: '~3 days' },
  ];
  const lines = [`*${symbol} — Full History Analysis*`, ``, `Price: ${price}`, ``];
  if (isForexMarketLikelyClosed()) lines.push('⚠️ Forex market is likely CLOSED right now (weekend).', ``);
  lines.push(`Har timeframe ki poori history se pattern nikala gaya hai.`, ``);

  let bullScore = 0, bearScore = 0;
  const summaryReasons = [];
  for (const tf of timeframes) {
    const rsiVal = rsi(tf.candles, 14);
    const trend = trendFromCandles(tf.candles);
    const pattern = (function () {
      const chronCandles = [...tf.candles].reverse();
      const chron = chronCandles.map(c => c.close);
      const rsiArr = rsiSeries(chron, 14), fastArr = smaSeries(chron, 5), slowArr = smaSeries(chron, 20);
      const idx = chron.length - 1;
      if (rsiArr[idx] === null) return null;
      const bucket = Math.floor(rsiArr[idx] / 10), trendUp = fastArr[idx] > slowArr[idx];
      let up = 0, down = 0;
      for (let i = 20; i < chron.length - tf.forwardSteps; i++) {
        if (rsiArr[i] === null) continue;
        if (Math.floor(rsiArr[i] / 10) === bucket && (fastArr[i] > slowArr[i]) === trendUp) {
          if (chron[i + tf.forwardSteps] > chron[i]) up++; else down++;
        }
      }
      const total = up + down;
      if (total < 8) return null;
      const upPct = Math.round((up / total) * 100), downPct = Math.round((down / total) * 100);
      return { upPct, downPct, sampleSize: total, margin: marginOfError(upPct, total), confidence: confidenceLabel(marginOfError(upPct, total)) };
    })();

    lines.push(`*${tf.label} timeframe:*`, `  Trend: ${trend} | RSI: ${rsiVal.toFixed(1)} — ${interpretRSI(rsiVal)}`);
    if (pattern) {
      lines.push(`  History: ${pattern.sampleSize} similar setups → UP ${pattern.upPct}% / DOWN ${pattern.downPct}% over next ${tf.forwardLabel}`, `  Reliability: ${pattern.confidence} (±${pattern.margin}%)`);
      if (pattern.upPct > pattern.downPct) { bullScore++; summaryReasons.push(`${tf.label}: history leans UP (${pattern.upPct}%)`); }
      else if (pattern.downPct > pattern.upPct) { bearScore++; summaryReasons.push(`${tf.label}: history leans DOWN (${pattern.downPct}%)`); }
    } else {
      lines.push(`  History: not enough similar past setups yet`);
    }
    lines.push(``);
  }

  let overall;
  if (bullScore > bearScore) overall = `Overall lean: BUY (${bullScore}/${bullScore + bearScore} timeframes agree)`;
  else if (bearScore > bullScore) overall = `Overall lean: SELL (${bearScore}/${bullScore + bearScore} timeframes agree)`;
  else overall = `Overall lean: NO CLEAR AGREEMENT across timeframes`;
  lines.push(`*${overall}*`, ...summaryReasons.map(r => `• ${r}`));
  lines.push(``, `⚠️ Ye poori history ka statistic hai, guarantee nahi. Stop-loss zaroor use karein.`);
  return lines.join('\n');
}

// Comprehensive multi-source analysis using up to ~7-8 API calls: micro
// (1min), short (5min ensemble), and 3 higher timeframes (1h/4h/1day), plus
// cross-pair confirmation. Combines everything into one verdict with an
// honest "how many independent signals agree" confidence measure.
async function masterAnalysis(rawInput) {
  const symbol = normalizePair(rawInput);

  const [candles1m, candles5m, candles1h, candles4h, candles1d] = await Promise.all([
    fetchCandles(symbol, '1min', 1500),   // call 1
    fetchCandles(symbol, '5min', 2000),   // call 2
    fetchCandles(symbol, '1h', 500),      // call 3
    fetchCandles(symbol, '4h', 500),      // call 4
    fetchCandles(symbol, '1day', 500),    // call 5
  ]);
  const price = candles1m[0].close;

  const crossInfo = await crossPairConfirmation(symbol); // calls 6-7 (best-effort)

  const ensemble = ensembleSignal(candles5m, { forwardSteps: 3 });

  const timeframeVerdicts = [];
  const micro1mUp = sma(candles1m, 10) > sma(candles1m, 50);
  timeframeVerdicts.push({ label: '1min micro-trend', up: micro1mUp });
  timeframeVerdicts.push({ label: '5min ensemble', up: ensemble.direction === 'UP' ? true : ensemble.direction === 'DOWN' ? false : null });

  const higherTFs = [
    { label: '1 Hour', candles: candles1h, forwardSteps: 4 },
    { label: '4 Hour', candles: candles4h, forwardSteps: 3 },
    { label: 'Daily', candles: candles1d, forwardSteps: 3 },
  ];
  const tfDetails = [];
  for (const tf of higherTFs) {
    const trend = trendFromCandles(tf.candles);
    const pattern = historicalPatternStats(tf.candles, { forwardSteps: tf.forwardSteps });
    const up = pattern ? pattern.upPct > pattern.downPct : trend === 'UP';
    timeframeVerdicts.push({ label: tf.label, up });
    tfDetails.push({ label: tf.label, trend, pattern });
  }

  const agreeUp = timeframeVerdicts.filter(v => v.up === true).length;
  const agreeDown = timeframeVerdicts.filter(v => v.up === false).length;
  const totalOpinions = agreeUp + agreeDown;
  const overallDirection = agreeUp > agreeDown ? 'UP' : agreeDown > agreeUp ? 'DOWN' : 'UNCLEAR';

  const session = getSessionInfo();
  const newsWarnings = newsRiskWarning();

  const lines = [
    `*${symbol} — Master Analysis*`, ``,
    `Price: ${price}`,
  ];
  if (isForexMarketLikelyClosed()) lines.push('⚠️ Forex market is likely CLOSED right now (weekend).');
  lines.push(
    ``,
    `*Overall: ${overallDirection}* (${agreeUp}/${totalOpinions} independent timeframes/signals agree)`,
    ``,
    `1min micro-trend: ${micro1mUp ? 'UP' : 'DOWN'}`,
    `5min ensemble: ${ensemble.direction} (${ensemble.strength}% weighted, ${ensemble.factorsUsed} factors)`,
  );
  for (const d of tfDetails) {
    if (d.pattern) {
      lines.push(`${d.label}: trend ${d.trend}, history UP ${d.pattern.upPct}%/DOWN ${d.pattern.downPct}% (n=${d.pattern.sampleSize}, ${d.pattern.confidence})`);
    } else {
      lines.push(`${d.label}: trend ${d.trend} (not enough history for a pattern stat)`);
    }
  }
  lines.push(``, `🌍 Active sessions: ${session.active.join(', ') || 'none major'}`);
  if (newsWarnings.length) lines.push(...newsWarnings.map(w => `📰 ${w}`));
  if (crossInfo && crossInfo.length) {
    lines.push(``, `🔗 Related pairs:`, ...crossInfo.map(c => `  ${c.pair}: ${c.changePct > 0 ? '+' : ''}${c.changePct}% today`));
  }

  lines.push(
    ``,
    `⚠️ *Honest note:* Ye ${totalOpinions} alag-alag signals/timeframes ka combined view hai — jitne zyada agree karein, utna zyada "robust" hai. Lekin koi bhi combination guarantee nahi deta. Real accuracy jaanne ke liye !backtest ${rawInput} try karein — wahi is pair ka asli historical number dega.`
  );

  return lines.join('\n');
}

module.exports = {
  analyzePair, quickSignal, predictAllDurations, fullHistoryAnalysis,
  getKeyLevelsWithStats, backtestMethod, crossPairConfirmation, getSessionInfo,
  masterAnalysis, normalizePair, isForexMarketLikelyClosed, fetchQuote,
};
