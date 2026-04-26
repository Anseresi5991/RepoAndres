/**
 * Web Worker — Análisis Profundo Confluencia
 *
 * Optimiza sobre: tpPct × slPct × confluencesRequired × rsiOverbought
 * Los indicadores (EMA, MACD, BB, VolMA) se pre-computan una sola vez.
 * El RSI también se pre-computa; solo varía el umbral de comparación.
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

function computeMACD(closes, fastP, slowP, signalP) {
  const emaFast = computeEMA(closes, fastP)
  const emaSlow = computeEMA(closes, slowP)
  const N = closes.length
  const macdLine   = new Float64Array(N).fill(NaN)
  const signalLine = new Float64Array(N).fill(NaN)
  for (let i = 0; i < N; i++) {
    if (!isNaN(emaFast[i]) && !isNaN(emaSlow[i])) macdLine[i] = emaFast[i] - emaSlow[i]
  }
  const k = 2 / (signalP + 1)
  let prev = null, warmup = 0, warmupSum = 0
  for (let i = 0; i < N; i++) {
    if (isNaN(macdLine[i])) continue
    if (prev === null) {
      warmupSum += macdLine[i]; warmup++
      if (warmup === signalP) { prev = warmupSum / signalP; signalLine[i] = prev }
    } else {
      prev = macdLine[i] * k + prev * (1 - k); signalLine[i] = prev
    }
  }
  return { macdLine, signalLine }
}

function computeBB(closes, period, mult) {
  const N = closes.length
  const upper = new Float64Array(N).fill(NaN)
  const lower = new Float64Array(N).fill(NaN)
  let sum = 0
  for (let i = 0; i < N; i++) {
    sum += closes[i]
    if (i >= period) sum -= closes[i - period]
    if (i >= period - 1) {
      const sma = sum / period
      let v = 0
      for (let j = i - period + 1; j <= i; j++) v += (closes[j] - sma) ** 2
      const sd = Math.sqrt(v / period)
      upper[i] = sma + mult * sd; lower[i] = sma - mult * sd
    }
  }
  return { upper, lower }
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

// Fast backtest usando condiciones pre-computadas
function runFastBacktest(
  N, closes, highs, lows,
  longBase, shortBase, rsiArr, valid,
  rsiOverbought, rsiOversold, confluencesRequired,
  tpPct, slPct, effTp, effSl,
  canLong, canShort
) {
  let inTrade = false, isLong = false
  let tpPr = 0, slPr = 0
  let totalTp = 0, totalSl = 0, totalClosed = 0
  let profitPct = 0, lossPct = 0
  let eqPct = 0, eqPeak = 0, maxDrawdown = 0
  let compound = 1.0

  for (let i = 1; i < N; i++) {
    if (!valid[i]) continue
    const close = closes[i], high = highs[i], low = lows[i]

    let tpHit = false, slHit = false
    if (inTrade) {
      tpHit = isLong  ? high >= tpPr : low  <= tpPr
      slHit = !tpHit && (isLong ? low  <= slPr : high >= slPr)
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
      const rsiLong  = rsiArr[i] < rsiOversold
      const rsiShort = rsiArr[i] > rsiOverbought
      const longScore  = longBase[i]  + (rsiLong  ? 1 : 0)
      const shortScore = shortBase[i] + (rsiShort ? 1 : 0)

      const longOk  = canLong  && longScore  >= confluencesRequired
      const shortOk = canShort && shortScore >= confluencesRequired

      let goLong = false, goShort = false
      if      (longOk && !shortOk)                  goLong  = true
      else if (shortOk && !longOk)                  goShort = true
      else if (longOk && shortOk) {
        if (longScore >= shortScore) goLong  = true
        else                         goShort = true
      }

      if (goLong || goShort) {
        inTrade = true; isLong = goLong
        tpPr = isLong ? close * (1 + tpPct / 100) : close * (1 - tpPct / 100)
        slPr = isLong ? close * (1 - slPct / 100) : close * (1 + slPct / 100)
      }
    }
  }

  const netPct  = profitPct - lossPct
  const winRate = totalClosed > 0 ? (totalTp / totalClosed) * 100 : 0
  const score   = totalClosed >= 5 && netPct > 0
    ? netPct / Math.max(maxDrawdown, 0.1)
    : -Infinity

  return { totalTp, totalSl, totalClosed, netPct, winRate, maxDrawdown, compound, score }
}

// ── Entrada del Worker ──
self.onmessage = function (e) {
  const { candles, optimRanges, params } = e.data

  try {
    const {
      emaFast          = 21,
      emaSlow          = 55,
      rsiPeriod        = 14,
      macdFast         = 12,
      macdSlow         = 26,
      macdSignalPeriod = 9,
      bbPeriod         = 20,
      bbStdDev         = 2.0,
      volMAPeriod      = 20,
      volMultiplier    = 1.5,
      feeTpPct         = 0.05,
      feeSlPct         = 0.10,
      leverage         = 1,
      tradeDirection   = 'both',
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

    // Pre-computar indicadores (una sola vez)
    const emaFastArr = computeEMA(closes, emaFast)
    const emaSlowArr = computeEMA(closes, emaSlow)
    const rsiArr     = computeRSI(closes, rsiPeriod)
    const { macdLine, signalLine } = computeMACD(closes, macdFast, macdSlow, macdSignalPeriod)
    const { upper: bbUpper, lower: bbLower } = computeBB(closes, bbPeriod, bbStdDev)
    const volMAArr   = computeSMA(volumes, volMAPeriod)

    // valid[i]: todos los indicadores están calculados
    const valid = new Uint8Array(N)
    for (let i = 1; i < N; i++) {
      if (
        !isNaN(emaFastArr[i]) && !isNaN(emaSlowArr[i]) &&
        !isNaN(rsiArr[i]) &&
        !isNaN(macdLine[i]) && !isNaN(signalLine[i]) &&
        !isNaN(bbUpper[i])  && !isNaN(bbLower[i]) &&
        !isNaN(volMAArr[i])
      ) valid[i] = 1
    }

    // Condiciones fijas por barra (sin RSI — varía con el umbral)
    const longBase  = new Uint8Array(N)
    const shortBase = new Uint8Array(N)
    for (let i = 1; i < N; i++) {
      if (!valid[i]) continue
      const close   = closes[i]
      const highVol = volumes[i] > volMAArr[i] * volMultiplier
      longBase[i]  = (emaFastArr[i] > emaSlowArr[i] ? 1 : 0)
                   + (macdLine[i]   > signalLine[i]  ? 1 : 0)
                   + (highVol ? 1 : 0)
                   + (close <= bbLower[i] ? 1 : 0)
      shortBase[i] = (emaFastArr[i] < emaSlowArr[i] ? 1 : 0)
                   + (macdLine[i]   < signalLine[i]  ? 1 : 0)
                   + (highVol ? 1 : 0)
                   + (close >= bbUpper[i] ? 1 : 0)
    }

    const canLong  = tradeDirection === 'both' || tradeDirection === 'long'
    const canShort = tradeDirection === 'both' || tradeDirection === 'short'

    const tpVals    = rangeValues(optimRanges.tpPct.min,               optimRanges.tpPct.max,               optimRanges.tpPct.step)
    const slVals    = rangeValues(optimRanges.slPct.min,               optimRanges.slPct.max,               optimRanges.slPct.step)
    const confVals  = rangeValues(optimRanges.confluencesRequired.min,  optimRanges.confluencesRequired.max,  optimRanges.confluencesRequired.step)
    const rsiObVals = rangeValues(optimRanges.rsiOverbought.min,        optimRanges.rsiOverbought.max,        optimRanges.rsiOverbought.step)

    const total = tpVals.length * slVals.length * confVals.length * rsiObVals.length
    const REPORT_EVERY = Math.max(10, Math.floor(total / 200))

    let done = 0
    let topResults = []

    for (const rsiOb of rsiObVals) {
      const rsiOs = 100 - rsiOb
      for (const conf of confVals) {
        const confluencesRequired = Math.round(conf)
        for (const tp of tpVals) {
          const effTp = Math.max(tp - feeTpPct, 0) * leverage
          for (const sl of slVals) {
            const effSl = (sl + feeSlPct) * leverage

            const res = runFastBacktest(
              N, closes, highs, lows,
              longBase, shortBase, rsiArr, valid,
              rsiOb, rsiOs, confluencesRequired,
              tp, sl, effTp, effSl,
              canLong, canShort
            )

            if (res.score > -Infinity) {
              topResults.push({
                tpPct:               tp,
                slPct:               sl,
                confluencesRequired,
                rsiOverbought:       rsiOb,
                rsiOversold:         rsiOs,
                totalTp:             res.totalTp,
                totalSl:             res.totalSl,
                totalClosed:         res.totalClosed,
                totalNetPct:         res.netPct.toFixed(2),
                winRate:             res.winRate.toFixed(2),
                maxDrawdownPct:      res.maxDrawdown.toFixed(2),
                compoundFactor:      res.compound.toFixed(4),
                _score:              res.score,
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
