/**
 * Web Worker — Walk-Forward Analysis
 * Por cada día de trading:
 *   1. Optimiza sobre los últimos N días (ventana de entrenamiento)
 *   2. Aplica la mejor combinación al día actual
 * Devuelve resultados reales acumulados + log día a día.
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
      prevEma = sum / period; result[i] = prevEma
    } else {
      prevEma = values[i] * k + prevEma * (1 - k); result[i] = prevEma
    }
  }
  return result
}

function highest(arr, period, idx) {
  let max = -Infinity
  for (let i = Math.max(0, idx - period + 1); i <= idx; i++) if (arr[i] > max) max = arr[i]
  return max
}

function lowest(arr, period, idx) {
  let min = Infinity
  for (let i = Math.max(0, idx - period + 1); i <= idx; i++) if (arr[i] < min) min = arr[i]
  return min
}

function getColombiaDay(date) {
  const col = new Date(date.getTime() - 5 * 60 * 60 * 1000)
  return `${col.getUTCFullYear()}-${String(col.getUTCMonth()).padStart(2,'0')}-${String(col.getUTCDate()).padStart(2,'0')}`
}

function rangeValues(min, max, step) {
  const vals = [], s = parseFloat(step)
  if (s <= 0) return [parseFloat(min)]
  for (let v = parseFloat(min); v <= parseFloat(max) + 1e-9; v += s)
    vals.push(parseFloat(v.toFixed(6)))
  return vals
}

/**
 * Backtest rápido: usa arrays pre-calculados para no repetir el trabajo.
 * Devuelve sólo { totalClosed, totalNetPct } para la fase de optimización.
 */
function runLite(candles, params, closes, highs, lows, opens, ema10arr, ema50arr) {
  const { minRangePct, maxRangePct, lookbackCandles, minWickPct, slPct, tpPct, feeSlPct, feeTpPct, leverage } = params
  const effectiveTpPct = Math.max(tpPct - feeTpPct, 0) * leverage
  const effectiveSlPct = (slPct + feeSlPct) * leverage

  let activeRangeTop = null, firstRangeTouchDone = false, prevIsTightRange = false
  let dailySignalUsed = false, currentDay = null, openTrades = []
  let totalTp = 0, totalSl = 0, totalProfitPct = 0, totalLossPct = 0

  for (let i = 0; i < candles.length; i++) {
    const high = highs[i], low = lows[i], close = closes[i], open = opens[i]
    const day = getColombiaDay(new Date(candles[i].OpenTime))
    if (day !== currentDay) { currentDay = day; dailySignalUsed = false }

    const highestPrice = highest(highs, lookbackCandles, i)
    const lowestPrice  = lowest(lows, lookbackCandles, i)
    const rangePct = close !== 0 ? ((highestPrice - lowestPrice) / close) * 100 : 0
    const isTightRange = rangePct >= minRangePct && rangePct <= maxRangePct
    const newRangeStarted = isTightRange && !prevIsTightRange

    const candleRange = high - low
    const upperWickPct = candleRange > 0 ? ((high - Math.max(open, close)) / candleRange) * 100 : 0
    const isBearishTrend = ema10arr[i] !== null && ema50arr[i] !== null ? ema10arr[i] < ema50arr[i] : false

    if (newRangeStarted) { activeRangeTop = highestPrice; firstRangeTouchDone = false }
    if (!isTightRange)   { activeRangeTop = null; firstRangeTouchDone = false }

    const touch = isTightRange && !firstRangeTouchDone && activeRangeTop !== null &&
      high >= activeRangeTop && candleRange > 0 && upperWickPct >= minWickPct
    if (touch) firstRangeTouchDone = true

    const stillOpen = []
    for (const t of openTrades) {
      if (low <= t.tp)  { totalTp++; totalProfitPct += effectiveTpPct }
      else if (high >= t.sl) { totalSl++; totalLossPct += effectiveSlPct }
      else stillOpen.push(t)
    }
    openTrades = stillOpen

    if (touch && !dailySignalUsed && isBearishTrend) {
      dailySignalUsed = true
      openTrades.push({ price: close, sl: close * (1 + slPct / 100), tp: close * (1 - tpPct / 100) })
    }

    prevIsTightRange = isTightRange
  }

  return { totalClosed: totalTp + totalSl, totalNetPct: totalProfitPct - totalLossPct }
}

/**
 * Backtest completo: devuelve lista de trades con metadatos.
 * Se corre sobre training + current day para garantizar warmup de EMA.
 */
