/**
 * Web Worker — Análisis Profundo EMA Touch
 *
 * Itera sobre: emaPeriod · minWickPct · slPct · tpPct
 * Soporta direction 'R' (SHORT), 'S' (LONG), 'BOTH'.
 * Ranquea top 5 por período de EMA. Score = netPct / maxDrawdown.
 *
 * Entrada:  { candles, optimRanges, params, emaPeriodSubset }
 * Salida:   postMessage({ type: 'progress'|'done'|'error', ... })
 */

function ema(values, period) {
  const k = 2 / (period + 1)
  const result = new Array(values.length).fill(null)
  let prev = null
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) { result[i] = null; continue }
    if (prev === null) {
      let sum = 0
      for (let j = i - period + 1; j <= i; j++) sum += values[j]
      prev = sum / period
      result[i] = prev
    } else {
      prev = values[i] * k + prev * (1 - k)
      result[i] = prev
    }
  }
  return result
}

function rsi(closes, period) {
  const N = closes.length
  const result = new Float64Array(N)
  if (N <= period) return result
  let gainSum = 0, lossSum = 0
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i-1]
    if (d > 0) gainSum += d; else lossSum -= d
  }
  let avgGain = gainSum / period
  let avgLoss = lossSum / period
  result[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss)
  for (let i = period + 1; i < N; i++) {
    const d = closes[i] - closes[i-1]
    avgGain = (avgGain * (period - 1) + (d > 0 ? d : 0)) / period
    avgLoss = (avgLoss * (period - 1) + (d < 0 ? -d : 0)) / period
    result[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss)
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
  const { candles, optimRanges, params, emaPeriodSubset } = e.data

  try {
    const N = candles.length

    if (N === 0) {
      self.postMessage({ type: 'error', message: 'No se recibieron velas. Recarga la pestaña EMA Touch y vuelve a iniciar el análisis.' })
      return
    }

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

    // Pre-cómputo de cambio de día UTC
    const isNewDay = new Uint8Array(N)
    isNewDay[0] = 1
    for (let i = 1; i < N; i++) {
      isNewDay[i] = candles[i].OpenTime.substring(0, 10) !== candles[i - 1].OpenTime.substring(0, 10) ? 1 : 0
    }

    // Pre-cómputo de nextDay[i] = índice de la próxima vela isNewDay
    // Permite saltar al siguiente día cuando no hay trade y la señal diaria ya fue usada
    const nextDay = new Int32Array(N).fill(N)
    for (let i = N - 2; i >= 0; i--) {
      nextDay[i] = isNewDay[i + 1] ? i + 1 : nextDay[i + 1]
    }

    const emaPeriods = emaPeriodSubset
      ?? rangeValues(optimRanges.emaPeriod.min, optimRanges.emaPeriod.max, optimRanges.emaPeriod.step).map(v => Math.round(v))
    const minWicks = rangeValues(optimRanges.minWickPct.min, optimRanges.minWickPct.max, optimRanges.minWickPct.step)
    const sls      = rangeValues(optimRanges.slPct.min,      optimRanges.slPct.max,      optimRanges.slPct.step)
    const tps      = rangeValues(optimRanges.tpPct.min,      optimRanges.tpPct.max,      optimRanges.tpPct.step)

    const {
      feeSlPct, feeTpPct, leverage, initialCapital,
      direction = 'BOTH',
      slowEmaPeriod = 200, emaSlopeLookback = 5, maxBodyPct = 50,
      emaConsistencyBars = 3,
      atrPeriod = 14, atrMaPeriod = 20, atrMaxMultiplier = 1.5,
      rsiPeriod = 14, rsiShortMax = 65, rsiLongMin = 35,
      minCrossBodyPct = 30,
    } = params

    // EMA lenta de tendencia — se computa una sola vez (parámetro fijo, no optimizable)
    const slowEmaArr = slowEmaPeriod > 0 ? ema(closes, slowEmaPeriod) : null

    // ATR de Wilder + MA del ATR — se computa una sola vez (independiente de emaPer)
    const atrOk = new Uint8Array(N).fill(1)  // por defecto todo OK
    if (atrPeriod > 1 && atrMaPeriod > 1 && N >= atrPeriod + atrMaPeriod) {
      const atrArr = new Float64Array(N)
      let sumTr = highs[0] - lows[0]
      for (let i = 1; i < atrPeriod; i++) {
        sumTr += Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i-1]), Math.abs(lows[i] - closes[i-1]))
      }
      atrArr[atrPeriod - 1] = sumTr / atrPeriod
      for (let i = atrPeriod; i < N; i++) {
        const tr = Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i-1]), Math.abs(lows[i] - closes[i-1]))
        atrArr[i] = (atrArr[i-1] * (atrPeriod - 1) + tr) / atrPeriod
      }
      // SMA del ATR
      let sumAtr = 0
      for (let i = atrPeriod - 1; i < N; i++) {
        sumAtr += atrArr[i]
        const cnt = i - (atrPeriod - 1) + 1
        if (cnt > atrMaPeriod) sumAtr -= atrArr[i - atrMaPeriod]
        if (cnt >= atrMaPeriod) {
          const atrMa = sumAtr / atrMaPeriod
          atrOk[i] = atrArr[i] <= atrMa * atrMaxMultiplier ? 1 : 0
        }
      }
    }

    // RSI de Wilder — se computa una sola vez (independiente de emaPer)
    const rsiArr = rsiPeriod > 1 && N > rsiPeriod ? rsi(closes, rsiPeriod) : null

    const total        = emaPeriods.length * minWicks.length * sls.length * tps.length
    const REPORT_EVERY = Math.max(500, Math.floor(total / 200))
    const TOP_PER_EMA  = 5
    const periodMap    = new Map()
    let done = 0

    function flattenPeriodMap() {
      const all = []
      for (const bucket of periodMap.values()) for (const c of bucket) all.push(c)
      all.sort((a, b) => b._score - a._score)
      return all
    }

    for (const emaPer of emaPeriods) {
      // Calcular EMA para este período
      const emaArr = ema(closes, emaPer)

      // Pre-cómputo de datos de mecha por vela (independientes de mw/sl/tp)
      const upperWickPct  = new Float64Array(N)
      const lowerWickPct  = new Float64Array(N)
      const canShort      = new Uint8Array(N) // high >= ema AND maxOC < ema
      const canLong       = new Uint8Array(N) // low  <= ema AND minOC > ema

      for (let i = 0; i < N; i++) {
        const ev = emaArr[i]
        if (ev === null) continue
        const h = highs[i], l = lows[i], o = opens[i], c = closes[i]
        const cr = h - l
        if (cr <= 0) continue
        const maxOC = o > c ? o : c
        const minOC = o < c ? o : c
        upperWickPct[i] = (h - maxOC) / cr * 100
        lowerWickPct[i] = (minOC - l) / cr * 100
        const sv        = slowEmaArr ? slowEmaArr[i] : null
        const prevEv    = emaSlopeLookback > 0 && i >= emaSlopeLookback ? emaArr[i - emaSlopeLookback] : null
        const bearish   = sv === null || ev < sv
        const bullish   = sv === null || ev > sv
        const slopeDown = prevEv === null || ev < prevEv
        const slopeUp   = prevEv === null || ev > prevEv
        const bodyRatio = (o > c ? o - c : c - o) / cr * 100
        const bodyOk    = maxBodyPct <= 0 || bodyRatio < maxBodyPct
        // Filtro A: vela direccional — la señal debe ser bajista (SHORT) o alcista (LONG)
        canShort[i] = (h >= ev && maxOC < ev && bearish && slopeDown && bodyOk && c < o) ? 1 : 0
        canLong[i]  = (l <= ev && minOC > ev && bullish && slopeUp   && bodyOk && c > o) ? 1 : 0
      }

      // Primer toque tras cruzar desde el lado opuesto + filtro ATR
      // SHORT: cuerpo debe haber estado >= emaConsistencyBars velas ENCIMA de la EMA antes de cruzar abajo
      // LONG:  cuerpo debe haber estado >= emaConsistencyBars velas DEBAJO  de la EMA antes de cruzar arriba
      const firstTouchShort = new Uint8Array(N)
      const firstTouchLong  = new Uint8Array(N)
      let bodyAboveCount = 0, crossedToBelow = false, firstShortDone = false, crossBodyOkShort = false
      let bodyBelowCount = 0, crossedToAbove = false, firstLongDone  = false, crossBodyOkLong  = false

      for (let i = 0; i < N; i++) {
        const ev = emaArr[i]
        if (ev === null) continue
        const o = opens[i], c = closes[i], h = highs[i], l = lows[i]
        const maxOC = o > c ? o : c
        const minOC = o < c ? o : c
        const cr = h - l

        // Estado SHORT: cuerpo encima → cuerpo debajo
        if (maxOC >= ev) {
          bodyAboveCount++
          crossedToBelow = false; firstShortDone = false; crossBodyOkShort = false
        } else {
          if (bodyAboveCount >= emaConsistencyBars) {
            crossedToBelow = true
            // Filtro C: cruce decisivo — vela bajista con cuerpo suficiente
            crossBodyOkShort = minCrossBodyPct <= 0 || (o > c && cr > 0 && (o - c) / cr * 100 >= minCrossBodyPct)
          }
          bodyAboveCount = 0
        }
        const rsiVal      = rsiArr ? rsiArr[i] : 0
        const rsiOkShort  = rsiPeriod <= 0 || rsiVal === 0 || rsiVal <= rsiShortMax
        firstTouchShort[i] = (canShort[i] && crossedToBelow && crossBodyOkShort && !firstShortDone && atrOk[i] && rsiOkShort) ? 1 : 0
        if (firstTouchShort[i]) firstShortDone = true

        // Estado LONG: cuerpo debajo → cuerpo encima
        if (minOC <= ev) {
          bodyBelowCount++
          crossedToAbove = false; firstLongDone = false; crossBodyOkLong = false
        } else {
          if (bodyBelowCount >= emaConsistencyBars) {
            crossedToAbove = true
            // Filtro C: cruce decisivo — vela alcista con cuerpo suficiente
            crossBodyOkLong = minCrossBodyPct <= 0 || (c > o && cr > 0 && (c - o) / cr * 100 >= minCrossBodyPct)
          }
          bodyBelowCount = 0
        }
        const rsiOkLong = rsiPeriod <= 0 || rsiVal === 0 || rsiVal >= rsiLongMin
        firstTouchLong[i] = (canLong[i] && crossedToAbove && crossBodyOkLong && !firstLongDone && atrOk[i] && rsiOkLong) ? 1 : 0
        if (firstTouchLong[i]) firstLongDone = true
      }

      for (const mw of minWicks) {
        for (const sl of sls) {
          for (const tp of tps) {
            const effTp = Math.max(tp - feeTpPct, 0) * leverage
            const effSl = (sl + feeSlPct) * leverage

            let dailySignalUsed = false
            let tradeOpen       = false
            let tradeTipo       = 0  // 1=SHORT, 2=LONG
            let tradeSl         = 0
            let tradeTp         = 0
            let tradeEntryBar   = -1

            let totalTp = 0, totalSl = 0
            let profitPct = 0, lossPct = 0
            let equityPct = 0, equityPeak = 0, maxDd = 0
            let capital = initialCapital

            for (let i = 0; i < N; i++) {
              if (isNewDay[i]) dailySignalUsed = false

              // Fast-skip: sin trade abierto y señal del día ya usada → saltar al próximo día
              if (!tradeOpen && dailySignalUsed) {
                i = nextDay[i] - 1  // -1 porque el for hace i++
                continue
              }

              // Cerrar trade abierto
              if (tradeOpen && i > tradeEntryBar) {
                const h = highs[i], l = lows[i]
                const slHit = tradeTipo === 1 ? h >= tradeSl : l <= tradeSl
                const tpHit = tradeTipo === 1 ? l <= tradeTp : h >= tradeTp

                if (slHit) {
                  totalSl++
                  lossPct   += effSl
                  equityPct -= effSl
                  equityPeak = Math.max(equityPeak, equityPct)
                  maxDd      = Math.max(maxDd, equityPeak - equityPct)
                  capital   *= (1 - effSl / 100)
                  tradeOpen  = false
                } else if (tpHit) {
                  totalTp++
                  profitPct  += effTp
                  equityPct  += effTp
                  equityPeak  = Math.max(equityPeak, equityPct)
                  maxDd       = Math.max(maxDd, equityPeak - equityPct)
                  capital    *= (1 + effTp / 100)
                  tradeOpen   = false
                }
              }

              // Señal — primer toque desde el lado opuesto + ATR calmado
              if (!dailySignalUsed && !tradeOpen) {
                let sigTipo = 0

                if ((direction === 'R' || direction === 'BOTH') && firstTouchShort[i] && upperWickPct[i] >= mw)
                  sigTipo = 1
                if (!sigTipo && (direction === 'S' || direction === 'BOTH') && firstTouchLong[i] && lowerWickPct[i] >= mw)
                  sigTipo = 2

                if (sigTipo) {
                  dailySignalUsed = true
                  tradeOpen     = true
                  tradeTipo     = sigTipo
                  tradeEntryBar = i
                  const ep = closes[i]
                  tradeSl = sigTipo === 1 ? ep * (1 + sl / 100) : ep * (1 - sl / 100)
                  tradeTp = sigTipo === 1 ? ep * (1 - tp / 100) : ep * (1 + tp / 100)
                }
              }
            }

            const totalClosed = totalTp + totalSl
            const netPct      = profitPct - lossPct

            if (totalClosed >= 3 && netPct > 0) {
              const score = netPct / (maxDd < 0.1 ? 0.1 : maxDd)
              const candidate = {
                emaPeriod:      emaPer,
                minWickPct:     mw,
                slPct:          sl,
                tpPct:          tp,
                totalTp,
                totalSl,
                totalClosed,
                totalProfitPct: profitPct.toFixed(2),
                totalLossPct:   lossPct.toFixed(2),
                totalNetPct:    netPct.toFixed(2),
                winRate:        (totalTp / totalClosed * 100).toFixed(2),
                maxDrawdownPct: maxDd.toFixed(2),
                compoundCapital: capital.toFixed(2),
                _score:         score,
              }
              const key = `${emaPer}`
              if (!periodMap.has(key)) periodMap.set(key, [])
              const bucket = periodMap.get(key)
              if (bucket.length < TOP_PER_EMA) {
                bucket.push(candidate)
                bucket.sort((a, b) => b._score - a._score)
              } else if (score > bucket[TOP_PER_EMA - 1]._score) {
                bucket[TOP_PER_EMA - 1] = candidate
                bucket.sort((a, b) => b._score - a._score)
              }
            }

            done++
            if (done % REPORT_EVERY === 0) {
              self.postMessage({ type: 'progress', done, total, topResults: flattenPeriodMap() })
            }
          }
        }
      }
    }

    self.postMessage({ type: 'done', results: flattenPeriodMap() })
  } catch (err) {
    self.postMessage({ type: 'error', message: err.message })
  }
}
