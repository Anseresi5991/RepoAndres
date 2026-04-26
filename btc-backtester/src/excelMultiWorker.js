/**
 * Web Worker — Análisis Multi-Combo desde Excel
 * Recibe: { combos, candles, params, groupSizes, samplesPerSize }
 * groupSizes: ej. [3,4,5,6,7]
 * samplesPerSize: muestras aleatorias por tamaño de grupo (ej. 5000)
 * Guarda top 60 por Score = Neto% / max(Drawdown%, 0.1)
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

// Pre-computa highest/lowest para todos los lookbacks únicos del conjunto de combos
function precomputeWindows(highs, lows, uniqueLookbacks) {
  const highestByLb = {}
  const lowestByLb  = {}
  const N = highs.length
  for (const lb of uniqueLookbacks) {
    const h = new Float64Array(N)
    const l = new Float64Array(N)
    for (let i = 0; i < N; i++) {
      let max = -Infinity, min = Infinity
      const start = i - lb + 1 > 0 ? i - lb + 1 : 0
      for (let j = start; j <= i; j++) {
        if (highs[j] > max) max = highs[j]
        if (lows[j]  < min) min = lows[j]
      }
      h[i] = max
      l[i] = min
    }
    highestByLb[lb] = h
    lowestByLb[lb]  = l
  }
  return { highestByLb, lowestByLb }
}

function runMultiBacktestLite(candles, combos, shared, closes, highs, lows, opens, ema10arr, ema50arr, isNewDay, highestByLb, lowestByLb) {
  const { feeSlPct, feeTpPct, leverage, initialCapital, emaMinGapPct = 0 } = shared
  const N = candles.length

  const states = combos.map(() => ({
    activeRangeTop: 0,
    hasActiveRange: false,
    firstTouchDone: false,
    prevIsTight: false,
  }))

  let dailySignalUsed = false
  let openTrades = []

  let totalTp = 0, totalSl = 0, totalClosed = 0
  let totalProfitPct = 0, totalLossPct = 0
  let equityPct = 0, equityPeakPct = 0, maxDrawdownPct = 0
  let compoundCapital = initialCapital

  for (let i = 0; i < N; i++) {
    if (isNewDay[i]) dailySignalUsed = false

    const high = highs[i], low = lows[i], close = closes[i], open = opens[i]
    const _emaGap = (ema10arr[i] !== null && ema50arr[i] !== null && ema50arr[i] > 0)
      ? (ema50arr[i] - ema10arr[i]) / ema50arr[i] * 100 : 0
    const isBearishTrend = ema10arr[i] !== null && ema50arr[i] !== null && ema10arr[i] < ema50arr[i] && _emaGap >= emaMinGapPct
    const candleRange = high - low
    const upperWickPct = candleRange > 0 ? (high - Math.max(open, close)) / candleRange * 100 : 0

    // Cerrar trades abiertos
    const stillOpen = []
    for (const t of openTrades) {
      if (low <= t.tp) {
        totalTp++; totalClosed++
        totalProfitPct += t.effTp
        equityPct += t.effTp
        equityPeakPct = Math.max(equityPeakPct, equityPct)
        maxDrawdownPct = Math.max(maxDrawdownPct, equityPeakPct - equityPct)
        compoundCapital *= (1 + t.effTp / 100)
      } else if (high >= t.sl) {
        totalSl++; totalClosed++
        totalLossPct += t.effSl
        equityPct -= t.effSl
        equityPeakPct = Math.max(equityPeakPct, equityPct)
        maxDrawdownPct = Math.max(maxDrawdownPct, equityPeakPct - equityPct)
        compoundCapital *= (1 - t.effSl / 100)
      } else {
        stillOpen.push(t)
      }
    }
    openTrades = stillOpen

    if (!dailySignalUsed && isBearishTrend) {
      for (let ci = 0; ci < combos.length; ci++) {
        const combo = combos[ci]
        const state = states[ci]

        const highestPrice = highestByLb[combo.lookbackCandles][i]
        const lowestPrice  = lowestByLb[combo.lookbackCandles][i]
        const rangePct = close !== 0 ? (highestPrice - lowestPrice) / close * 100 : 0
        const isTight = rangePct >= combo.minRangePct && rangePct <= combo.maxRangePct

        if (isTight && !state.prevIsTight) { state.activeRangeTop = highestPrice; state.hasActiveRange = true; state.firstTouchDone = false }
        if (!isTight) { state.hasActiveRange = false; state.firstTouchDone = false }

        const touchTop = isTight && !state.firstTouchDone && state.hasActiveRange &&
          high >= state.activeRangeTop && candleRange > 0 && upperWickPct >= combo.minWickPct

        if (touchTop) {
          state.firstTouchDone = true
          dailySignalUsed = true
          const effTp = Math.max(combo.tpPct - feeTpPct, 0) * leverage
          const effSl = (combo.slPct + feeSlPct) * leverage
          openTrades.push({ sl: close * (1 + combo.slPct / 100), tp: close * (1 - combo.tpPct / 100), effTp, effSl })
          break // solo 1 señal por día
        }

        state.prevIsTight = isTight
      }
      // actualizar prevIsTight para combos que no dispararon
      for (let ci = 0; ci < combos.length; ci++) {
        const combo = combos[ci]
        const state = states[ci]
        if (!dailySignalUsed || state.firstTouchDone) continue
        const highestPrice = highestByLb[combo.lookbackCandles][i]
        const lowestPrice  = lowestByLb[combo.lookbackCandles][i]
        const rangePct = close !== 0 ? (highestPrice - lowestPrice) / close * 100 : 0
        state.prevIsTight = rangePct >= combo.minRangePct && rangePct <= combo.maxRangePct
      }
    } else {
      // Actualizar prevIsTight para todos
      for (let ci = 0; ci < combos.length; ci++) {
        const combo = combos[ci]
        const state = states[ci]
        const highestPrice = highestByLb[combo.lookbackCandles][i]
        const lowestPrice  = lowestByLb[combo.lookbackCandles][i]
        const rangePct = close !== 0 ? (highestPrice - lowestPrice) / close * 100 : 0
        const isTight = rangePct >= combo.minRangePct && rangePct <= combo.maxRangePct
        if (isTight && !state.prevIsTight) { state.activeRangeTop = highestPrice; state.hasActiveRange = true; state.firstTouchDone = false }
        if (!isTight) { state.hasActiveRange = false; state.firstTouchDone = false }
        state.prevIsTight = isTight
      }
    }
  }

  const totalNetPct = totalProfitPct - totalLossPct
  const winRate = totalClosed > 0 ? (totalTp / totalClosed) * 100 : 0
  return {
    totalTp, totalSl, totalClosed,
    totalNetPct:     totalNetPct.toFixed(2),
    winRate:         winRate.toFixed(2),
    maxDrawdownPct:  maxDrawdownPct.toFixed(2),
    compoundCapital: compoundCapital.toFixed(2),
  }
}

function pickDistinct(n, max) {
  const picked = new Set()
  while (picked.size < n) picked.add(Math.floor(Math.random() * max))
  return [...picked]
}

// ── Entrada del Worker ──
self.onmessage = function (e) {
  const { combos, candles, params, groupSizes = [3,4,5,6,7], samplesPerSize = 5000 } = e.data

  try {
    if (!combos || combos.length < 3) {
      self.postMessage({ type: 'error', message: 'Se necesitan al menos 3 combos cargados' })
      return
    }

    const N = candles.length
    const closes = new Float64Array(N)
    const highs  = new Float64Array(N)
    const lows   = new Float64Array(N)
    const opens  = new Float64Array(N)
    for (let i = 0; i < N; i++) {
      closes[i] = parseFloat(candles[i].CloseCandle)
      highs[i]  = parseFloat(candles[i].HighCandle)
      lows[i]   = parseFloat(candles[i].LowCandle)
      opens[i]  = parseFloat(candles[i].OpenCandle)
    }

    const ema10arr = ema(closes, 10)
    const ema50arr = ema(closes, 50)

    // Pre-computo isNewDay
    const isNewDay = new Uint8Array(N)
    isNewDay[0] = 1
    for (let i = 1; i < N; i++) {
      isNewDay[i] = candles[i].OpenTime.substring(0, 10) !== candles[i - 1].OpenTime.substring(0, 10) ? 1 : 0
    }

    // Pre-computo ventanas sliding
    const uniqueLookbacks = [...new Set(combos.map(c => c.lookbackCandles))]
    const { highestByLb, lowestByLb } = precomputeWindows(highs, lows, uniqueLookbacks)

    const shared = {
      feeSlPct:       params.feeSlPct,
      feeTpPct:       params.feeTpPct,
      leverage:       params.leverage,
      initialCapital: params.initialCapital,
      emaMinGapPct:   params.emaMinGapPct || 0,
    }

    // Calcular total de evaluaciones
    const M = combos.length
    const validSizes = groupSizes.filter(s => s <= M)
    const total = validSizes.reduce((sum, s) => {
      const maxPossible = factorial_approx_enough(M, s)
      return sum + Math.min(samplesPerSize, maxPossible)
    }, 0)

    const REPORT_EVERY = Math.max(50, Math.floor(total / 100))
    let allResults = []
    let done = 0

    for (const size of validSizes) {
      const maxCombinations = approxCombinations(M, size)
      const samples = Math.min(samplesPerSize, maxCombinations)

      for (let n = 0; n < samples; n++) {
        const indices = pickDistinct(size, M)
        const group = indices.map(idx => combos[idx])

        const bt = runMultiBacktestLite(candles, group, shared, closes, highs, lows, opens, ema10arr, ema50arr, isNewDay, highestByLb, lowestByLb)
        const net = parseFloat(bt.totalNetPct)
        const dd  = parseFloat(bt.maxDrawdownPct)

        if (bt.totalClosed >= 3 && net > 0 && dd <= 50) {
          const score = net / Math.max(dd, 0.1)
          allResults.push({
            size,
            combos: indices.map(idx => ({ idx, ...combos[idx] })),
            ...bt,
            _score: score,
          })
        }

        done++
        if (done % REPORT_EVERY === 0) {
          const sorted = allResults.slice().sort((a, b) => b._score - a._score)
          self.postMessage({ type: 'progress', done, total, topResults: sorted })
        }
      }
    }

    allResults.sort((a, b) => b._score - a._score)
    self.postMessage({ type: 'done', results: allResults })
  } catch (err) {
    self.postMessage({ type: 'error', message: err.message })
  }
}

function approxCombinations(n, k) {
  if (k > n) return 0
  if (k === 0 || k === n) return 1
  let result = 1
  for (let i = 0; i < k; i++) {
    result = result * (n - i) / (i + 1)
    if (result > 1e9) return 1e9 // cap para no desbordar
  }
  return Math.round(result)
}

function factorial_approx_enough(n, k) {
  return approxCombinations(n, k)
}
