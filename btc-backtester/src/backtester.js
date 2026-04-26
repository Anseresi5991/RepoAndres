/**
 * Motor de backtesting — lógica fiel al script Pine Script
 * Recibe velas y parámetros, devuelve estadísticas y lista de trades
 *
 * Parámetro opcional: trailingSteps = [{trigger, newSL}, ...]
 *   trigger: % adverso desde entrada que activa el movimiento de SL
 *   newSL:   nuevo SL en % desde entrada (debe ser menor al SL original)
 *   Sin trailingSteps (default []), el comportamiento es idéntico al original.
 *
 * runMultiBacktest: corre varias combinaciones de parámetros en simultáneo
 *   compartiendo el límite de 1 operación por día. El primer combo (por índice)
 *   que genere señal en un día toma el trade; los demás esperan al día siguiente.
 */

function ema(values, period) {
  const k = 2 / (period + 1)
  const result = new Array(values.length).fill(null)
  let prevEma = null
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) {
      result[i] = null
      continue
    }
    if (prevEma === null) {
      // seed with SMA
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

function highest(arr, period, idx) {
  let max = -Infinity
  for (let i = Math.max(0, idx - period + 1); i <= idx; i++) {
    if (arr[i] > max) max = arr[i]
  }
  return max
}

function lowest(arr, period, idx) {
  let min = Infinity
  for (let i = Math.max(0, idx - period + 1); i <= idx; i++) {
    if (arr[i] < min) min = arr[i]
  }
  return min
}

function getUTCDay(openTimeStr) {
  // La BD almacena UTC — usamos la fecha UTC del string tal cual
  return openTimeStr.substring(0, 10)
}

export function runBacktest(candles, params) {
  const {
    minRangePct,
    maxRangePct,
    lookbackCandles,
    minWickPct,
    slPct,
    tpPct,
    feeSlPct,
    feeTpPct,
    leverage,
    initialCapital,
    monthlyContribution = 0,
    resistances, // [res1, res2, res3]
    useTimeFilter,
    trailingSteps = [], // [{trigger: %, newSL: %}] — opcional
    emaMinGapPct = 0,
  } = params

  const closes = candles.map(c => parseFloat(c.CloseCandle))
  const highs  = candles.map(c => parseFloat(c.HighCandle))
  const lows   = candles.map(c => parseFloat(c.LowCandle))
  const opens  = candles.map(c => parseFloat(c.OpenCandle))

  const ema10arr = ema(closes, 10)
  const ema50arr = ema(closes, 50)

  const effectiveTpPct = Math.max(tpPct - feeTpPct, 0) * leverage
  const effectiveSlPct = (slPct + feeSlPct) * leverage

  // State
  let activeRangeTop = null
  let firstRangeTouchDone = false
  let prevIsTightRange = false

  let dailySignalUsed = false
  let currentDay = null

  let openTrades = [] // múltiples trades abiertos simultáneamente

  // Stats
  let totalTp = 0
  let totalSl = 0
  let totalClosed = 0
  let totalProfitPct = 0
  let totalLossPct = 0
  let totalNetPct = 0
  let equityPct = 0
  let equityPeakPct = 0
  let maxDrawdownPct = 0
  let compoundCapital = initialCapital
  let simpleCapital = initialCapital
  let totalContributed = 0
  let currentContribMonth = null

  const trades = []
  const signals = []
  const debugLog = []

  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i]
    const high  = highs[i]
    const low   = lows[i]
    const close = closes[i]
    const open  = opens[i]

    // Day reset — fecha Colombia local tal cual viene de la BD
    const day = getUTCDay(candle.OpenTime)
    const newDay = day !== currentDay
    if (newDay) {
      currentDay = day
      dailySignalUsed = false
    }

    // Monthly contribution
    if (monthlyContribution > 0) {
      const contribMonth = candle.OpenTime.substring(0, 7)
      if (currentContribMonth === null) {
        currentContribMonth = contribMonth
      } else if (contribMonth !== currentContribMonth) {
        compoundCapital += monthlyContribution
        totalContributed += monthlyContribution
        currentContribMonth = contribMonth
      }
    }

    // Range calcs
    const highestPrice = highest(highs, lookbackCandles, i)
    const lowestPrice  = lowest(lows,  lookbackCandles, i)
    const rangeUsd = highestPrice - lowestPrice
    const rangePct = close !== 0 ? (rangeUsd / close) * 100 : 0

    const isTightRange = rangePct >= minRangePct && rangePct <= maxRangePct
    const newRangeStarted = isTightRange && !prevIsTightRange

    // Candle metrics
    const candleRange = high - low
    const upperWick = high - Math.max(open, close)
    const upperWickPct = candleRange > 0 ? (upperWick / candleRange) * 100 : 0

    // EMA trend
    const emaGapPct = (ema10arr[i] !== null && ema50arr[i] !== null && ema50arr[i] > 0)
      ? (ema50arr[i] - ema10arr[i]) / ema50arr[i] * 100 : 0
    const isBearishTrend = ema10arr[i] !== null && ema50arr[i] !== null
      ? ema10arr[i] < ema50arr[i] && emaGapPct >= emaMinGapPct
      : false

    // Range state machine
    if (newRangeStarted) {
      activeRangeTop = highestPrice
      firstRangeTouchDone = false
    }
    if (!isTightRange) {
      activeRangeTop = null
      firstRangeTouchDone = false
    }

    // Touch range top with wick
    const touchRangeTop =
      isTightRange &&
      !firstRangeTouchDone &&
      activeRangeTop !== null &&
      high >= activeRangeTop &&
      candleRange > 0 &&
      upperWickPct >= minWickPct

    // Resistance touch
    const isResistanceTouch = (level) =>
      level > 0 && high >= level && candleRange > 0 && upperWickPct >= minWickPct

    // Check TP / SL para trades ya abiertos ANTES de procesar la señal de este candle
    // (un trade abierto en este candle solo se evalúa a partir del siguiente)
    const stillOpen = []
    for (const t of openTrades) {
      // ── MAE: cuánto subió el precio desde la entrada (adverso para un short) ──
      const adversePct = (high - t.price) / t.price * 100
      if (adversePct > t.maxAdverse) t.maxAdverse = adversePct

      // ── Trailing SL: apretar SL si el adverso supera el trigger ──
      // Solo puede reducirse (acercarse a la entrada), nunca aumentarse
      for (const step of trailingSteps) {
        if (adversePct >= step.trigger && step.newSL < t.currentSLpct) {
          t.currentSLpct = step.newSL
        }
      }

      const dynamicSL = t.price * (1 + t.currentSLpct / 100)
      const tpHit = low <= t.tp
      const slHit = high >= dynamicSL

      if (tpHit) {
        totalTp++
        totalClosed++
        totalProfitPct += effectiveTpPct
        totalNetPct = totalProfitPct - totalLossPct
        equityPct += effectiveTpPct
        equityPeakPct = Math.max(equityPeakPct, equityPct)
        maxDrawdownPct = Math.max(maxDrawdownPct, equityPeakPct - equityPct)
        simpleCapital = initialCapital * (1 + totalNetPct / 100)
        compoundCapital = compoundCapital * (1 + effectiveTpPct / 100)
        trades.push({ ...t, result: 'TP', closeTime: candle.OpenTime, closePrice: t.tp, capitalAtExit: compoundCapital })
      } else if (slHit) {
        // Con trailing, la pérdida real es menor si el SL fue acercado
        const actualLossPct = (t.currentSLpct + feeSlPct) * leverage
        totalSl++
        totalClosed++
        totalLossPct += actualLossPct
        totalNetPct = totalProfitPct - totalLossPct
        equityPct -= actualLossPct
        equityPeakPct = Math.max(equityPeakPct, equityPct)
        maxDrawdownPct = Math.max(maxDrawdownPct, equityPeakPct - equityPct)
        simpleCapital = initialCapital * (1 + totalNetPct / 100)
        compoundCapital = compoundCapital * (1 - actualLossPct / 100)
        trades.push({ ...t, result: 'SL', closeTime: candle.OpenTime, closePrice: dynamicSL, capitalAtExit: compoundCapital })
      } else {
        stillOpen.push(t)
      }
    }
    openTrades = stillOpen

    const firstRangeResistanceAlert = touchRangeTop

    // Final signal: only 1 per day, needs bearish trend
    const rawSignal = firstRangeResistanceAlert
    const canFireNow = !dailySignalUsed
    const finalResistanceSignal = rawSignal && canFireNow && isBearishTrend

    if (finalResistanceSignal) {
      dailySignalUsed = true
      firstRangeTouchDone = true

      const ep  = close
      const sl  = ep * (1 + slPct / 100)
      const tp  = ep * (1 - tpPct / 100)

      const signal = {
        time: candle.OpenTime,
        price: ep,
        sl,
        tp,
        rangePct: rangePct.toFixed(3),
        upperWickPct: upperWickPct.toFixed(2)
      }
      signals.push(signal)
      openTrades.push({ ...signal, maxAdverse: 0, currentSLpct: slPct, capitalAtEntry: compoundCapital })
    }

    debugLog.push({
      time:               candle.OpenTime,
      open:               open.toFixed(2),
      high:               high.toFixed(2),
      low:                low.toFixed(2),
      close:              close.toFixed(2),
      day,
      ema10:              ema10arr[i] !== null ? ema10arr[i].toFixed(2) : null,
      ema50:              ema50arr[i] !== null ? ema50arr[i].toFixed(2) : null,
      isBearishTrend,
      highestPrice:       highest(highs, lookbackCandles, i).toFixed(2),
      lowestPrice:        lowest(lows, lookbackCandles, i).toFixed(2),
      rangePct:           rangePct.toFixed(3),
      isTightRange,
      activeRangeTop:     activeRangeTop !== null ? activeRangeTop.toFixed(2) : null,
      firstRangeTouchDone,
      candleRange:        candleRange.toFixed(2),
      upperWick:          upperWick.toFixed(2),
      upperWickPct:       upperWickPct.toFixed(2),
      touchRangeTop,
      dailySignalUsed,
      finalResistanceSignal,
    })

    prevIsTightRange = isTightRange
  }

  const winRate = totalClosed > 0 ? (totalTp / totalClosed) * 100 : 0
  const bestMethod = compoundCapital > simpleCapital ? 'Compuesto' : simpleCapital > compoundCapital ? 'Simple' : 'Iguales'

  // ── MAE stats (solo trades TP — los que llegaron al objetivo) ──
  const maeArr = trades.filter(t => t.result === 'TP').map(t => t.maxAdverse)
  const maeAvgTp    = maeArr.length > 0 ? maeArr.reduce((a, b) => a + b, 0) / maeArr.length : 0
  const maeSorted   = [...maeArr].sort((a, b) => a - b)
  const maeMedianTp = maeSorted.length > 0 ? maeSorted[Math.floor(maeSorted.length / 2)] : 0
  const maeMaxTp    = maeSorted.length > 0 ? maeSorted[maeSorted.length - 1] : 0

  // Distribución en buckets
  const BUCKETS = [0.1, 0.2, 0.3, 0.4, 0.5, 0.75, 1.0]
  const maeDist = []
  let prev = 0
  for (const b of BUCKETS) {
    maeDist.push({ from: prev, to: b, count: maeArr.filter(v => v >= prev && v < b).length })
    prev = b
  }
  maeDist.push({ from: prev, to: Infinity, count: maeArr.filter(v => v >= prev).length })

  return {
    stats: {
      totalTp,
      totalSl,
      totalClosed,
      totalProfitPct: totalProfitPct.toFixed(2),
      totalLossPct: totalLossPct.toFixed(2),
      totalNetPct: totalNetPct.toFixed(2),
      winRate: winRate.toFixed(2),
      maxDrawdownPct: maxDrawdownPct.toFixed(2),
      simpleCapital: (simpleCapital + totalContributed).toFixed(2),
      compoundCapital: compoundCapital.toFixed(2),
      bestMethod,
      effectiveTpPct: effectiveTpPct.toFixed(3),
      effectiveSlPct: effectiveSlPct.toFixed(3),
      totalContributed: totalContributed.toFixed(2),
      // MAE
      maeAvgTp:    maeAvgTp.toFixed(3),
      maeMedianTp: maeMedianTp.toFixed(3),
      maeMaxTp:    maeMaxTp.toFixed(3),
      maeDist,
    },
    trades,
    signals,
    debugLog,
  }
}

