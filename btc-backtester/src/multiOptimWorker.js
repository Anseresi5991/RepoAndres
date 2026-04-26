/**
 * Web Worker — Análisis Múltiple entre los 200 mejores
 * Recibe: top200 (combos del Análisis Profundo), candles, params (shared)
 * Genera grupos aleatorios de 2 y 3 combos, corre multiBacktest simplificado,
 * guarda top 60 por Score = Neto% / Drawdown%
 */

function ema(values, period) {
  const k = 2 / (period + 1)
  const result = new Array(values.length).fill(null)
  let prevEma = null
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) { result[i] = null; continue }
    if (prevEma === null) {
      let sum = 0
      for (let j = i - period + 1; j <= i; j++) sum += values[j]
      prevEma = sum / period
      result[i] = prevEma
    } else {
      prevEma = values[i] * k + prevEma * (1 - k)
      result[i] = prevEma
    }
  }
  return result
}

function highest(arr, period, idx) {
  let max = -Infinity
  for (let i = Math.max(0, idx - period + 1); i <= idx; i++) {
    if (arr[i] > max) max = arr[i]
  }
  return max
}

function lowest(arr, period, idx) {
  let min = Infinity
  for (let i = Math.max(0, idx - period + 1); i <= idx; i++) {
    if (arr[i] < min) min = arr[i]
  }
  return min
}

function getUTCDay(dateStr) {
  return new Date(dateStr).toISOString().substring(0, 10)
}

/**
 * Versión simplificada de multiBacktest para optimización.
 * No guarda trades/signals/MAE para mayor velocidad.
 */
function runMultiBacktestLite(candles, combos, shared, closes, highs, lows, opens, ema10arr, ema50arr) {
  const { feeSlPct, feeTpPct, leverage, initialCapital, emaMinGapPct = 0 } = shared

  const states = combos.map(() => ({
    activeRangeTop: null,
    firstRangeTouchDone: false,
    prevIsTightRange: false,
  }))

  let dailySignalUsed = false
  let currentDay = null
  let openTrades = []

  let totalTp = 0, totalSl = 0, totalClosed = 0
  let totalProfitPct = 0, totalLossPct = 0, totalNetPct = 0
  let equityPct = 0, equityPeakPct = 0, maxDrawdownPct = 0
  let compoundCapital = initialCapital

  for (let i = 0; i < candles.length; i++) {
    const high = highs[i], low = lows[i], close = closes[i], open = opens[i]

    const day = getUTCDay(candles[i].OpenTime)
    if (day !== currentDay) { currentDay = day; dailySignalUsed = false }

    const _emaGap = (ema10arr[i] !== null && ema50arr[i] !== null && ema50arr[i] > 0)
      ? (ema50arr[i] - ema10arr[i]) / ema50arr[i] * 100 : 0
    const isBearishTrend = ema10arr[i] !== null && ema50arr[i] !== null
      ? ema10arr[i] < ema50arr[i] && _emaGap >= emaMinGapPct : false

    const candleRange = high - low
    const upperWick = high - Math.max(open, close)
    const upperWickPct = candleRange > 0 ? (upperWick / candleRange) * 100 : 0

    // Cerrar trades abiertos
    const stillOpen = []
    for (const t of openTrades) {
      if (low <= t.tp) {
        totalTp++; totalClosed++
        totalProfitPct += t.effectiveTpPct
        equityPct += t.effectiveTpPct
        equityPeakPct = Math.max(equityPeakPct, equityPct)
        maxDrawdownPct = Math.max(maxDrawdownPct, equityPeakPct - equityPct)
        compoundCapital = compoundCapital * (1 + t.effectiveTpPct / 100)
      } else if (high >= t.sl) {
        totalSl++; totalClosed++
        totalLossPct += t.effectiveSlPct
        equityPct -= t.effectiveSlPct
        equityPeakPct = Math.max(equityPeakPct, equityPct)
        maxDrawdownPct = Math.max(maxDrawdownPct, equityPeakPct - equityPct)
        compoundCapital = compoundCapital * (1 - t.effectiveSlPct / 100)
      } else {
        stillOpen.push(t)
      }
    }
    openTrades = stillOpen
    totalNetPct = totalProfitPct - totalLossPct

    // Evaluar todos los combos — gana el primero que dispare
    let firedCi = -1

    for (let ci = 0; ci < combos.length; ci++) {
      const combo = combos[ci]
      const state = states[ci]

      const highestPrice = highest(highs, combo.lookbackCandles, i)
      const lowestPrice  = lowest(lows,  combo.lookbackCandles, i)
      const rangeUsd = highestPrice - lowestPrice
      const rangePct = close !== 0 ? (rangeUsd / close) * 100 : 0

      const isTightRange = rangePct >= combo.minRangePct && rangePct <= combo.maxRangePct
      const newRangeStarted = isTightRange && !state.prevIsTightRange

      if (newRangeStarted) { state.activeRangeTop = highestPrice; state.firstRangeTouchDone = false }
      if (!isTightRange)   { state.activeRangeTop = null; state.firstRangeTouchDone = false }

      const touchRangeTop =
        isTightRange && !state.firstRangeTouchDone && state.activeRangeTop !== null &&
        high >= state.activeRangeTop && candleRange > 0 && upperWickPct >= combo.minWickPct

      const fired = touchRangeTop && isBearishTrend

      if (fired && !dailySignalUsed && firedCi === -1) {
        firedCi = ci
      }

      state.prevIsTightRange = isTightRange
    }

    if (firedCi !== -1) {
      dailySignalUsed = true
      states[firedCi].firstRangeTouchDone = true
      const combo = combos[firedCi]
      const ep = close
      openTrades.push({
        price: ep,
        sl: ep * (1 + combo.slPct / 100),
        tp: ep * (1 - combo.tpPct / 100),
        effectiveTpPct: Math.max(combo.tpPct - feeTpPct, 0) * leverage,
        effectiveSlPct: (combo.slPct + feeSlPct) * leverage,
      })
    }
  }

  const winRate = totalClosed > 0 ? (totalTp / totalClosed) * 100 : 0
  return {
    totalTp, totalSl, totalClosed,
    totalNetPct:    totalNetPct.toFixed(2),
    winRate:        winRate.toFixed(2),
    maxDrawdownPct: maxDrawdownPct.toFixed(2),
    compoundCapital: compoundCapital.toFixed(2),
  }
}

