/**
 * Backtester — Rango Dinámico + Toque con Mecha (SHORT y LONG)
 *
 * Diferencias clave vs backtester.js:
 *  - slBufferPct: % adicional sobre el High (SHORT) o bajo el Low (LONG) para el SL
 *    (NO es % desde la entrada — se calcula dinámicamente por vela señal)
 *  - Soporta trades SHORT (techo de rango) y LONG (piso de rango)
 *  - 1 trade por día (UTC), el primero que dispare gana prioridad
 */

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
  return openTimeStr.substring(0, 10)
}

/**
 * @param {object[]} candles
 * @param {object}   params
 *   minRangePct, maxRangePct, lookbackCandles, minWickPct,
 *   slBufferPct, tpPct, feeSlPct, feeTpPct, leverage,
 *   initialCapital, monthlyContribution, useTimeFilter
 */
export function runBacktest(candles, params) {
  const {
    minRangePct,
    maxRangePct,
    lookbackCandles,
    minWickPct,
    slBufferPct,
    tpPct,
    feeSlPct,
    feeTpPct,
    leverage,
    initialCapital,
    monthlyContribution = 0,
  } = params

  const closes = candles.map(c => parseFloat(c.CloseCandle))
  const highs  = candles.map(c => parseFloat(c.HighCandle))
  const lows   = candles.map(c => parseFloat(c.LowCandle))
  const opens  = candles.map(c => parseFloat(c.OpenCandle))

  const effectiveTpPct = Math.max(tpPct - feeTpPct, 0) * leverage

  // Range state
  let activeRangeTop    = null
  let activeRangeBottom = null
  let firstTouchDone    = false
  let prevIsTightRange  = false

  // Daily limit
  let dailySignalUsed = false
  let currentDay      = null

  // Open trades (single trade at a time — same 1/day logic, but we keep the array
  // pattern so the evaluation loop is consistent with the multi-combo version)
  let openTrades = []

  // Stats
  let totalTp = 0, totalSl = 0, totalClosed = 0
  let totalProfitPct = 0, totalLossPct = 0, totalNetPct = 0
  let equityPct = 0, equityPeakPct = 0, maxDrawdownPct = 0
  let compoundCapital = initialCapital
  let simpleCapital   = initialCapital
  let totalContributed = 0
  let currentContribMonth = null

  const trades   = []
  const signals  = []
  const debugLog = []

  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i]
    const high   = highs[i]
    const low    = lows[i]
    const close  = closes[i]
    const open   = opens[i]

    // Day reset
    const day = getUTCDay(candle.OpenTime)
    if (day !== currentDay) {
      currentDay = day
      dailySignalUsed = false
    }

    // Monthly contribution
    if (monthlyContribution > 0) {
      const contribMonth = candle.OpenTime.substring(0, 7)
      if (currentContribMonth === null) {
        currentContribMonth = contribMonth
      } else if (contribMonth !== currentContribMonth) {
        compoundCapital  += monthlyContribution
        totalContributed += monthlyContribution
        currentContribMonth = contribMonth
      }
    }

    // Range calcs
    const highestPrice = highest(highs, lookbackCandles, i)
    const lowestPrice  = lowest(lows,  lookbackCandles, i)
    const rangeUsd     = highestPrice - lowestPrice
    const rangePct     = close !== 0 ? (rangeUsd / close) * 100 : 0

    const isTightRange    = rangePct >= minRangePct && rangePct <= maxRangePct
    const newRangeStarted = isTightRange && !prevIsTightRange

    // Candle metrics
    const candleRange   = high - low
    const upperWick     = high - Math.max(open, close)
    const lowerWick     = Math.min(open, close) - low
    const upperWickPct  = candleRange > 0 ? (upperWick / candleRange) * 100 : 0
    const lowerWickPct  = candleRange > 0 ? (lowerWick / candleRange) * 100 : 0

    // Range state machine
    if (newRangeStarted) {
      activeRangeTop    = highestPrice
      activeRangeBottom = lowestPrice
      firstTouchDone    = false
    }
    if (!isTightRange) {
      activeRangeTop    = null
      activeRangeBottom = null
      firstTouchDone    = false
    }

    // Raw touches
    const touchRangeTop =
      isTightRange && !firstTouchDone && activeRangeTop !== null &&
      high >= activeRangeTop && candleRange > 0 && upperWickPct >= minWickPct

    const touchRangeBottom =
      isTightRange && !firstTouchDone && activeRangeBottom !== null &&
      low <= activeRangeBottom && candleRange > 0 && lowerWickPct >= minWickPct

    // --- Evaluate TP/SL for open trades BEFORE opening new ones ---
    // (trades opened this candle have entryBarIdx === i, skip them below)
    const stillOpen = []
    for (const t of openTrades) {
      if (t.entryBarIdx === i) {
        stillOpen.push(t)
        continue
      }

      let tpHit = false
      let slHit = false

      if (t.tipo === 'SHORT') {
        tpHit = low  <= t.tp
        slHit = high >= t.sl
      } else {
        tpHit = high >= t.tp
        slHit = low  <= t.sl
      }

      if (slHit) {
        const actualSlPct = t.effectiveSlPct
        totalSl++; totalClosed++
        totalLossPct  += actualSlPct
        totalNetPct    = totalProfitPct - totalLossPct
        equityPct     -= actualSlPct
        equityPeakPct  = Math.max(equityPeakPct, equityPct)
        maxDrawdownPct = Math.max(maxDrawdownPct, equityPeakPct - equityPct)
        simpleCapital    = initialCapital * (1 + totalNetPct / 100)
        compoundCapital  = compoundCapital * (1 - actualSlPct / 100)
        trades.push({ ...t, result: 'SL', closeTime: candle.OpenTime, closePrice: t.sl, capitalAtExit: compoundCapital })
      } else if (tpHit) {
        totalTp++; totalClosed++
        totalProfitPct += t.effectiveTpPct
        totalNetPct     = totalProfitPct - totalLossPct
        equityPct      += t.effectiveTpPct
        equityPeakPct   = Math.max(equityPeakPct, equityPct)
        maxDrawdownPct  = Math.max(maxDrawdownPct, equityPeakPct - equityPct)
        simpleCapital    = initialCapital * (1 + totalNetPct / 100)
        compoundCapital  = compoundCapital * (1 + t.effectiveTpPct / 100)
        trades.push({ ...t, result: 'TP', closeTime: candle.OpenTime, closePrice: t.tp, capitalAtExit: compoundCapital })
      } else {
        stillOpen.push(t)
      }
    }
    openTrades = stillOpen

    // --- Open new trade (max 1 per day, SHORT has priority over LONG) ---
    const canFireNow = !dailySignalUsed && openTrades.length === 0

    if (touchRangeTop && canFireNow) {
      dailySignalUsed = true
      firstTouchDone  = true

      const slPrice       = high * (1 + slBufferPct / 100)
      const slPctFromEntry = (slPrice - close) / close * 100
      const tp            = close * (1 - tpPct / 100)
      const effTpPct      = Math.max(tpPct - feeTpPct, 0) * leverage
      const effSlPct      = (slPctFromEntry + feeSlPct) * leverage

      const sig = {
        time: candle.OpenTime, price: close, sl: slPrice, tp,
        tipo: 'SHORT', rangePct: rangePct.toFixed(3),
        upperWickPct: upperWickPct.toFixed(2),
        effectiveTpPct: effTpPct, effectiveSlPct: effSlPct,
        entryBarIdx: i, capitalAtEntry: compoundCapital,
      }
      signals.push(sig)
      openTrades.push(sig)

    } else if (touchRangeBottom && canFireNow && !touchRangeTop) {
      dailySignalUsed = true
      firstTouchDone  = true

      const slPrice       = low * (1 - slBufferPct / 100)
      const slPctFromEntry = (close - slPrice) / close * 100
      const tp            = close * (1 + tpPct / 100)
      const effTpPct      = Math.max(tpPct - feeTpPct, 0) * leverage
      const effSlPct      = (slPctFromEntry + feeSlPct) * leverage

      const sig = {
        time: candle.OpenTime, price: close, sl: slPrice, tp,
        tipo: 'LONG', rangePct: rangePct.toFixed(3),
        lowerWickPct: lowerWickPct.toFixed(2),
        effectiveTpPct: effTpPct, effectiveSlPct: effSlPct,
        entryBarIdx: i, capitalAtEntry: compoundCapital,
      }
      signals.push(sig)
      openTrades.push(sig)
    }

    debugLog.push({
      time:             candle.OpenTime,
      high:             high.toFixed(2),
      low:              low.toFixed(2),
      close:            close.toFixed(2),
      rangePct:         rangePct.toFixed(3),
      isTightRange,
      activeRangeTop:   activeRangeTop !== null ? activeRangeTop.toFixed(2) : null,
      activeRangeBot:   activeRangeBottom !== null ? activeRangeBottom.toFixed(2) : null,
      upperWickPct:     upperWickPct.toFixed(2),
      lowerWickPct:     lowerWickPct.toFixed(2),
      touchRangeTop,
      touchRangeBottom,
      dailySignalUsed,
    })

    prevIsTightRange = isTightRange
  }

  const winRate = totalClosed > 0 ? (totalTp / totalClosed) * 100 : 0
  const bestMethod = compoundCapital > simpleCapital ? 'Compuesto' : simpleCapital > compoundCapital ? 'Simple' : 'Iguales'

  const maeArr   = trades.filter(t => t.result === 'TP').map(t => t.maxAdverse || 0)
  const maeAvgTp = maeArr.length > 0 ? maeArr.reduce((a, b) => a + b, 0) / maeArr.length : 0

  return {
    stats: {
      totalTp, totalSl, totalClosed,
      totalProfitPct:  totalProfitPct.toFixed(2),
      totalLossPct:    totalLossPct.toFixed(2),
      totalNetPct:     totalNetPct.toFixed(2),
      winRate:         winRate.toFixed(2),
      maxDrawdownPct:  maxDrawdownPct.toFixed(2),
      simpleCapital:   (simpleCapital + totalContributed).toFixed(2),
      compoundCapital: compoundCapital.toFixed(2),
      bestMethod,
      totalContributed: totalContributed.toFixed(2),
      effectiveTpPct:  effectiveTpPct.toFixed(3),
      maeAvgTp:        maeAvgTp.toFixed(3),
    },
    trades,
    signals,
    debugLog,
  }
}

