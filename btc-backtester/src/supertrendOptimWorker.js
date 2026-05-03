/**
 * Web Worker — Análisis Profundo Supertrend
 *
 * Optimizaciones:
 *  1. ATR + Supertrend pre-computados una vez por combo (atrPeriod, atrMultiplier)
 *  2. Señales longOk/shortOk pre-computadas antes del loop TP×SL
 *  3. Tendencia HH/HL pre-computada por pivotLr único (fija durante la sesión)
 *  4. Loop interior solo evalúa TP×SL sin recalcular indicadores
 */

// =============================================================================
// EMA estándar
// =============================================================================
function computeEMA(closes, period) {
  const N = closes.length
  const result = new Float64Array(N).fill(NaN)
  if (N < period) return result
  const k = 2 / (period + 1)
  let sum = 0
  for (let i = 0; i < period; i++) sum += closes[i]
  result[period - 1] = sum / period
  for (let i = period; i < N; i++) {
    result[i] = closes[i] * k + result[i - 1] * (1 - k)
  }
  return result
}

// =============================================================================
// ADX — Average Directional Index (Wilder)
// =============================================================================
function computeADX(highs, lows, closes, period) {
  const N = highs.length
  const adxArr = new Float64Array(N).fill(NaN)
  if (N < period * 2) return adxArr

  const tr  = new Float64Array(N)
  const dmP = new Float64Array(N)
  const dmM = new Float64Array(N)

  tr[0] = highs[0] - lows[0]
  for (let i = 1; i < N; i++) {
    tr[i] = Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i-1]), Math.abs(lows[i] - closes[i-1]))
    const up = highs[i] - highs[i-1]
    const dn = lows[i-1] - lows[i]
    dmP[i] = (up > dn && up > 0) ? up : 0
    dmM[i] = (dn > up && dn > 0) ? dn : 0
  }

  let trRma = 0, dpRma = 0, dmRma = 0
  for (let i = 0; i < period; i++) { trRma += tr[i]; dpRma += dmP[i]; dmRma += dmM[i] }
  trRma /= period; dpRma /= period; dmRma /= period

  const dxArr = new Float64Array(N).fill(0)
  const diP0 = trRma > 0 ? 100 * dpRma / trRma : 0
  const diM0 = trRma > 0 ? 100 * dmRma / trRma : 0
  dxArr[period - 1] = (diP0 + diM0) > 0 ? 100 * Math.abs(diP0 - diM0) / (diP0 + diM0) : 0

  for (let i = period; i < N; i++) {
    trRma = (trRma * (period - 1) + tr[i]) / period
    dpRma = (dpRma * (period - 1) + dmP[i]) / period
    dmRma = (dmRma * (period - 1) + dmM[i]) / period
    const diP = trRma > 0 ? 100 * dpRma / trRma : 0
    const diM = trRma > 0 ? 100 * dmRma / trRma : 0
    dxArr[i] = (diP + diM) > 0 ? 100 * Math.abs(diP - diM) / (diP + diM) : 0
  }

  let adxInit = 0
  for (let i = period - 1; i < 2 * period - 1; i++) adxInit += dxArr[i]
  adxArr[2 * period - 2] = adxInit / period
  for (let i = 2 * period - 1; i < N; i++) {
    adxArr[i] = (adxArr[i - 1] * (period - 1) + dxArr[i]) / period
  }

  return adxArr
}

// =============================================================================
// ATR — Wilder's RMA
// =============================================================================
function computeATR(highs, lows, closes, period) {
  const N  = highs.length
  const tr  = new Float64Array(N)
  const atr = new Float64Array(N)

  tr[0] = highs[0] - lows[0]
  for (let i = 1; i < N; i++) {
    tr[i] = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i]  - closes[i - 1])
    )
  }

  if (N < period) return atr
  let sum = 0
  for (let i = 0; i < period; i++) sum += tr[i]
  atr[period - 1] = sum / period
  for (let i = period; i < N; i++) {
    atr[i] = (atr[i - 1] * (period - 1) + tr[i]) / period
  }
  return atr
}