function runFull(candles, params) {
  const { minRangePct, maxRangePct, lookbackCandles, minWickPct, slPct, tpPct } = params

  const closes = candles.map(c => parseFloat(c.CloseCandle))
  const highs   = candles.map(c => parseFloat(c.HighCandle))
  const lows    = candles.map(c => parseFloat(c.LowCandle))
  const opens   = candles.map(c => parseFloat(c.OpenCandle))
  const ema10arr = ema(closes, 10)
  const ema50arr = ema(closes, 50)

  let activeRangeTop = null, firstRangeTouchDone = false, prevIsTightRange = false
  let dailySignalUsed = false, currentDay = null, openTrades = []
  const trades = []

  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i]
    const high = highs[i], low = lows[i], close = closes[i], open = opens[i]
    const day = getColombiaDay(new Date(candle.OpenTime))
    if (day !== currentDay) { currentDay = day; dailySignalUsed = false }

    const highestPrice = highest(highs, lookbackCandles, i)
    const lowestPrice  = lowest(lows, lookbackCandles, i)
    const rangePct = close !== 0 ? ((highestPrice - lowestPrice) / close) * 100 : 0
    const isTightRange = rangePct >= minRangePct && rangePct <= maxRangePct
    const newRangeStarted = isTightRange && !prevIsTightRange

    const candleRange = high - low
    const upperWickPct = candleRange > 0 ? ((high - Math.max(open, close)) / candleRange) * 100 : 0
    const isBearishTrend = ema10arr[i] !== null && ema50arr[i] !== null ? ema10arr[i] < ema50arr[i] : false

    if (newRangeStarted) { activeRangeTop = highestPrice; firstRangeTouchDone = false }
    if (!isTightRange)   { activeRangeTop = null; firstRangeTouchDone = false }

    const touch = isTightRange && !firstRangeTouchDone && activeRangeTop !== null &&
      high >= activeRangeTop && candleRange > 0 && upperWickPct >= minWickPct
    if (touch) firstRangeTouchDone = true

    const stillOpen = []
    for (const t of openTrades) {
      if (low <= t.tp)       trades.push({ ...t, result: 'TP', closeTime: candle.OpenTime, closePrice: t.tp })
      else if (high >= t.sl) trades.push({ ...t, result: 'SL', closeTime: candle.OpenTime, closePrice: t.sl })
      else stillOpen.push(t)
    }
    openTrades = stillOpen

    if (touch && !dailySignalUsed && isBearishTrend) {
      dailySignalUsed = true
      openTrades.push({
        time: candle.OpenTime,
        price: close,
        sl: close * (1 + slPct / 100),
        tp: close * (1 - tpPct / 100),
      })
    }

    prevIsTightRange = isTightRange
  }

  return { trades }
}