function randomInt(max) {
  return Math.floor(Math.random() * max)
}

function pickDistinct(n, max) {
  const picked = []
  while (picked.length < n) {
    const v = randomInt(max)
    if (!picked.includes(v)) picked.push(v)
  }
  return picked
}

function insertTop(topResults, candidate, topN) {
  if (topResults.length < topN) {
    topResults.push(candidate)
    topResults.sort((a, b) => b._score - a._score)
  } else if (candidate._score > topResults[topN - 1]._score) {
    topResults[topN - 1] = candidate
    topResults.sort((a, b) => b._score - a._score)
  }
}

// ── Entrada del Worker ──
self.onmessage = function (e) {
  const { topCombos, candles, params } = e.data

  try {
    if (!topCombos || topCombos.length < 2) {
      self.postMessage({ type: 'error', message: 'Se necesitan al menos 2 combos para el análisis múltiple' })
      return
    }
    const top200 = topCombos

    const closes  = candles.map(c => parseFloat(c.CloseCandle))
    const highs   = candles.map(c => parseFloat(c.HighCandle))
    const lows    = candles.map(c => parseFloat(c.LowCandle))
    const opens   = candles.map(c => parseFloat(c.OpenCandle))
    const ema10arr = ema(closes, 10)
    const ema50arr = ema(closes, 50)

    const shared = {
      feeSlPct:       params.feeSlPct,
      feeTpPct:       params.feeTpPct,
      leverage:       params.leverage,
      initialCapital: params.initialCapital,
      emaMinGapPct:   params.emaMinGapPct || 0,
    }

    const N = top200.length
    const N_PAIRS    = Math.min(3000, N >= 2 ? N * (N - 1) / 2 : 0)
    const N_TRIPLETS = N >= 3 ? Math.min(3000, Math.floor(N * (N - 1) * (N - 2) / 6)) : 0
    const total = N_PAIRS + N_TRIPLETS
    const TOP_N = 60
    const REPORT_EVERY = Math.max(50, Math.floor(total / 100))

    let topResults = []
    let done = 0

    // ── Pares ──
    for (let n = 0; n < N_PAIRS; n++) {
      const [i, j] = pickDistinct(2, N)
      const combos = [top200[i], top200[j]]

      const bt = runMultiBacktestLite(candles, combos, shared, closes, highs, lows, opens, ema10arr, ema50arr)
      const net = parseFloat(bt.totalNetPct)
      const dd  = parseFloat(bt.maxDrawdownPct)

      if (bt.totalClosed >= 3 && net > 0 && dd <= 50) {
        const score = net / Math.max(dd, 0.1)
        insertTop(topResults, {
          size: 2,
          combos: [{ idx: top200.indexOf(top200[i]), ...top200[i] }, { idx: top200.indexOf(top200[j]), ...top200[j] }],
          ...bt,
          _score: score,
        }, TOP_N)
      }

      done++
      if (done % REPORT_EVERY === 0) {
        self.postMessage({ type: 'progress', done, total, topResults: topResults.slice() })
      }
    }

    // ── Tríos ──
    for (let n = 0; n < N_TRIPLETS; n++) {
      const [i, j, k] = pickDistinct(3, N)
      const combos = [top200[i], top200[j], top200[k]]

      const bt = runMultiBacktestLite(candles, combos, shared, closes, highs, lows, opens, ema10arr, ema50arr)
      const net = parseFloat(bt.totalNetPct)
      const dd  = parseFloat(bt.maxDrawdownPct)

      if (bt.totalClosed >= 3 && net > 0 && dd <= 50) {
        const score = net / Math.max(dd, 0.1)
        insertTop(topResults, {
          size: 3,
          combos: [
            { idx: top200.indexOf(top200[i]), ...top200[i] },
            { idx: top200.indexOf(top200[j]), ...top200[j] },
            { idx: top200.indexOf(top200[k]), ...top200[k] },
          ],
          ...bt,
          _score: score,
        }, TOP_N)
      }

      done++
      if (done % REPORT_EVERY === 0) {
        self.postMessage({ type: 'progress', done, total, topResults: topResults.slice() })
      }
    }

    self.postMessage({ type: 'done', results: topResults })
  } catch (err) {
    self.postMessage({ type: 'error', message: err.message })
  }
}