// =============================================================================
// SMA rodante (para baseline del ATR)
// =============================================================================
function computeRollingSMA(arr, period) {
  const N = arr.length
  const out = new Float64Array(N).fill(NaN)
  let sum = 0
  for (let i = 0; i < N; i++) {
    sum += arr[i]
    if (i >= period) sum -= arr[i - period]
    if (i >= period - 1) out[i] = sum / period
  }
  return out
}

// =============================================================================
// RSI — Wilder's smoothing
// =============================================================================
function computeRSI(closes, period) {
  const N = closes.length
  const rsi = new Float64Array(N).fill(NaN)
  if (N < period + 1) return rsi
  let avgGain = 0, avgLoss = 0
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1]
    if (d > 0) avgGain += d; else avgLoss -= d
  }
  avgGain /= period; avgLoss /= period
  rsi[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss)
  for (let i = period + 1; i < N; i++) {
    const d = closes[i] - closes[i - 1]
    avgGain = (avgGain * (period - 1) + (d > 0 ? d : 0)) / period
    avgLoss = (avgLoss * (period - 1) + (d < 0 ? -d : 0)) / period
    rsi[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss)
  }
  return rsi
}

// =============================================================================
// Supertrend
// =============================================================================
function computeSupertrend(highs, lows, closes, period, multiplier) {
  const N            = highs.length
  const direction    = new Int8Array(N)
  const supertrendArr = new Float64Array(N).fill(NaN)

  const atr   = computeATR(highs, lows, closes, period)
  const start = period - 1
  if (start >= N) return { direction, supertrendArr }

  const upperRaw = new Float64Array(N)
  const lowerRaw = new Float64Array(N)
  for (let i = start; i < N; i++) {
    const hl2   = (highs[i] + lows[i]) / 2
    upperRaw[i] = hl2 + multiplier * atr[i]
    lowerRaw[i] = hl2 - multiplier * atr[i]
  }

  const finalUpper = new Float64Array(N)
  const finalLower = new Float64Array(N)
  finalUpper[start]    = upperRaw[start]
  finalLower[start]    = lowerRaw[start]
  direction[start]     = 1
  supertrendArr[start] = finalLower[start]

  for (let i = start + 1; i < N; i++) {
    finalUpper[i] = closes[i - 1] <= finalUpper[i - 1]
      ? Math.min(upperRaw[i], finalUpper[i - 1])
      : upperRaw[i]
    finalLower[i] = closes[i - 1] >= finalLower[i - 1]
      ? Math.max(lowerRaw[i], finalLower[i - 1])
      : lowerRaw[i]
    direction[i] = direction[i - 1] === -1
      ? (closes[i] > finalUpper[i] ? 1 : -1)
      : (closes[i] < finalLower[i] ? -1 : 1)
    supertrendArr[i] = direction[i] === 1 ? finalLower[i] : finalUpper[i]
  }

  return { direction, supertrendArr }
}

// =============================================================================
// Tendencia estructural HH/HL
// =============================================================================
function buildStructuralTrend(highs, lows, lr) {
  const N   = highs.length
  const out = new Int8Array(N)
  let lastPh = null, prevPh = null
  let lastPl = null, prevPl = null

  for (let i = 0; i < N; i++) {
    const j = i - lr
    if (j >= lr) {
      const ph = highs[j]
      let isPH = true
      for (let k = j - lr; k <= j + lr && isPH; k++) {
        if (k !== j && highs[k] >= ph) isPH = false
      }
      if (isPH) { prevPh = lastPh; lastPh = ph }

      const pl = lows[j]
      let isPL = true
      for (let k = j - lr; k <= j + lr && isPL; k++) {
        if (k !== j && lows[k] <= pl) isPL = false
      }
      if (isPL) { prevPl = lastPl; lastPl = pl }
    }

    if (lastPh !== null && prevPh !== null && lastPl !== null && prevPl !== null) {
      if      (lastPh > prevPh && lastPl > prevPl) out[i] =  1
      else if (lastPh < prevPh && lastPl < prevPl) out[i] = -1
      else                                          out[i] =  0
    }
  }
  return out
}