/**
 * Backtest multi-combinación.
 * Cada combo tiene su propia máquina de estado de rango.
 * Comparten el límite de 1 operación por día (UTC).
 * Prioridad: índice más bajo del combo que dispare primero.
 * Dentro del mismo combo, SHORT tiene prioridad sobre LONG.
 *
 * @param {object[]} combos  Array de {label, minRangePct, maxRangePct, lookbackCandles, minWickPct, slBufferPct, tpPct}
 * @param {object}   shared  {feeSlPct, feeTpPct, leverage, initialCapital, monthlyContribution}
 */
export function runMultiBacktest(candles, combos, shared) {
  const { feeSlPct, feeTpPct, leverage, initialCapital, monthlyContribution = 0 } = shared

  const closes = candles.map(c => parseFloat(c.CloseCandle))
  const highs  = candles.map(c => parseFloat(c.HighCandle))
  const lows   = candles.map(c => parseFloat(c.LowCandle))
  const opens  = candles.map(c => parseFloat(c.OpenCandle))

  const states = combos.map(() => ({
    activeRangeTop:    null,
    activeRangeBottom: null,
    firstTouchDone:    false,
    prevIsTightRange:  false,
  }))

  let dailySignalUsed = false
  let currentDay      = null
  let openTrades      = []

  let totalTp = 0, totalSl = 0, totalClosed = 0
  let totalProfitPct = 0, totalLossPct = 0, totalNetPct = 0
  let equityPct = 0, equityPeakPct = 0, maxDrawdownPct = 0
  let compoundCapital = initialCapital
  let simpleCapital   = initialCapital
  let totalContributed = 0
  let currentContribMonth = null

  const trades  = []
  const signals = []

  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i]
    const high = highs[i], low = lows[i], close = closes[i], open = opens[i]

    const day = getUTCDay(candle.OpenTime)
    if (day !== currentDay) { currentDay = day; dailySignalUsed = false }

    if (monthlyContribution > 0) {
      const contribMonth = candle.OpenTime.substring(0, 7)
      if (currentContribMonth === null) {
        currentContribMonth = contribMonth
      } else if (contribMonth !== currentContribMonth) {
        compoundCapital  += monthlyContribution
        totalContributed += monthlyContribution
        currentContribMonth = contribMonth
      }
    }

    const candleRange  = high - low
    const upperWick    = high - Math.max(open, close)
    const lowerWick    = Math.min(open, close) - low
    const upperWickPct = candleRange > 0 ? (upperWick / candleRange) * 100 : 0
    const lowerWickPct = candleRange > 0 ? (lowerWick / candleRange) * 100 : 0

    // --- Evaluate TP/SL for open trades ---
    const stillOpen = []
    for (const t of openTrades) {
      if (t.entryBarIdx === i) { stillOpen.push(t); continue }

      let tpHit = false, slHit = false
      if (t.tipo === 'SHORT') {
        tpHit = low  <= t.tp
        slHit = high >= t.sl
      } else {
        tpHit = high >= t.tp
        slHit = low  <= t.sl
      }

      if (slHit) {
        totalSl++; totalClosed++
        totalLossPct  += t.effectiveSlPct
        totalNetPct    = totalProfitPct - totalLossPct
        equityPct     -= t.effectiveSlPct
        equityPeakPct  = Math.max(equityPeakPct, equityPct)
        maxDrawdownPct = Math.max(maxDrawdownPct, equityPeakPct - equityPct)
        simpleCapital    = initialCapital * (1 + totalNetPct / 100)
        compoundCapital  = compoundCapital * (1 - t.effectiveSlPct / 100)
        trades.push({ ...t, result: 'SL', closeTime: candle.OpenTime, closePrice: t.sl, capitalAtExit: compoundCapital })
      } else if (tpHit) {
        totalTp++; totalClosed++
        totalProfitPct += t.effectiveTpPct
        totalNetPct     = totalProfitPct - totalLossPct
        equityPct      += t.effectiveTpPct
        equityPeakPct   = Math.max(equityPeakPct, equityPct)
        maxDrawdownPct  = Math.max(maxDrawdownPct, equityPeakPct - equityPct)
        simpleCapital    = initialCapital * (1 + totalNetPct / 100)
        compoundCapital  = compoundCapital * (1 + t.effectiveTpPct / 100)
        trades.push({ ...t, result: 'TP', closeTime: candle.OpenTime, closePrice: t.tp, capitalAtExit: compoundCapital })
      } else {
        stillOpen.push(t)
      }
    }
    openTrades = stillOpen

    // --- Evaluate all combos, take first that fires ---
    let firedCombo = null

    for (let ci = 0; ci < combos.length; ci++) {
      const combo = combos[ci]
      const state = states[ci]

      const highestPrice = highest(highs, combo.lookbackCandles, i)
      const lowestPrice  = lowest(lows,  combo.lookbackCandles, i)
      const rangeUsd     = highestPrice - lowestPrice
      const rangePct     = close !== 0 ? (rangeUsd / close) * 100 : 0

      const isTightRange    = rangePct >= combo.minRangePct && rangePct <= combo.maxRangePct
      const newRangeStarted = isTightRange && !state.prevIsTightRange

      if (newRangeStarted) {
        state.activeRangeTop    = highestPrice
        state.activeRangeBottom = lowestPrice
        state.firstTouchDone    = false
      }
      if (!isTightRange) {
        state.activeRangeTop    = null
        state.activeRangeBottom = null
        state.firstTouchDone    = false
      }

      const touchRangeTop =
        isTightRange && !state.firstTouchDone && state.activeRangeTop !== null &&
        high >= state.activeRangeTop && candleRange > 0 && upperWickPct >= combo.minWickPct

      const touchRangeBottom =
        isTightRange && !state.firstTouchDone && state.activeRangeBottom !== null &&
        low <= state.activeRangeBottom && candleRange > 0 && lowerWickPct >= combo.minWickPct

      const tipo = touchRangeTop ? 'SHORT' : touchRangeBottom ? 'LONG' : null

      if (tipo && !dailySignalUsed && firedCombo === null) {
        firedCombo = { ci, combo, rangePct, tipo, touchHigh: high, touchLow: low }
      }

      state.prevIsTightRange = isTightRange
    }

    if (firedCombo !== null) {
      dailySignalUsed = true
      states[firedCombo.ci].firstTouchDone = true

      const { ci, combo, rangePct, tipo, touchHigh, touchLow } = firedCombo
      let slPrice, slPctFromEntry, tp, effTpPct, effSlPct

      if (tipo === 'SHORT') {
        slPrice       = touchHigh * (1 + combo.slBufferPct / 100)
        slPctFromEntry = (slPrice - close) / close * 100
        tp             = close * (1 - combo.tpPct / 100)
      } else {
        slPrice       = touchLow * (1 - combo.slBufferPct / 100)
        slPctFromEntry = (close - slPrice) / close * 100
        tp             = close * (1 + combo.tpPct / 100)
      }

      effTpPct = Math.max(combo.tpPct - feeTpPct, 0) * leverage
      effSlPct = (slPctFromEntry + feeSlPct) * leverage

      const sig = {
        time: candle.OpenTime, price: close, sl: slPrice, tp,
        tipo, rangePct: rangePct.toFixed(3),
        comboIndex: ci, comboLabel: combo.label || `Combo ${ci + 1}`,
        effectiveTpPct: effTpPct, effectiveSlPct: effSlPct,
        entryBarIdx: i, capitalAtEntry: compoundCapital,
      }
      signals.push(sig)
      openTrades.push(sig)
    }
  }

  const winRate = totalClosed > 0 ? (totalTp / totalClosed) * 100 : 0
  const bestMethod = compoundCapital > simpleCapital ? 'Compuesto' : simpleCapital > compoundCapital ? 'Simple' : 'Iguales'

  return {
    isMulti: true,
    stats: {
      totalTp, totalSl, totalClosed,
      totalProfitPct:   totalProfitPct.toFixed(2),
      totalLossPct:     totalLossPct.toFixed(2),
      totalNetPct:      totalNetPct.toFixed(2),
      winRate:          winRate.toFixed(2),
      maxDrawdownPct:   maxDrawdownPct.toFixed(2),
      simpleCapital:    (simpleCapital + totalContributed).toFixed(2),
      compoundCapital:  compoundCapital.toFixed(2),
      bestMethod,
      totalContributed: totalContributed.toFixed(2),
    },
    trades,
    signals,
  }
}