/**
 * Backtest multi-combinación: hasta 4 conjuntos de parámetros en simultáneo.
 * Cada combo tiene su propia máquina de estados de rango, pero comparten el
 * límite de 1 operación por día (Colombia UTC-5). El primer combo por índice
 * que dispare señal en un día toma el trade; los demás no operan ese día.
 *
 * @param {object[]} combos  Array de {label, minRangePct, maxRangePct, lookbackCandles, minWickPct, slPct, tpPct}
 * @param {object}   shared  {feeSlPct, feeTpPct, leverage, initialCapital, monthlyContribution}
 */
export function runMultiBacktest(candles, combos, shared) {
  const { feeSlPct, feeTpPct, leverage, initialCapital, monthlyContribution = 0, emaMinGapPct = 0 } = shared

  const closes = candles.map(c => parseFloat(c.CloseCandle))
  const highs  = candles.map(c => parseFloat(c.HighCandle))
  const lows   = candles.map(c => parseFloat(c.LowCandle))
  const opens  = candles.map(c => parseFloat(c.OpenCandle))

  const ema10arr = ema(closes, 10)
  const ema50arr = ema(closes, 50)

  // Estado independiente por combo
  const states = combos.map(() => ({
    activeRangeTop: null,
    firstRangeTouchDone: false,
    prevIsTightRange: false,
  }))

  // Estado compartido
  let dailySignalUsed = false
  let currentDay = null
  let openTrades = []

  let totalTp = 0, totalSl = 0, totalClosed = 0
  let totalProfitPct = 0, totalLossPct = 0, totalNetPct = 0
  let equityPct = 0, equityPeakPct = 0, maxDrawdownPct = 0
  let compoundCapital = initialCapital
  let simpleCapital = initialCapital
  let totalContributed = 0
  let currentContribMonth = null

  const trades = []
  const signals = []

  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i]
    const high = highs[i], low = lows[i], close = closes[i], open = opens[i]

    const day = getUTCDay(candle.OpenTime)
    if (day !== currentDay) { currentDay = day; dailySignalUsed = false }

    // Aporte mensual
    if (monthlyContribution > 0) {
      const contribMonth = candle.OpenTime.substring(0, 7)
      if (currentContribMonth === null) {
        currentContribMonth = contribMonth
      } else if (contribMonth !== currentContribMonth) {
        compoundCapital += monthlyContribution
        totalContributed += monthlyContribution
        currentContribMonth = contribMonth
      }
    }

    const _emaGapPct = (ema10arr[i] !== null && ema50arr[i] !== null && ema50arr[i] > 0)
      ? (ema50arr[i] - ema10arr[i]) / ema50arr[i] * 100 : 0
    const isBearishTrend = ema10arr[i] !== null && ema50arr[i] !== null
      ? ema10arr[i] < ema50arr[i] && _emaGapPct >= emaMinGapPct : false

    const candleRange = high - low
    const upperWick = high - Math.max(open, close)
    const upperWickPct = candleRange > 0 ? (upperWick / candleRange) * 100 : 0

    // ── Cerrar trades abiertos (TP/SL) ──
    // Cada trade guarda su propio effectiveTpPct / effectiveSlPct
    const stillOpen = []
    for (const t of openTrades) {
      const adversePct = (high - t.price) / t.price * 100
      if (adversePct > t.maxAdverse) t.maxAdverse = adversePct

      const tpHit = low <= t.tp
      const slHit = high >= t.sl

      if (tpHit) {
        totalTp++; totalClosed++
        totalProfitPct += t.effectiveTpPct
        totalNetPct = totalProfitPct - totalLossPct
        equityPct += t.effectiveTpPct
        equityPeakPct = Math.max(equityPeakPct, equityPct)
        maxDrawdownPct = Math.max(maxDrawdownPct, equityPeakPct - equityPct)
        simpleCapital = initialCapital * (1 + totalNetPct / 100)
        compoundCapital = compoundCapital * (1 + t.effectiveTpPct / 100)
        trades.push({ ...t, result: 'TP', closeTime: candle.OpenTime, closePrice: t.tp, capitalAtExit: compoundCapital })
      } else if (slHit) {
        totalSl++; totalClosed++
        totalLossPct += t.effectiveSlPct
        totalNetPct = totalProfitPct - totalLossPct
        equityPct -= t.effectiveSlPct
        equityPeakPct = Math.max(equityPeakPct, equityPct)
        maxDrawdownPct = Math.max(maxDrawdownPct, equityPeakPct - equityPct)
        simpleCapital = initialCapital * (1 + totalNetPct / 100)
        compoundCapital = compoundCapital * (1 - t.effectiveSlPct / 100)
        trades.push({ ...t, result: 'SL', closeTime: candle.OpenTime, closePrice: t.sl, capitalAtExit: compoundCapital })
      } else {
        stillOpen.push(t)
      }
    }
    openTrades = stillOpen

    // ── Evaluar todos los combos (actualizar estado de rango siempre) ──
    // Solo el primero que dispare y el día esté libre abre operación.
    let firedCombo = null

    for (let ci = 0; ci < combos.length; ci++) {
      const combo = combos[ci]
      const state = states[ci]

      const highestPrice = highest(highs, combo.lookbackCandles, i)
      const lowestPrice  = lowest(lows,  combo.lookbackCandles, i)
      const rangeUsd = highestPrice - lowestPrice
      const rangePct = close !== 0 ? (rangeUsd / close) * 100 : 0

      const isTightRange = rangePct >= combo.minRangePct && rangePct <= combo.maxRangePct
      const newRangeStarted = isTightRange && !state.prevIsTightRange

      if (newRangeStarted) { state.activeRangeTop = highestPrice; state.firstRangeTouchDone = false }
      if (!isTightRange)   { state.activeRangeTop = null; state.firstRangeTouchDone = false }

      const touchRangeTop =
        isTightRange && !state.firstRangeTouchDone && state.activeRangeTop !== null &&
        high >= state.activeRangeTop && candleRange > 0 && upperWickPct >= combo.minWickPct

      const fired = touchRangeTop && isBearishTrend

      // Solo anotar el primero que disparó (respeta índice de prioridad)
      if (fired && !dailySignalUsed && firedCombo === null) {
        firedCombo = { ci, combo, rangePct }
      }

      state.prevIsTightRange = isTightRange
    }

    if (firedCombo !== null) {
      dailySignalUsed = true
      states[firedCombo.ci].firstRangeTouchDone = true
      const { ci, combo, rangePct } = firedCombo
      const ep = close
      const sl = ep * (1 + combo.slPct / 100)
      const tp = ep * (1 - combo.tpPct / 100)
      const effectiveTpPct = Math.max(combo.tpPct - feeTpPct, 0) * leverage
      const effectiveSlPct = (combo.slPct + feeSlPct) * leverage

      const sig = {
        time: candle.OpenTime,
        price: ep, sl, tp,
        rangePct: rangePct.toFixed(3),
        upperWickPct: upperWickPct.toFixed(2),
        comboIndex: ci,
        comboLabel: combo.label || `Combo ${ci + 1}`,
        effectiveTpPct,
        effectiveSlPct,
      }
      signals.push(sig)
      openTrades.push({ ...sig, maxAdverse: 0, capitalAtEntry: compoundCapital })
    }
  }

  const winRate = totalClosed > 0 ? (totalTp / totalClosed) * 100 : 0
  const bestMethod = compoundCapital > simpleCapital ? 'Compuesto' : simpleCapital > compoundCapital ? 'Simple' : 'Iguales'

  const maeArr = trades.filter(t => t.result === 'TP').map(t => t.maxAdverse)
  const maeAvgTp    = maeArr.length > 0 ? maeArr.reduce((a, b) => a + b, 0) / maeArr.length : 0
  const maeSorted   = [...maeArr].sort((a, b) => a - b)
  const maeMedianTp = maeSorted.length > 0 ? maeSorted[Math.floor(maeSorted.length / 2)] : 0
  const maeMaxTp    = maeSorted.length > 0 ? maeSorted[maeSorted.length - 1] : 0

  const BUCKETS2 = [0.1, 0.2, 0.3, 0.4, 0.5, 0.75, 1.0]
  const maeDist = []
  let prev2 = 0
  for (const b of BUCKETS2) {
    maeDist.push({ from: prev2, to: b, count: maeArr.filter(v => v >= prev2 && v < b).length })
    prev2 = b
  }
  maeDist.push({ from: prev2, to: Infinity, count: maeArr.filter(v => v >= prev2).length })

  return {
    isMulti: true,
    stats: {
      totalTp, totalSl, totalClosed,
      totalProfitPct: totalProfitPct.toFixed(2),
      totalLossPct:   totalLossPct.toFixed(2),
      totalNetPct:    totalNetPct.toFixed(2),
      winRate:        winRate.toFixed(2),
      maxDrawdownPct: maxDrawdownPct.toFixed(2),
      simpleCapital:  (simpleCapital + totalContributed).toFixed(2),
      compoundCapital: compoundCapital.toFixed(2),
      bestMethod,
      totalContributed: totalContributed.toFixed(2),
      maeAvgTp:    maeAvgTp.toFixed(3),
      maeMedianTp: maeMedianTp.toFixed(3),
      maeMaxTp:    maeMaxTp.toFixed(3),
      maeDist,
    },
    trades,
    signals,
  }
}
