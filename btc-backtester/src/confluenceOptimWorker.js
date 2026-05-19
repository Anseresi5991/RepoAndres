/**
 * Web Worker — Análisis Profundo Confluencia (optimizado)
 *
 * Optimiza sobre: tpPct × slPct × confluencesRequired × rsiOverbought
 *
 * Optimizaciones vs versión anterior:
 *  1. computeBB usa varianza rolling O(N) en vez de O(N×period)
 *  2. Para cada par (rsiOb, conf) se pre-indexan los bares de señal;
 *     el bucle (tp × sl) salta de señal en señal en vez de iterar N.
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

// O(N) rolling variance — antes era O(N × period)
function computeBB(closes, period, mult) {
  const N = closes.length
  const upper = new Float64Array(N).fill(NaN)
  const lower = new Float64Array(N).fill(NaN)
  let sum = 0, sumSq = 0
  for (let i = 0; i < N; i++) {
    sum   += closes[i]
    sumSq += closes[i] * closes[i]
    if (i >= period) {
      sum   -= closes[i - period]
      sumSq -= closes[i - period] * closes[i - period]
    }
    if (i >= period - 1) {
      const sma      = sum / period
      const variance = sumSq / period - sma * sma
      const sd       = Math.sqrt(variance > 0 ? variance : 0)
      upper[i] = sma + mult * sd
      lower[i] = sma - mult * sd
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
      initialCapital   = 1000,
      emaTrend         = 200,
      skipSundays      = true,
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
    const emaFastArr  = computeEMA(closes, emaFast)
    const emaSlowArr  = computeEMA(closes, emaSlow)
    const emaTrendArr = computeEMA(closes, emaTrend)
    const rsiArr      = computeRSI(closes, rsiPeriod)
    const { macdLine, signalLine } = computeMACD(closes, macdFast, macdSlow, macdSignalPeriod)
    const { upper: bbUpper, lower: bbLower } = computeBB(closes, bbPeriod, bbStdDev)
    const volMAArr    = computeSMA(volumes, volMAPeriod)

    // Pre-computar domingos
    const isSundayArr = new Uint8Array(N)
    for (let i = 0; i < N; i++) {
      isSundayArr[i] = new Date(candles[i].OpenTime).getUTCDay() === 0 ? 1 : 0
    }

    // valid[i]: todos los indicadores listos y no es domingo (si aplica)
    const valid = new Uint8Array(N)
    for (let i = 1; i < N; i++) {
      if (skipSundays && isSundayArr[i]) continue
      if (
        !isNaN(emaFastArr[i]) && !isNaN(emaSlowArr[i]) && !isNaN(emaTrendArr[i]) &&
        !isNaN(rsiArr[i]) &&
        !isNaN(macdLine[i]) && !isNaN(signalLine[i]) &&
        !isNaN(bbUpper[i])  && !isNaN(bbLower[i]) &&
        !isNaN(volMAArr[i])
      ) valid[i] = 1
    }

    // Condiciones fijas por barra — RSI varía con el umbral, se añade en el loop
    const longBase  = new Uint8Array(N)
    const shortBase = new Uint8Array(N)
    for (let i = 1; i < N; i++) {
      if (!valid[i]) continue
      const close      = closes[i]
      const highVol    = volumes[i] > volMAArr[i] * volMultiplier
      const aboveTrend = close > emaTrendArr[i]
      const belowTrend = close < emaTrendArr[i]
      longBase[i]  = aboveTrend
        ? (emaFastArr[i] > emaSlowArr[i] ? 1 : 0)
        + (macdLine[i]   > signalLine[i]  ? 1 : 0)
        + (highVol ? 1 : 0)
        + (close <= bbLower[i] ? 1 : 0)
        : 0
      shortBase[i] = belowTrend
        ? (emaFastArr[i] < emaSlowArr[i] ? 1 : 0)
        + (macdLine[i]   < signalLine[i]  ? 1 : 0)
        + (highVol ? 1 : 0)
        + (close >= bbUpper[i] ? 1 : 0)
        : 0
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
    let lastReportedLength = 0

    for (const rsiOb of rsiObVals) {
      const rsiOs = 100 - rsiOb

      for (const conf of confVals) {
        const confluencesRequired = Math.round(conf)

        // ── Pre-indexar bares de señal para este (rsiOb, conf) ──
        // Coste: O(N) — una sola vez por par, compartido por todos (tp, sl)
        const sigBarsTemp = []
        const sigLongTemp = []
        for (let i = 1; i < N; i++) {
          if (!valid[i]) continue
          const ls = longBase[i]  + (rsiArr[i] < rsiOs ? 1 : 0)
          const ss = shortBase[i] + (rsiArr[i] > rsiOb ? 1 : 0)
          const lo = canLong  && ls >= confluencesRequired
          const so = canShort && ss >= confluencesRequired
          if (lo || so) {
            sigBarsTemp.push(i)
            sigLongTemp.push((lo && (!so || ls >= ss)) ? 1 : 0)
          }
        }
        const sigBars = new Uint32Array(sigBarsTemp)
        const sigLong = new Uint8Array(sigLongTemp)
        const nSig    = sigBars.length

        // ── Bucle (tp × sl): simula saltando de señal en señal ──
        for (const tp of tpVals) {
          const effTp = Math.max(tp - feeTpPct, 0) * leverage
          for (const sl of slVals) {
            const effSl = (sl + feeSlPct) * leverage

            let sIdx     = 0
            let inTrade  = false, isLong = false
            let tpPr     = 0, slPr = 0
            let totalTp  = 0, totalSl = 0
            let profitPct = 0, lossPct = 0
            let eqPct = 0, eqPeak = 0, maxDD = 0
            let compound  = 1.0

            for (let i = 1; i < N; i++) {
              if (!valid[i]) continue

              if (inTrade) {
                const tpHit = isLong ? highs[i] >= tpPr : lows[i]  <= tpPr
                const slHit = !tpHit && (isLong ? lows[i] <= slPr  : highs[i] >= slPr)
                if (tpHit || slHit) {
                  const win = tpHit
                  if (win) { totalTp++; profitPct += effTp; eqPct += effTp }
                  else     { totalSl++; lossPct   += effSl; eqPct -= effSl }
                  eqPeak   = Math.max(eqPeak, eqPct)
                  maxDD    = Math.max(maxDD, eqPeak - eqPct)
                  compound = win ? compound * (1 + effTp / 100) : compound * (1 - effSl / 100)
                  inTrade  = false
                  // avanzar sIdx más allá de señales que ocurrieron durante el trade
                  while (sIdx < nSig && sigBars[sIdx] < i) sIdx++
                }
              }

              if (!inTrade) {
                // Adelantar sIdx a la primera señal >= i
                while (sIdx < nSig && sigBars[sIdx] < i) sIdx++
                if (sIdx >= nSig) break
                if (sigBars[sIdx] > i) {
                  // Saltar directamente al bar de señal (evita iterar bares vacíos)
                  i = sigBars[sIdx] - 1
                  continue
                }
                // Señal exactamente en bar i
                isLong  = sigLong[sIdx] === 1
                sIdx++
                tpPr    = isLong ? closes[i] * (1 + tp / 100) : closes[i] * (1 - tp / 100)
                slPr    = isLong ? closes[i] * (1 - sl / 100) : closes[i] * (1 + sl / 100)
                inTrade = true
              }
            }

            const totalClosed = totalTp + totalSl
            const netPct      = profitPct - lossPct
            const winRate     = totalClosed > 0 ? (totalTp / totalClosed) * 100 : 0
            const score       = totalClosed >= 5 && netPct > 0 && maxDD <= 50
              ? netPct / Math.max(maxDD, 0.1)
              : -Infinity

            if (score > -Infinity) {
              topResults.push({
                tpPct:               tp,
                slPct:               sl,
                confluencesRequired,
                rsiOverbought:       rsiOb,
                rsiOversold:         rsiOs,
                totalTp,
                totalSl,
                totalClosed,
                totalNetPct:         netPct.toFixed(2),
                winRate:             winRate.toFixed(2),
                maxDrawdownPct:      maxDD.toFixed(2),
                compoundCapital:     (compound * initialCapital).toFixed(2),
                _score:              score,
              })
            }

            done++
            if (done % REPORT_EVERY === 0) {
              if (topResults.length !== lastReportedLength) {
                lastReportedLength = topResults.length
                self.postMessage({ type: 'progress', done, total, topResults: topResults.slice() })
              } else {
                self.postMessage({ type: 'progress', done, total })
              }
            }
          }
        }
      }
    }

    topResults.sort((a, b) => b._score - a._score)
    self.postMessage({ type: 'done', results: topResults })

  } catch (err) {
    self.postMessage({ type: 'error', message: err.message })
  }
}
