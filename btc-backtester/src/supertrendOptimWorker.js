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
  const { candles, optimRanges, params } = e.data
  const { feeSlPct, feeTpPct, leverage, initialCapital,
          useTrendFilter, pivotLr, tradeDirection, skipSundays } = params

  try {
    const N = candles.length

    // ── 1. Arrays de precios ──
    const highs  = new Float64Array(N)
    const lows   = new Float64Array(N)
    const closes = new Float64Array(N)
    for (let i = 0; i < N; i++) {
      highs[i]  = parseFloat(candles[i].HighCandle)
      lows[i]   = parseFloat(candles[i].LowCandle)
      closes[i] = parseFloat(candles[i].CloseCandle)
    }

    // ── 2. Pre-cómputo: isSunday ──
    const isSundayArr = new Uint8Array(N)
    if (skipSundays) {
      for (let i = 0; i < N; i++) {
        isSundayArr[i] = new Date(candles[i].OpenTime).getUTCDay() === 0 ? 1 : 0
      }
    }

    // ── 3. Pre-cómputo: tendencia HH/HL (fija si useTrendFilter) ──
    const trend = useTrendFilter ? buildStructuralTrend(highs, lows, pivotLr) : null

    const canLong  = tradeDirection === 'both' || tradeDirection === 'long'
    const canShort = tradeDirection === 'both' || tradeDirection === 'short'

    // ── 4. Grillas de parámetros ──
    const periods      = rangeValues(optimRanges.atrPeriod.min,     optimRanges.atrPeriod.max,     optimRanges.atrPeriod.step).map(v => Math.round(v))
    const multipliers  = rangeValues(optimRanges.atrMultiplier.min, optimRanges.atrMultiplier.max, optimRanges.atrMultiplier.step)
    const tps          = rangeValues(optimRanges.tpPct.min,         optimRanges.tpPct.max,         optimRanges.tpPct.step)
    const sls          = rangeValues(optimRanges.slPct.min,         optimRanges.slPct.max,         optimRanges.slPct.step)

    const total = periods.length * multipliers.length * tps.length * sls.length
    const REPORT_EVERY = Math.max(10, Math.floor(total / 200))
    const TOP_N  = 200
    const ranking = []
    let done = 0

    function insertResult(candidate) {
      if (ranking.length < TOP_N) {
        ranking.push(candidate)
        ranking.sort((a, b) => b._score - a._score)
      } else if (candidate._score > ranking[TOP_N - 1]._score) {
        ranking[TOP_N - 1] = candidate
        ranking.sort((a, b) => b._score - a._score)
      }
    }

    // ── 5. Loop principal ──
    // Orden: period → multiplier → tp → sl
    // Supertrend se recalcula solo cuando cambia (period, multiplier)

    for (const period of periods) {
      for (const multiplier of multipliers) {

        // Calcular Supertrend una vez para este combo
        const { direction, supertrendArr } = computeSupertrend(highs, lows, closes, period, multiplier)

        // Pre-computar señales para este combo + filtros fijos
        const longOkArr  = new Uint8Array(N)
        const shortOkArr = new Uint8Array(N)
        for (let i = period; i < N; i++) {
          if (isNaN(supertrendArr[i])) continue
          const sun       = isSundayArr[i]
          const isBull    = trend ? trend[i] === 1  : true
          const isBear    = trend ? trend[i] === -1 : true
          const longCross  = direction[i] === 1  && direction[i - 1] === -1
          const shortCross = direction[i] === -1 && direction[i - 1] === 1
          longOkArr[i]  = (longCross  && canLong  && (!useTrendFilter || isBull) && !sun) ? 1 : 0
          shortOkArr[i] = (shortCross && canShort && (!useTrendFilter || isBear) && !sun) ? 1 : 0
        }

        // ── Loop interior: solo TP × SL ──
        for (const tp of tps) {
          for (const sl of sls) {
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

            for (let i = period; i < N; i++) {
              if (isNaN(supertrendArr[i])) continue

              const anyOpened = longOkArr[i] || shortOkArr[i]

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
                  inTrade = false
                } else if (slHit) {
                  totalSl++; totalClosed++
                  lossPct += effSl; eqPct -= effSl
                  if (eqPct > eqPeak) eqPeak = eqPct
                  const dd = eqPeak - eqPct
                  if (dd > maxDd) maxDd = dd
                  capital *= (1 - effSl / 100)
                  inTrade = false
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

            if (totalClosed >= 5 && netPct > 0 && maxDd <= 70) {
              const score = netPct / (maxDd < 0.1 ? 0.1 : maxDd)
              insertResult({
                atrPeriod:     period,
                atrMultiplier: parseFloat(multiplier.toFixed(4)),
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

            done++
            if (done % REPORT_EVERY === 0) {
              self.postMessage({ type: 'progress', done, total, topResults: ranking.slice() })
            }
          }
        }
      }
    }

    self.postMessage({ type: 'done', results: ranking })
  } catch (err) {
    self.postMessage({ type: 'error', message: err.message })
  }
}