// ── Entrada del Worker ──
self.onmessage = function (e) {
  const { candles, optimRanges, params, trainingDays } = e.data

  try {
    // 1. Agrupar velas por día Colombia
    const dayGroups = new Map()
    for (const c of candles) {
      const day = getColombiaDay(new Date(c.OpenTime))
      if (!dayGroups.has(day)) dayGroups.set(day, [])
      dayGroups.get(day).push(c)
    }
    const days = [...dayGroups.keys()].sort()

    if (days.length <= trainingDays) {
      self.postMessage({ type: 'error', message: `Necesitas más de ${trainingDays} días en el rango de fechas.` })
      return
    }

    // 2. Construir todas las combinaciones de parámetros
    const minRangeArr  = rangeValues(optimRanges.minRangePct.min,     optimRanges.minRangePct.max,     optimRanges.minRangePct.step)
    const maxRangeArr  = rangeValues(optimRanges.maxRangePct.min,     optimRanges.maxRangePct.max,     optimRanges.maxRangePct.step)
    const lookbackArr  = rangeValues(optimRanges.lookbackCandles.min, optimRanges.lookbackCandles.max, optimRanges.lookbackCandles.step)
    const minWickArr   = rangeValues(optimRanges.minWickPct.min,      optimRanges.minWickPct.max,      optimRanges.minWickPct.step)
    const slArr        = rangeValues(optimRanges.slPct.min,           optimRanges.slPct.max,           optimRanges.slPct.step)
    const tpArr        = rangeValues(optimRanges.tpPct.min,           optimRanges.tpPct.max,           optimRanges.tpPct.step)

    const combinations = []
    for (const minR of minRangeArr) {
      for (const maxR of maxRangeArr) {
        if (maxR <= minR) continue
        for (const lb of lookbackArr) {
          for (const mw of minWickArr) {
            for (const sl of slArr) {
              for (const tp of tpArr) {
                combinations.push({
                  minRangePct: minR, maxRangePct: maxR,
                  lookbackCandles: Math.round(lb), minWickPct: mw,
                  slPct: sl, tpPct: tp,
                })
              }
            }
          }
        }
      }
    }

    const tradingDays = days.length - trainingDays
    const allTrades = []
    const dayLog = []

    // 3. Walk-Forward: día a día
    for (let d = trainingDays; d < days.length; d++) {
      const trainingDayKeys = days.slice(d - trainingDays, d)
      const trainingCandles = trainingDayKeys.flatMap(k => dayGroups.get(k))

      // Pre-calcular arrays para la ventana de entrenamiento (se reutilizan en todos los combos)
      const closes   = trainingCandles.map(c => parseFloat(c.CloseCandle))
      const highs    = trainingCandles.map(c => parseFloat(c.HighCandle))
      const lows     = trainingCandles.map(c => parseFloat(c.LowCandle))
      const opens    = trainingCandles.map(c => parseFloat(c.OpenCandle))
      const ema10arr = ema(closes, 10)
      const ema50arr = ema(closes, 50)

      // Encontrar la mejor combinación sobre el período de entrenamiento
      let bestNet = -Infinity
      let bestParams = null

      for (const combo of combinations) {
        const r = runLite(trainingCandles, { ...params, ...combo }, closes, highs, lows, opens, ema10arr, ema50arr)
        if (r.totalClosed >= 3 && r.totalNetPct > bestNet) {
          bestNet = r.totalNetPct
          bestParams = { ...combo }
        }
      }

      const currentDayStr = days[d]
      const currentDayCandles = dayGroups.get(currentDayStr)

      if (bestParams) {
        // Correr backtest completo con contexto (training + día actual) para warmup de EMA
        const contextCandles = [...trainingCandles, ...currentDayCandles]
        const { trades: contextTrades } = runFull(contextCandles, { ...params, ...bestParams })

        // Filtrar solo trades que fueron señalados en el día actual
        const dayTrades = contextTrades.filter(t =>
          getColombiaDay(new Date(t.time)) === currentDayStr
        )

        const effectiveTpPct = Math.max(bestParams.tpPct - params.feeTpPct, 0) * params.leverage
        const effectiveSlPct = (bestParams.slPct + params.feeSlPct) * params.leverage

        dayTrades.forEach(t => {
          t.gainPct = effectiveTpPct
          t.lossPct = effectiveSlPct
          t.paramsUsed = { ...bestParams }
        })

        allTrades.push(...dayTrades)

        const dayTp  = dayTrades.filter(t => t.result === 'TP').length
        const daySl  = dayTrades.filter(t => t.result === 'SL').length
        const dayNet = dayTrades.reduce((s, t) => s + (t.result === 'TP' ? t.gainPct : -t.lossPct), 0)

        dayLog.push({ day: currentDayStr, bestParams, totalTrades: dayTrades.length, tp: dayTp, sl: daySl, netPct: dayNet.toFixed(2) })
      } else {
        dayLog.push({ day: currentDayStr, bestParams: null, totalTrades: 0, tp: 0, sl: 0, netPct: '0.00' })
      }

      self.postMessage({ type: 'progress', day: d - trainingDays + 1, totalDays: tradingDays })
    }

    // 4. Calcular estadísticas acumuladas de todos los trades
    allTrades.sort((a, b) => new Date(a.closeTime) - new Date(b.closeTime))

    let totalTp = 0, totalSl = 0
    let totalProfitPct = 0, totalLossPct = 0
    let equityPct = 0, equityPeakPct = 0, maxDrawdownPct = 0
    let compoundCapital = params.initialCapital
    const monthlyContribution = params.monthlyContribution || 0
    let totalContributed = 0
    let currentContribMonth = null

    for (const t of allTrades) {
      // Monthly contribution based on trade close time
      if (monthlyContribution > 0) {
        const closeTime = new Date(t.closeTime)
        const colTime = new Date(closeTime.getTime() - 5 * 60 * 60 * 1000)
        const contribMonth = `${colTime.getUTCFullYear()}-${colTime.getUTCMonth()}`
        if (currentContribMonth === null) {
          currentContribMonth = contribMonth
        } else if (contribMonth !== currentContribMonth) {
          compoundCapital += monthlyContribution
          totalContributed += monthlyContribution
          currentContribMonth = contribMonth
        }
      }

      if (t.result === 'TP') {
        totalTp++
        totalProfitPct += t.gainPct
        equityPct += t.gainPct
        compoundCapital *= (1 + t.gainPct / 100)
      } else {
        totalSl++
        totalLossPct += t.lossPct
        equityPct -= t.lossPct
        compoundCapital *= (1 - t.lossPct / 100)
      }
      equityPeakPct   = Math.max(equityPeakPct, equityPct)
      maxDrawdownPct  = Math.max(maxDrawdownPct, equityPeakPct - equityPct)
    }

    const totalClosed = totalTp + totalSl
    const totalNetPct = totalProfitPct - totalLossPct
    const winRate     = totalClosed > 0 ? (totalTp / totalClosed) * 100 : 0
    const simpleCapital = params.initialCapital * (1 + totalNetPct / 100) + totalContributed

    self.postMessage({
      type: 'done',
      stats: {
        totalTp, totalSl, totalClosed,
        totalProfitPct:  totalProfitPct.toFixed(2),
        totalLossPct:    totalLossPct.toFixed(2),
        totalNetPct:     totalNetPct.toFixed(2),
        winRate:         winRate.toFixed(2),
        maxDrawdownPct:  maxDrawdownPct.toFixed(2),
        simpleCapital:   simpleCapital.toFixed(2),
        compoundCapital: compoundCapital.toFixed(2),
        totalContributed: totalContributed.toFixed(2),
        trainingDays,
        tradingDays,
      },
      trades: allTrades,
      dayLog,
    })
  } catch (err) {
    self.postMessage({ type: 'error', message: err.message })
  }
}
