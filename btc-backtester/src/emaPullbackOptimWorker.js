/**
 * Web Worker — Análisis Profundo EMA Pullback
 *
 * Optimiza sobre: tpPct × slPct × emaFast × rsiMin
 * EMA lenta, RSI y VolMA se pre-computan una sola vez.
 * EMA rápida varía → se recalcula solo cuando cambia emaFast.
 *
 * Entrada:  { candles, optimRanges, params }
 * Salida:   postMessage({ type: 'progress'|'done'|'error', ... })
 */

function computeEMA(values, period) {
  const k = 2 / (period + 1)
  const N = values.length
  const result = new Float64Array(N).fill(NaN)
  let prev = null, warmup = 0, warmupSum = 0
  for (let i = 0; i < N; i++) {
    if (prev === null) {
      warmupSum += values[i]; warmup++
      if (warmup === period) { prev = warmupSum / period; result[i] = prev }
    } else {
      prev = values[i] * k + prev * (1 - k); result[i] = prev
    }
  }
  return result
}

function computeRSI(closes, period) {
  const N = closes.length
  const result = new Float64Array(N).fill(NaN)
  if (N < period + 1) return result
  let avgGain = 0, avgLoss = 0
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1]
    if (d > 0) avgGain += d; else avgLoss -= d
  }
  avgGain /= period; avgLoss /= period
  result[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss)
  for (let i = period + 1; i < N; i++) {
    const d = closes[i] - closes[i - 1]
    const g = d > 0 ? d : 0; const l = d < 0 ? -d : 0
    avgGain = (avgGain * (period - 1) + g) / period
    avgLoss = (avgLoss * (period - 1) + l) / period
    result[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss)
  }
  return result
}

