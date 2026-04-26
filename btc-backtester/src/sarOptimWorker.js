/**
 * Web Worker — Análisis Profundo SAR
 *
 * Optimizaciones clave:
 *  1. SAR + tendencia pre-computados una vez por combo (sarStart, sarInc, sarMax, pivotLr)
 *  2. Señales (longOk/shortOk) pre-computadas antes del loop TP/SL
 *  3. Solo itera TP × SL en el loop interior (sin recalcular SAR)
 *  4. Float64Array / Uint8Array / Int8Array para mejor rendimiento
 */

// =============================================================================
// Parabolic SAR — Wilder (inline para evitar import overhead)
// =============================================================================
function computeSAR(highs, lows, closes, start, inc, max) {
  const N      = highs.length
  const sarArr  = new Float64Array(N).fill(NaN)
  const bullArr = new Uint8Array(N)

  if (N < 3) return { sarArr, bullArr }

  let bull = closes[1] >= closes[0]
  let ep   = bull ? highs[1] : lows[1]
  let af   = start
  let sar  = bull ? Math.min(lows[0], lows[1]) : Math.max(highs[0], highs[1])

  sarArr[1]  = sar
  bullArr[1] = bull ? 1 : 0

  for (let i = 2; i < N; i++) {
    let nextSar = sar + af * (ep - sar)

    if (bull) {
      nextSar = Math.min(nextSar, lows[i - 1], lows[i - 2])
      if (lows[i] < nextSar) {
        bull    = false
        nextSar = ep
        ep      = lows[i]
        af      = start
      } else if (highs[i] > ep) {
        ep = highs[i]
        af = Math.min(af + inc, max)
      }
    } else {
      nextSar = Math.max(nextSar, highs[i - 1], highs[i - 2])
      if (highs[i] > nextSar) {
        bull    = true
        nextSar = ep
        ep      = highs[i]
        af      = start
      } else if (lows[i] < ep) {
        ep = lows[i]
        af = Math.min(af + inc, max)
      }
    }

    sar        = nextSar
    sarArr[i]  = sar
    bullArr[i] = bull ? 1 : 0
  }

  return { sarArr, bullArr }
}

// =============================================================================
// Tendencia estructural HH/HL (pivotes, leftRight=lr)
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
// Helpers
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
  const { feeSlPct, feeTpPct, leverage, initialCapital, useTrendFilter, skipSundays } = params

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

    // ── 2. Pre-cómputo: isSunday por índice ──
    const isSundayArr = new Uint8Array(N)
    if (skipSundays) {
      for (let i = 0; i < N; i++) {
        isSundayArr[i] = new Date(candles[i].OpenTime).getUTCDay() === 0 ? 1 : 0
      }
    }

    // ── 3. Grillas de parámetros ──
    const sarStarts = rangeValues(optimRanges.sarStart.min, optimRanges.sarStart.max, optimRanges.sarStart.step)
    const sarIncs   = rangeValues(optimRanges.sarInc.min,   optimRanges.sarInc.max,   optimRanges.sarInc.step)
    const sarMaxes  = rangeValues(optimRanges.sarMax.min,   optimRanges.sarMax.max,   optimRanges.sarMax.step)
    const pivotLrs  = rangeValues(optimRanges.pivotLr.min,  optimRanges.pivotLr.max,  optimRanges.pivotLr.step).map(v => Math.round(v))
    const tps       = rangeValues(optimRanges.tpPct.min,    optimRanges.tpPct.max,    optimRanges.tpPct.step)
    const sls       = rangeValues(optimRanges.slPct.min,    optimRanges.slPct.max,    optimRanges.slPct.step)

    const total = sarStarts.length * sarIncs.length * sarMaxes.length * pivotLrs.length * tps.length * sls.length
    const REPORT_EVERY = Math.max(10, Math.floor(total / 200))
    const TOP_N = 200
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

    // ── 4. Pre-cómputo de tendencia por pivotLr único ──
    const uniqueLrs = [...new Set(pivotLrs)]
    const trendByLr = {}
    for (const lr of uniqueLrs) {
      trendByLr[lr] = buildStructuralTrend(highs, lows, lr)
    }

    // ── 5. Loop principal ──
    // Orden: sarStart → sarInc → sarMax → pivotLr → tp → sl
    // SAR se re-calcula solo cuando cambia (start, inc, max)
    // Tendencia se reutiliza por pivotLr
    // Señales se pre-computan antes del loop tp×sl

    for (const sarStart of sarStarts) {
      for (const sarInc of sarIncs) {
        for (const sarMax of sarMaxes) {

          // Calcular SAR una vez para este combo (start, inc, max)
          const { sarArr, bullArr } = computeSAR(highs, lows, closes, sarStart, sarInc, sarMax)

          // Pre-computar cruces SAR
          const longCrossArr  = new Uint8Array(N)
          const shortCrossArr = new Uint8Array(N)
          for (let i = 1; i < N; i++) {
            if (isNaN(sarArr[i]) || isNaN(sarArr[i - 1])) continue
            longCrossArr[i]  = (bullArr[i] === 1 && bullArr[i - 1] === 0) ? 1 : 0
            shortCrossArr[i] = (bullArr[i] === 0 && bullArr[i - 1] === 1) ? 1 : 0
          }

          for (const pivotLr of pivotLrs) {
            const trend = trendByLr[pivotLr]

            // Pre-computar señales válidas para este combo SAR + pivotLr + filtros
            const longOkArr  = new Uint8Array(N)
            const shortOkArr = new Uint8Array(N)
            for (let i = 2; i < N; i++) {
              if (isNaN(sarArr[i])) continue
              const sun = isSundayArr[i]
              longOkArr[i]  = (longCrossArr[i]  && (!useTrendFilter || trend[i] ===  1) && !sun) ? 1 : 0
              shortOkArr[i] = (shortCrossArr[i] && (!useTrendFilter || trend[i] === -1) && !sun) ? 1 : 0
            }

            // Loop interior: solo TP × SL (sin recalcular SAR ni tendencia)
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

                for (let i = 2; i < N; i++) {
                  if (isNaN(sarArr[i])) continue

                  const anyOpened = longOkArr[i] || shortOkArr[i]

                  // Evaluar TP/SL (nunca en vela de apertura)
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

                  // Abrir nuevo trade
                  if (anyOpened && !inTrade) {
                    inTrade  = true
                    isLong   = longOkArr[i] === 1
                    tpPrice  = isLong ? closes[i] * (1 + tp / 100) : closes[i] * (1 - tp / 100)
                    slPrice  = isLong ? closes[i] * (1 - sl / 100) : closes[i] * (1 + sl / 100)
                  }
                }

                const netPct = profitPct - lossPct

                if (totalClosed >= 5 && netPct > 0) {
                  const score = netPct / (maxDd < 0.1 ? 0.1 : maxDd)
                  insertResult({
                    sarStart, sarInc, sarMax, pivotLr,
                    tpPct: parseFloat(tp.toFixed(4)),
                    slPct: parseFloat(sl.toFixed(4)),
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
      }
    }

    self.postMessage({ type: 'done', results: ranking })
  } catch (err) {
    self.postMessage({ type: 'error', message: err.message })
  }
}
