/**
 * Web Worker — Análisis Profundo Scalping 5m
 *
 * Estrategia: Supertrend 5m (entrada) filtrado por Supertrend 15m (tendencia)
 *
 * Optimizaciones:
 *  1. Supertrend 15m pre-computado UNA VEZ (parámetros 15m fijos durante la sesión)
 *  2. Mapa de sincronización 5m→15m pre-computado UNA VEZ (solo depende de timestamps)
 *  3. Para cada combo (period5m, mult5m): Supertrend 5m calculado una sola vez
 *  4. Para cada combo de filtros (atrVF, rsiThr, bodyMin): señales longOkArr/shortOkArr pre-calculadas
 *  5. Loop interno solo simula TP×SL con los arrays pre-calculados → costo mínimo
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
// SMA rodante
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
  const N = highs.length
  const direction     = new Int8Array(N)
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
// Mapa de sincronización 5m → 15m (O(n+m), se computa UNA VEZ)
// Para cada barra 5m[i] retorna el índice del último 15m cuyo OpenTime <= 5m[i].OpenTime
// =============================================================================
function build15mIndexMap(times5m, times15m) {
  const n5  = times5m.length
  const n15 = times15m.length
  const map = new Int32Array(n5).fill(-1)
  let ptr = 0
  for (let i = 0; i < n5; i++) {
    while (ptr < n15 && times15m[ptr] <= times5m[i]) ptr++
    map[i] = ptr - 1
  }
  return map
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
  const { candles5m, candles15m, optimRanges, params } = e.data
  const {
    feeSlPct       = 0.10,
    feeTpPct       = 0.05,
    leverage       = 10,
    initialCapital = 1000,
    tradeDirection = 'both',
    skipSundays    = true,
    atrPeriod15m   = 10,
    atrMultiplier15m = 3.0,
    use15mFilter   = true,
    rsiPeriod      = 14,
    atrVolPeriod   = 20,
    maxTradesPerDay = 0,
  } = params

  try {
    const N5  = candles5m.length
    const N15 = candles15m.length

    // ── 1. Arrays de precios 5m ──────────────────────────────────────────────
    const highs5m  = new Float64Array(N5)
    const lows5m   = new Float64Array(N5)
    const closes5m = new Float64Array(N5)
    const opens5m  = new Float64Array(N5)
    const times5m  = new Array(N5)
    for (let i = 0; i < N5; i++) {
      highs5m[i]  = parseFloat(candles5m[i].HighCandle)
      lows5m[i]   = parseFloat(candles5m[i].LowCandle)
      closes5m[i] = parseFloat(candles5m[i].CloseCandle)
      opens5m[i]  = parseFloat(candles5m[i].OpenCandle)
      times5m[i]  = candles5m[i].OpenTime
    }

    // ── 2. Arrays de precios 15m ─────────────────────────────────────────────
    const highs15m  = new Float64Array(N15)
    const lows15m   = new Float64Array(N15)
    const closes15m = new Float64Array(N15)
    const times15m  = new Array(N15)
    for (let i = 0; i < N15; i++) {
      highs15m[i]  = parseFloat(candles15m[i].HighCandle)
      lows15m[i]   = parseFloat(candles15m[i].LowCandle)
      closes15m[i] = parseFloat(candles15m[i].CloseCandle)
      times15m[i]  = candles15m[i].OpenTime
    }

    // ── 3. Pre-cómputo fijo (no cambia en el sweep) ──────────────────────────

    // Supertrend 15m: se computa UNA VEZ con los parámetros fijos del usuario
    const { direction: dir15m } = use15mFilter
      ? computeSupertrend(highs15m, lows15m, closes15m, atrPeriod15m, atrMultiplier15m)
      : { direction: new Int8Array(N15).fill(1) }

    // Mapa de sincronización: también fijo (solo depende de timestamps)
    const idx15m = build15mIndexMap(times5m, times15m)

    // RSI en 5m: fijo (el período RSI no se optimiza en este sweep)
    const rsiArr = computeRSI(closes5m, rsiPeriod)

    // Días UTC para el límite de trades/día
    const dayArr = new Array(N5)
    for (let i = 0; i < N5; i++) dayArr[i] = times5m[i].slice(0, 10)

    // isSunday
    const isSundayArr = new Uint8Array(N5)
    if (skipSundays) {
      for (let i = 0; i < N5; i++) {
        isSundayArr[i] = new Date(times5m[i]).getUTCDay() === 0 ? 1 : 0
      }
    }

    const canLong  = tradeDirection === 'both' || tradeDirection === 'long'
    const canShort = tradeDirection === 'both' || tradeDirection === 'short'

    // ── 4. Grillas de parámetros ─────────────────────────────────────────────
    const maxDdFilter = optimRanges.maxDdFilter ?? 50
    const topN        = optimRanges.topN        ?? 0   // 0 = sin límite

    const periods5m    = rangeValues(optimRanges.atrPeriod5m.min,     optimRanges.atrPeriod5m.max,     optimRanges.atrPeriod5m.step).map(v => Math.round(v))
    const multipliers5m= rangeValues(optimRanges.atrMultiplier5m.min, optimRanges.atrMultiplier5m.max, optimRanges.atrMultiplier5m.step)
    const tps          = rangeValues(optimRanges.tpPct.min,           optimRanges.tpPct.max,           optimRanges.tpPct.step)
    const sls          = rangeValues(optimRanges.slPct.min,           optimRanges.slPct.max,           optimRanges.slPct.step)

    const atrVolFilters = optimRanges.atrVolFilter
      ? rangeValues(optimRanges.atrVolFilter.min,  optimRanges.atrVolFilter.max,  optimRanges.atrVolFilter.step)
      : [0]
    const rsiThresholds = optimRanges.rsiThreshold
      ? rangeValues(optimRanges.rsiThreshold.min,  optimRanges.rsiThreshold.max,  optimRanges.rsiThreshold.step)
      : [0]
    const bodyRatioMins = optimRanges.bodyRatioMin
      ? rangeValues(optimRanges.bodyRatioMin.min,  optimRanges.bodyRatioMin.max,  optimRanges.bodyRatioMin.step)
      : [0]

    const total = periods5m.length * multipliers5m.length
      * atrVolFilters.length * rsiThresholds.length * bodyRatioMins.length
      * tps.length * sls.length

    const REPORT_EVERY = Math.max(10, Math.floor(total / 200))
    const ranking = []
    let done = 0
    let lastReportedLength = 0

    // ── 5. Loop principal ────────────────────────────────────────────────────
    // Orden: period5m → mult5m → atrVF → rsiThr → bodyMin → [pre-señales] → tp × sl

    for (const period5m of periods5m) {

      // ATR 5m: se reutiliza para todos los atrVolFilter de este período
      const rawAtrArr5m = computeATR(highs5m, lows5m, closes5m, period5m)
      const atrSmaArr5m = computeRollingSMA(rawAtrArr5m, atrVolPeriod)

      for (const mult5m of multipliers5m) {

        // Supertrend 5m: una vez por (period5m, mult5m)
        const { direction: dir5m } = computeSupertrend(highs5m, lows5m, closes5m, period5m, mult5m)

        for (const atrVF of atrVolFilters) {
        for (const rsiThr of rsiThresholds) {
        for (const bodyMin of bodyRatioMins) {

          // Pre-computar señales para este combo de filtros fijos
          const longOkArr  = new Uint8Array(N5)
          const shortOkArr = new Uint8Array(N5)

          for (let i = Math.max(period5m, 1); i < N5; i++) {
            if (isSundayArr[i]) continue

            const longCross5m  = dir5m[i] === 1  && dir5m[i - 1] === -1
            const shortCross5m = dir5m[i] === -1 && dir5m[i - 1] === 1
            if (!longCross5m && !shortCross5m) continue

            const atrOk = atrVF === 0 || (!isNaN(atrSmaArr5m[i]) && rawAtrArr5m[i] <= atrVF * atrSmaArr5m[i])
            if (!atrOk) continue

            const rsiVal     = rsiArr[i]
            const longRsiOk  = rsiThr === 0 || (!isNaN(rsiVal) && rsiVal <= rsiThr)
            const shortRsiOk = rsiThr === 0 || (!isNaN(rsiVal) && rsiVal >= (100 - rsiThr))

            const range  = highs5m[i] - lows5m[i]
            const bodyOk = bodyMin === 0 || (range > 0 && Math.abs(closes5m[i] - opens5m[i]) / range >= bodyMin)

            // Filtro 15m
            const idx      = idx15m[i]
            const tr15     = use15mFilter && idx >= 0 ? dir15m[idx] : 1
            const longTr   = !use15mFilter || tr15 === 1
            const shortTr  = !use15mFilter || tr15 === -1

            if (longCross5m  && canLong  && longTr  && longRsiOk  && bodyOk) longOkArr[i]  = 1
            if (shortCross5m && canShort && shortTr  && shortRsiOk && bodyOk) shortOkArr[i] = 1
          }

          // Pre-extraer lista de señales reales (evita escanear N5 completo en el loop interno)
          // Para scalping las señales son escasas → gran reducción del trabajo por combo tp×sl
          const signalIndices = []
          for (let i = Math.max(period5m, 1); i < N5; i++) {
            if (longOkArr[i] || shortOkArr[i]) signalIndices.push(i)
          }
          const nSignals = signalIndices.length

          // ── Loop interior: solo TP × SL ──────────────────────────────────
          // En vez de recorrer todos N5 candles por cada combo, iteramos solo
          // sobre las señales pre-extraídas y hacemos forward-scan hasta TP/SL.
          for (const tp of tps) {
            for (const sl of sls) {
              done++

              const effTp = Math.max(tp - feeTpPct, 0) * leverage
              const effSl = (sl + feeSlPct) * leverage

              let totalTp = 0, totalSl = 0, totalClosed = 0
              let profitPct = 0, lossPct = 0
              let eqPct = 0, eqPeak = 0, maxDd = 0
              let capital = initialCapital
              let currentDay    = ''
              let tradesThisDay = 0
              let lastExitBar   = -1
              let aborted       = false

              for (let si = 0; si < nSignals; si++) {
                const i = signalIndices[si]
                if (i <= lastExitBar) continue  // todavía dentro del trade anterior

                // Límite de trades por día
                const day = dayArr[i]
                if (day !== currentDay) { currentDay = day; tradesThisDay = 0 }
                if (maxTradesPerDay > 0 && tradesThisDay >= maxTradesPerDay) continue

                const isLong  = longOkArr[i] === 1
                const close   = closes5m[i]
                const tpPrice = isLong ? close * (1 + tp / 100) : close * (1 - tp / 100)
                const slPrice = isLong ? close * (1 - sl / 100) : close * (1 + sl / 100)

                // Forward scan: avanza solo hasta TP o SL (no toda la serie)
                let exitBar = N5 - 1
                let isWin   = false
                for (let j = i + 1; j < N5; j++) {
                  const slHit = isLong ? lows5m[j]  <= slPrice : highs5m[j] >= slPrice
                  const tpHit = isLong ? highs5m[j] >= tpPrice : lows5m[j]  <= tpPrice
                  if (slHit) { exitBar = j; break }           // SL gana si ambos
                  if (tpHit) { exitBar = j; isWin = true; break }
                }

                lastExitBar = exitBar
                tradesThisDay++
                totalClosed++

                if (isWin) {
                  totalTp++
                  profitPct += effTp; eqPct += effTp
                  if (eqPct > eqPeak) eqPeak = eqPct
                  capital *= (1 + effTp / 100)
                } else {
                  totalSl++
                  lossPct += effSl; eqPct -= effSl
                  if (eqPct > eqPeak) eqPeak = eqPct
                  const dd = eqPeak - eqPct; if (dd > maxDd) maxDd = dd
                  if (maxDd > maxDdFilter) { aborted = true; break }
                  capital *= (1 - effSl / 100)
                }
              }

              if (!aborted) {
                const netPct  = profitPct - lossPct
                const winRate = totalClosed > 0 ? totalTp / totalClosed * 100 : 0

                if (totalClosed >= 5 && netPct > 0 && maxDd <= maxDdFilter) {
                  const score = netPct / (maxDd < 0.1 ? 0.1 : maxDd)
                  ranking.push({
                    atrPeriod5m:     period5m,
                    atrMultiplier5m: parseFloat(mult5m.toFixed(2)),
                    atrVolFilter:    parseFloat(atrVF.toFixed(2)),
                    rsiThreshold:    parseFloat(rsiThr.toFixed(1)),
                    bodyRatioMin:    parseFloat(bodyMin.toFixed(2)),
                    tpPct:           parseFloat(tp.toFixed(4)),
                    slPct:           parseFloat(sl.toFixed(4)),
                    totalTp, totalSl, totalClosed,
                    totalNetPct:     netPct.toFixed(2),
                    winRate:         winRate.toFixed(2),
                    maxDrawdownPct:  maxDd.toFixed(2),
                    compoundCapital: capital.toFixed(2),
                    effectiveTpPct:  effTp,
                    effectiveSlPct:  effSl,
                    _score:          score,
                  })
                }
              }

              if (done % REPORT_EVERY === 0 && ranking.length !== lastReportedLength) {
                lastReportedLength = ranking.length
                self.postMessage({ type: 'progress', done, total, topResults: ranking.slice() })
              } else if (done % REPORT_EVERY === 0) {
                self.postMessage({ type: 'progress', done, total })
              }
            } // sl
          }   // tp
        }     // bodyMin
        }     // rsiThr
        }     // atrVF
      }       // mult5m
    }         // period5m

    // Sort final results once and apply topN limit if set
    ranking.sort((a, b) => b._score - a._score)
    if (topN > 0 && ranking.length > topN) ranking.splice(topN)
    self.postMessage({ type: 'done', results: ranking })
  } catch (err) {
    self.postMessage({ type: 'error', message: err.message })
  }
}