function computeSMA(values, period) {
  const N = values.length
  const result = new Float64Array(N).fill(NaN)
  let sum = 0
  for (let i = 0; i < N; i++) {
    sum += values[i]
    if (i >= period) sum -= values[i - period]
    if (i >= period - 1) result[i] = sum / period
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
  const { candles, optimRanges, params } = e.data

  try {
    const {
      emaSlow         = 55,
      rsiPeriod       = 14,
      volMAPeriod     = 20,
      volMultiplier   = 1.5,
      useVolumeFilter = true,
      feeTpPct        = 0.05,
      feeSlPct        = 0.10,
      leverage        = 1,
      tradeDirection  = 'both',
    } = params

    const N = candles.length
    const closes  = new Float64Array(N)
    const highs   = new Float64Array(N)
    const lows    = new Float64Array(N)
    const volumes = new Float64Array(N)
    for (let i = 0; i < N; i++) {
      closes[i]  = parseFloat(candles[i].CloseCandle)
      highs[i]   = parseFloat(candles[i].HighCandle)
      lows[i]    = parseFloat(candles[i].LowCandle)
      volumes[i] = parseFloat(candles[i].Volume)
    }

    // Pre-computar indicadores fijos
    const emaSlowArr = computeEMA(closes, emaSlow)
    const rsiArr     = computeRSI(closes, rsiPeriod)
    const volMAArr   = computeSMA(volumes, volMAPeriod)

    const canLong  = tradeDirection === 'both' || tradeDirection === 'long'
    const canShort = tradeDirection === 'both' || tradeDirection === 'short'

    const emaFastVals = rangeValues(optimRanges.emaFast.min, optimRanges.emaFast.max, optimRanges.emaFast.step).map(v => Math.round(v))
    const rsiMinVals  = rangeValues(optimRanges.rsiMin.min,  optimRanges.rsiMin.max,  optimRanges.rsiMin.step)
    const tpVals      = rangeValues(optimRanges.tpPct.min,   optimRanges.tpPct.max,   optimRanges.tpPct.step)
    const slVals      = rangeValues(optimRanges.slPct.min,   optimRanges.slPct.max,   optimRanges.slPct.step)

    const total = emaFastVals.length * rsiMinVals.length * tpVals.length * slVals.length
    const REPORT_EVERY = Math.max(10, Math.floor(total / 200))

    let done = 0
    let topResults = []

    for (const emaFast of emaFastVals) {
      // Recalcular EMA rápida solo cuando cambia
      const emaFastArr = computeEMA(closes, emaFast)

      // Pre-computar valid[] y cruces para este emaFast
      const valid      = new Uint8Array(N)
      const longCross  = new Uint8Array(N)
      const shortCross = new Uint8Array(N)
      const uptrend    = new Uint8Array(N)
      const downtrend  = new Uint8Array(N)

      for (let i = 2; i < N; i++) {
        if (
          isNaN(emaFastArr[i]) || isNaN(emaFastArr[i - 1]) ||
          isNaN(emaSlowArr[i]) ||
          isNaN(rsiArr[i])     ||
          isNaN(volMAArr[i])
        ) continue
        valid[i] = 1

        const highVol = !useVolumeFilter || volumes[i] > volMAArr[i] * volMultiplier

        uptrend[i]  = emaFastArr[i] > emaSlowArr[i] ? 1 : 0
        downtrend[i] = emaFastArr[i] < emaSlowArr[i] ? 1 : 0

        // Cruce hacia arriba (longCross) y hacia abajo (shortCross)
        longCross[i]  = (closes[i - 1] < emaFastArr[i - 1] && closes[i] > emaFastArr[i] && highVol) ? 1 : 0
        shortCross[i] = (closes[i - 1] > emaFastArr[i - 1] && closes[i] < emaFastArr[i] && highVol) ? 1 : 0
      }

      for (const rsiMin of rsiMinVals) {
        const rsiMax = 100 - rsiMin  // simétrico: si rsiMin=40 → rsiMax=60

        for (const tp of tpVals) {
          const effTp = Math.max(tp - feeTpPct, 0) * leverage

          for (const sl of slVals) {
            const effSl = (sl + feeSlPct) * leverage

            let inTrade = false, isLong = false
            let tpPr = 0, slPr = 0
            let totalTp = 0, totalSl = 0, totalClosed = 0
            let profitPct = 0, lossPct = 0
            let eqPct = 0, eqPeak = 0, maxDrawdown = 0
            let compound = 1.0

            for (let i = 2; i < N; i++) {
              if (!valid[i]) continue
              const close = closes[i]
              const high  = highs[i]
              const low   = lows[i]

              let tpHit = false, slHit = false
              if (inTrade) {
                tpHit = isLong  ? high >= tpPr : low  <= tpPr
                slHit = !tpHit && (isLong ? low <= slPr : high >= slPr)
              }

              if (tpHit || slHit) {
                const win = tpHit
                if (win) { totalTp++; profitPct += effTp; eqPct += effTp }
                else     { totalSl++; lossPct   += effSl; eqPct -= effSl }
                totalClosed++
                eqPeak      = Math.max(eqPeak, eqPct)
                maxDrawdown = Math.max(maxDrawdown, eqPeak - eqPct)
                compound    = win ? compound * (1 + effTp / 100) : compound * (1 - effSl / 100)
                inTrade = false
              }

              if (!inTrade) {
                const rsiOk = rsiArr[i] >= rsiMin && rsiArr[i] <= rsiMax

                const goLong  = canLong  && uptrend[i]   && longCross[i]  && rsiOk
                const goShort = canShort && downtrend[i] && shortCross[i] && rsiOk

                if (goLong || goShort) {
                  inTrade = true; isLong = goLong
                  tpPr = isLong ? close * (1 + tp / 100) : close * (1 - tp / 100)
                  slPr = isLong ? close * (1 - sl / 100) : close * (1 + sl / 100)
                }
              }
            }

            const netPct  = profitPct - lossPct
            const winRate = totalClosed > 0 ? (totalTp / totalClosed) * 100 : 0
            const score   = totalClosed >= 5 && netPct > 0
              ? netPct / Math.max(maxDrawdown, 0.1)
              : -Infinity

            if (score > -Infinity) {
              topResults.push({
                emaFast,
                rsiMin,
                rsiMax,
                tpPct:          tp,
                slPct:          sl,
                totalTp,
                totalSl,
                totalClosed,
                totalNetPct:    netPct.toFixed(2),
                winRate:        winRate.toFixed(2),
                maxDrawdownPct: maxDrawdown.toFixed(2),
                compoundFactor: compound.toFixed(4),
                _score:         score,
              })
              if (topResults.length > 600) {
                topResults.sort((a, b) => b._score - a._score)
                topResults = topResults.slice(0, 400)
              }
            }

            done++
            if (done % REPORT_EVERY === 0) {
              const sorted = topResults.slice().sort((a, b) => b._score - a._score)
              self.postMessage({ type: 'progress', done, total, topResults: sorted.slice(0, 400) })
            }
          }
        }
      }
    }

    topResults.sort((a, b) => b._score - a._score)
    self.postMessage({ type: 'done', results: topResults.slice(0, 400) })

  } catch (err) {
    self.postMessage({ type: 'error', message: err.message })
  }
}