// =============================================================================
// Helper rangeValues
// =============================================================================
function rangeValues(min, max, step) {
  const vals = []
  const s = parseFloat(step)
  if (s <= 0) return [parseFloat(min)]
  for (let v = parseFloat(min); v <= parseFloat(max) + 1e-9; v += s)
    vals.push(parseFloat(v.toFixed(6)))
  return vals
}

// =============================================================================
// Worker principal
// =============================================================================
self.onmessage = function (e) {
  const { candles, optimRanges, params, startOffset = 0, initialRanking = [] } = e.data
  const { feeSlPct, feeTpPct, leverage, initialCapital,
          useTrendFilter, pivotLr, tradeDirection, skipSundays,
          emaFilterPeriod = 0, maxConsecLosses = 0, consecCooldownBars = 20,
          adxPeriod = 14, adxMinimum = 0,
          slopeEmaPeriod = 0, slopeLookback = 3,
          atrVolFilter = 0, atrVolPeriod = 20,
          rsiPeriod = 14, rsiThreshold = 0,
          bodyRatioMin = 0 } = params

  try {
    const N = candles.length

    // ── 1. Arrays de precios ──
    const highs  = new Float64Array(N)
    const lows   = new Float64Array(N)
    const closes = new Float64Array(N)
    const opens  = new Float64Array(N)
    for (let i = 0; i < N; i++) {
      highs[i]  = parseFloat(candles[i].HighCandle)
      lows[i]   = parseFloat(candles[i].LowCandle)
      closes[i] = parseFloat(candles[i].CloseCandle)
      opens[i]  = parseFloat(candles[i].OpenCandle)
    }

    // ── 2. Pre-cómputo: isSunday ──
    const isSundayArr = new Uint8Array(N)
    if (skipSundays) {
      for (let i = 0; i < N; i++) {
        isSundayArr[i] = new Date(candles[i].OpenTime).getUTCDay() === 0 ? 1 : 0
      }
    }

    // ── 3. Pre-cómputo: tendencia HH/HL, EMA, ADX y EMA-pendiente (todos fijos por sesión) ──
    const trend    = useTrendFilter      ? buildStructuralTrend(highs, lows, pivotLr) : null
    const emaArr   = emaFilterPeriod > 0 ? computeEMA(closes, emaFilterPeriod)         : null
    const adxArr   = adxMinimum > 0      ? computeADX(highs, lows, closes, adxPeriod)  : null
    const slopeArr = slopeEmaPeriod > 0  ? computeEMA(closes, slopeEmaPeriod)          : null
    const rsiArr   = computeRSI(closes, rsiPeriod)

    const canLong  = tradeDirection === 'both' || tradeDirection === 'long'
    const canShort = tradeDirection === 'both' || tradeDirection === 'short'

    // ── 4. Grillas de parámetros ──
    const maxDdFilter = optimRanges.maxDdFilter ?? 20
    const topN        = optimRanges.topN        ?? 500
    const periods      = rangeValues(optimRanges.atrPeriod.min,     optimRanges.atrPeriod.max,     optimRanges.atrPeriod.step).map(v => Math.round(v))
    const multipliers  = rangeValues(optimRanges.atrMultiplier.min, optimRanges.atrMultiplier.max, optimRanges.atrMultiplier.step)
    const tps          = rangeValues(optimRanges.tpPct.min,         optimRanges.tpPct.max,         optimRanges.tpPct.step)
    const sls          = rangeValues(optimRanges.slPct.min,         optimRanges.slPct.max,         optimRanges.slPct.step)
    const atrVolFilters  = optimRanges.atrVolFilter
      ? rangeValues(optimRanges.atrVolFilter.min,  optimRanges.atrVolFilter.max,  optimRanges.atrVolFilter.step)  : [0]
    const rsiThresholds  = optimRanges.rsiThreshold
      ? rangeValues(optimRanges.rsiThreshold.min,  optimRanges.rsiThreshold.max,  optimRanges.rsiThreshold.step)  : [0]
    const bodyRatioMins  = optimRanges.bodyRatioMin
      ? rangeValues(optimRanges.bodyRatioMin.min,  optimRanges.bodyRatioMin.max,  optimRanges.bodyRatioMin.step)  : [0]

    const total = periods.length * multipliers.length * atrVolFilters.length * rsiThresholds.length * bodyRatioMins.length * tps.length * sls.length
    const REPORT_EVERY = Math.max(10, Math.floor(total / 200))
    const ranking = initialRanking.length > 0 ? [...initialRanking] : []
    let done = 0

    function insertResult(candidate) {
      if (topN <= 0 || ranking.length < topN) {
        ranking.push(candidate)
        ranking.sort((a, b) => b._score - a._score)
      } else if (candidate._score > ranking[topN - 1]._score) {
        ranking[topN - 1] = candidate
        ranking.sort((a, b) => b._score - a._score)
      }
    }

    // ── 5. Loop principal ──
    // Orden: period → multiplier → tp → sl
    // Supertrend se recalcula solo cuando cambia (period, multiplier)

    for (const period of periods) {
      // ATR relativo: depende solo de period, se reutiliza para todos los atrVolFilter del loop
      const rawAtrArr = computeATR(highs, lows, closes, period)
      const atrSmaArr = computeRollingSMA(rawAtrArr, atrVolPeriod)

      for (const multiplier of multipliers) {

        // Calcular Supertrend una vez para este combo
        const { direction, supertrendArr } = computeSupertrend(highs, lows, closes, period, multiplier)

        // ── Loop atrVolFilter × rsiThreshold × bodyRatioMin ──
        for (const atrVF of atrVolFilters) {
        for (const rsiThr of rsiThresholds) {
        for (const bodyMin of bodyRatioMins) {

        // Pre-computar señales para este combo + filtros fijos
        const longOkArr  = new Uint8Array(N)
        const shortOkArr = new Uint8Array(N)
        for (let i = period; i < N; i++) {
          if (isNaN(supertrendArr[i])) continue
          const sun        = isSundayArr[i]
          const isBull     = trend ? trend[i] === 1  : true
          const isBear     = trend ? trend[i] === -1 : true
          const longCross  = direction[i] === 1  && direction[i - 1] === -1
          const shortCross = direction[i] === -1 && direction[i - 1] === 1
          const emaVal     = emaArr ? emaArr[i] : NaN
          const emaReady   = !emaArr || !isNaN(emaVal)
          const longEmaOk  = !emaArr || (emaReady && closes[i] > emaVal)
          const shortEmaOk = !emaArr || (emaReady && closes[i] < emaVal)

          const adxVal    = adxArr ? adxArr[i] : NaN
          const adxOk     = !adxArr || (!isNaN(adxVal) && adxVal >= adxMinimum)

          const slopeVal  = slopeArr ? slopeArr[i] : NaN
          const slopePrev = slopeArr ? slopeArr[i - slopeLookback] : NaN
          const slopeRdy  = !slopeArr || (i >= slopeLookback && !isNaN(slopeVal) && !isNaN(slopePrev))
          const longSlopeOk  = !slopeArr || (slopeRdy && slopeVal > slopePrev)
          const shortSlopeOk = !slopeArr || (slopeRdy && slopeVal < slopePrev)

          const atrOk = atrVF === 0 || (!isNaN(atrSmaArr[i]) && rawAtrArr[i] <= atrVF * atrSmaArr[i])

          const rsiVal   = rsiArr[i]
          const longRsiOk  = rsiThr === 0 || (!isNaN(rsiVal) && rsiVal <= rsiThr)
          const shortRsiOk = rsiThr === 0 || (!isNaN(rsiVal) && rsiVal >= (100 - rsiThr))

          const range   = highs[i] - lows[i]
          const bodyOk  = bodyMin === 0 || (range > 0 && Math.abs(closes[i] - opens[i]) / range >= bodyMin)

          longOkArr[i]  = (longCross  && canLong  && (!useTrendFilter || isBull) && !sun && longEmaOk  && adxOk && longSlopeOk  && atrOk && longRsiOk  && bodyOk) ? 1 : 0
          shortOkArr[i] = (shortCross && canShort && (!useTrendFilter || isBear) && !sun && shortEmaOk && adxOk && shortSlopeOk && atrOk && shortRsiOk && bodyOk) ? 1 : 0
        }

        // ── Loop interior: solo TP × SL ──
        for (const tp of tps) {
          for (const sl of sls) {
            done++
            if (done <= startOffset) continue

            const effTp = Math.max(tp - feeTpPct, 0) * leverage
            const effSl = (sl + feeSlPct) * leverage

            let inTrade  = false
            let isLong   = false
            let tpPrice  = 0
            let slPrice  = 0

            let totalTp = 0, totalSl = 0, totalClosed = 0
            let profitPct = 0, lossPct = 0
            let eqPct = 0, eqPeak = 0, maxDd = 0
            let capital = initialCapital
            let consecLosses  = 0
            let pauseUntilBar = -1

            for (let i = period; i < N; i++) {
              if (isNaN(supertrendArr[i])) continue

              const isPaused  = maxConsecLosses > 0 && i < pauseUntilBar
              const anyOpened = !isPaused && (longOkArr[i] || shortOkArr[i])

              if (inTrade && !anyOpened) {
                const tpHit = isLong ? highs[i] >= tpPrice : lows[i]  <= tpPrice
                const slHit = !tpHit && (isLong ? lows[i] <= slPrice : highs[i] >= slPrice)

                if (tpHit) {
                  totalTp++; totalClosed++
                  profitPct += effTp; eqPct += effTp
                  if (eqPct > eqPeak) eqPeak = eqPct
                  const dd = eqPeak - eqPct
                  if (dd > maxDd) maxDd = dd
                  capital *= (1 + effTp / 100)
                  inTrade      = false
                  consecLosses = 0
                } else if (slHit) {
                  totalSl++; totalClosed++
                  lossPct += effSl; eqPct -= effSl
                  if (eqPct > eqPeak) eqPeak = eqPct
                  const dd = eqPeak - eqPct
                  if (dd > maxDd) maxDd = dd
                  if (maxDd > maxDdFilter) break
                  capital *= (1 - effSl / 100)
                  inTrade = false
                  consecLosses++
                  if (maxConsecLosses > 0 && consecLosses >= maxConsecLosses) {
                    pauseUntilBar = i + consecCooldownBars
                    consecLosses  = 0
                  }
                }
              }

              if (anyOpened && !inTrade) {
                inTrade  = true
                isLong   = longOkArr[i] === 1
                tpPrice  = isLong ? closes[i] * (1 + tp / 100) : closes[i] * (1 - tp / 100)
                slPrice  = isLong ? closes[i] * (1 - sl / 100) : closes[i] * (1 + sl / 100)
              }
            }

            const netPct = profitPct - lossPct

            if (totalClosed >= 5 && netPct > 0 && maxDd <= maxDdFilter) {
              const score = netPct / (maxDd < 0.1 ? 0.1 : maxDd)
              insertResult({
                atrPeriod:     period,
                atrMultiplier: parseFloat(multiplier.toFixed(4)),
                atrVolFilter:  parseFloat(atrVF.toFixed(2)),
                rsiThreshold:  parseFloat(rsiThr.toFixed(1)),
                bodyRatioMin:  parseFloat(bodyMin.toFixed(2)),
                tpPct:         parseFloat(tp.toFixed(4)),
                slPct:         parseFloat(sl.toFixed(4)),
                totalTp, totalSl, totalClosed,
                totalNetPct:    netPct.toFixed(2),
                winRate:        (totalTp / totalClosed * 100).toFixed(2),
                maxDrawdownPct: maxDd.toFixed(2),
                compoundCapital: capital.toFixed(2),
                effectiveTpPct: effTp,
                effectiveSlPct: effSl,
                _score: score,
              })
            }

            if (done % REPORT_EVERY === 0) {
              self.postMessage({ type: 'progress', done, total, topResults: ranking.slice() })
            }
          }        // fin sl
        }          // fin tp
        }          // fin bodyMin
        }          // fin rsiThr
        }          // fin atrVF
      }            // fin multiplier
    }              // fin period

    self.postMessage({ type: 'done', results: ranking })
  } catch (err) {
    self.postMessage({ type: 'error', message: err.message })
  }
}
