/**
 * Web Worker — Análisis Profundo Rango + Soporte
 *
 * Lógica idéntica al optimWorker.js pero para LONG (soporte del rango).
 * Detecta mecha INFERIOR tocando el mínimo del rango con EMA10 > EMA50.
 *
 * Entrada:  { candles, optimRanges, params }
 * Salida:   postMessage({ type: 'progress'|'done'|'error', ... })
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

function rangeValues(min, max, step) {
  const vals = []
  const s = parseFloat(step)
  if (s <= 0) return [parseFloat(min)]
  for (let v = parseFloat(min); v <= parseFloat(max) + 1e-9; v += s)
    vals.push(parseFloat(v.toFixed(6)))
  return vals
}

self.onmessage = function (e) {
  const { candles, optimRanges, params, lookbackSubset } = e.data

  try {
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

    // Pre-cómputo: cambio de día UTC
    const isNewDay = new Uint8Array(N)
    isNewDay[0] = 1
    for (let i = 1; i < N; i++) {
      isNewDay[i] = candles[i].OpenTime.substring(0, 10) !== candles[i - 1].OpenTime.substring(0, 10) ? 1 : 0
    }

    // Pre-cómputo: tendencia ALCISTA (EMA10 > EMA50) y mecha INFERIOR
    const isBullish     = new Uint8Array(N)
    const wickPct       = new Float64Array(N)  // mecha inferior como % del rango de vela
    const candleRanges  = new Float64Array(N)
    for (let i = 0; i < N; i++) {
      const _gap = (ema10arr[i] !== null && ema50arr[i] !== null && ema10arr[i] > 0)
        ? (ema10arr[i] - ema50arr[i]) / ema10arr[i] * 100 : 0
      isBullish[i] = (ema10arr[i] !== null && ema50arr[i] !== null &&
        ema10arr[i] > ema50arr[i] && _gap >= (params.emaMinGapPct || 0)) ? 1 : 0
      const cr = highs[i] - lows[i]
      candleRanges[i] = cr
      wickPct[i] = cr > 0 ? (Math.min(opens[i], closes[i]) - lows[i]) / cr * 100 : 0
    }

    const minRanges = rangeValues(optimRanges.minRangePct.min,     optimRanges.minRangePct.max,     optimRanges.minRangePct.step)
    const maxRanges = rangeValues(optimRanges.maxRangePct.min,     optimRanges.maxRangePct.max,     optimRanges.maxRangePct.step)
    const lookbacks = lookbackSubset ?? rangeValues(optimRanges.lookbackCandles.min, optimRanges.lookbackCandles.max, optimRanges.lookbackCandles.step).map(v => Math.round(v))
    const minWicks  = rangeValues(optimRanges.minWickPct.min,      optimRanges.minWickPct.max,      optimRanges.minWickPct.step)
    const sls       = rangeValues(optimRanges.slPct.min,           optimRanges.slPct.max,           optimRanges.slPct.step)
    const tps       = rangeValues(optimRanges.tpPct.min,           optimRanges.tpPct.max,           optimRanges.tpPct.step)

    const total = minRanges.length * maxRanges.length * lookbacks.length * minWicks.length * sls.length * tps.length
    const REPORT_EVERY = Math.max(500, Math.floor(total / 200))
    const TOP_PER_RANGE = 5
    const rangeMap = new Map()
    let done = 0

    function flattenRangeMap() {
      const all = []
      for (const bucket of rangeMap.values()) for (const c of bucket) all.push(c)
      all.sort((a, b) => b._score - a._score)
      return all
    }

    // Pre-cómputo de highest/lowest por cada lookback único
    const uniqueLookbacks = [...new Set(lookbacks)]
    const highestByLb = {}
    const lowestByLb  = {}
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

    const { feeSlPct, feeTpPct, leverage, initialCapital } = params

    for (const lb of lookbacks) {
      const highestArr = highestByLb[lb]
      const lowestArr  = lowestByLb[lb]

      for (const minR of minRanges) {
        for (const maxR of maxRanges) {
          if (maxR <= minR) {
            done += minWicks.length * sls.length * tps.length
            continue
          }

          for (const mw of minWicks) {
            for (const sl of sls) {
              for (const tp of tps) {

                const effTp = Math.max(tp - feeTpPct, 0) * leverage
                const effSl = (sl + feeSlPct) * leverage

                let activeRangeBottom = 0
                let hasActiveRange    = false
                let firstTouchDone    = false
                let prevIsTight       = false
                let dailySignalUsed   = false
                let openTrades        = []

                let totalTp = 0, totalSl = 0, totalClosed = 0
                let profitPct = 0, lossPct = 0
                let equityPct = 0, equityPeak = 0, maxDd = 0
                let capital = initialCapital

                for (let i = 0; i < N; i++) {
                  if (maxDd > 30) break
                  if (isNewDay[i]) dailySignalUsed = false

                  const lowestPrice  = lowestArr[i]
                  const highestPrice = highestArr[i]
                  const close        = closes[i]
                  const rangePct     = close !== 0 ? (highestPrice - lowestPrice) / close * 100 : 0

                  const isTight  = rangePct >= minR && rangePct <= maxR
                  const newRange = isTight && !prevIsTight

                  if (newRange)  { activeRangeBottom = lowestPrice; hasActiveRange = true; firstTouchDone = false }
                  if (!isTight)  { hasActiveRange = false; firstTouchDone = false }

                  const high = highs[i], low = lows[i]

                  // Toca el mínimo del rango con mecha inferior
                  const touchBottom =
                    isTight && !firstTouchDone && hasActiveRange &&
                    low <= activeRangeBottom && candleRanges[i] > 0 && wickPct[i] >= mw

                  if (touchBottom) firstTouchDone = true

                  const signal = touchBottom && !dailySignalUsed && isBullish[i]

                  // Cerrar trades abiertos (LONG: TP arriba, SL abajo)
                  const stillOpen = []
                  for (let t = 0; t < openTrades.length; t++) {
                    const tr = openTrades[t]
                    if (high >= tr.tp) {
                      totalTp++; totalClosed++
                      profitPct += effTp
                      equityPct += effTp
                      if (equityPct > equityPeak) equityPeak = equityPct
                      const dd = equityPeak - equityPct
                      if (dd > maxDd) maxDd = dd
                      capital *= (1 + effTp / 100)
                    } else if (low <= tr.sl) {
                      totalSl++; totalClosed++
                      lossPct  += effSl
                      equityPct -= effSl
                      if (equityPct > equityPeak) equityPeak = equityPct
                      const dd = equityPeak - equityPct
                      if (dd > maxDd) maxDd = dd
                      capital *= (1 - effSl / 100)
                    } else {
                      stillOpen.push(tr)
                    }
                  }
                  openTrades = stillOpen

                  if (signal) {
                    dailySignalUsed = true
                    // LONG: TP arriba, SL abajo
                    openTrades.push({ tp: close * (1 + tp / 100), sl: close * (1 - sl / 100) })
                  }

                  prevIsTight = isTight
                }

                const netPct = profitPct - lossPct

                if (totalClosed >= 3 && netPct > 0 && maxDd <= 30) {
                  const score = netPct / (maxDd < 0.1 ? 0.1 : maxDd)
                  const candidate = {
                    minRangePct: minR, maxRangePct: maxR,
                    lookbackCandles: lb, minWickPct: mw,
                    slPct: sl, tpPct: tp,
                    totalTp, totalSl, totalClosed,
                    totalProfitPct: profitPct.toFixed(2),
                    totalLossPct:   lossPct.toFixed(2),
                    totalNetPct:    netPct.toFixed(2),
                    winRate:        (totalTp / totalClosed * 100).toFixed(2),
                    maxDrawdownPct: maxDd.toFixed(2),
                    compoundCapital: capital.toFixed(2),
                    _score: score,
                  }
                  const rangeKey = `${minR}|${maxR}`
                  if (!rangeMap.has(rangeKey)) rangeMap.set(rangeKey, [])
                  const bucket = rangeMap.get(rangeKey)
                  if (bucket.length < TOP_PER_RANGE) {
                    bucket.push(candidate)
                    bucket.sort((a, b) => b._score - a._score)
                  } else if (score > bucket[TOP_PER_RANGE - 1]._score) {
                    bucket[TOP_PER_RANGE - 1] = candidate
                    bucket.sort((a, b) => b._score - a._score)
                  }
                }

                done++
                if (done % REPORT_EVERY === 0) {
                  self.postMessage({ type: 'progress', done, total, topResults: flattenRangeMap() })
                }
              }
            }
          }
        }
      }
    }

    self.postMessage({ type: 'done', results: flattenRangeMap() })
  } catch (err) {
    self.postMessage({ type: 'error', message: err.message })
  }
}
