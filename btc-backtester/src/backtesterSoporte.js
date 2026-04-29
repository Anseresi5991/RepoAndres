// =============================================================================
// Rango + Soporte Backtest — Longs en soporte del rango apretado
//
// LONG : rango apretado + precio toca el mínimo del rango con mecha inferior
//        + EMA10 > EMA50 (tendencia alcista)
// =============================================================================

function ema(values, period) {
  const k = 2 / (period + 1)
  const result = new Array(values.length).fill(null)
  let prevEma = null
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) { result[i] = null; continue }
    if (prevEma === null) {
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
  for (let i = Math.max(0, idx - period + 1); i <= idx; i++)
    if (arr[i] > max) max = arr[i]
  return max
}

function lowest(arr, period, idx) {
  let min = Infinity
  for (let i = Math.max(0, idx - period + 1); i <= idx; i++)
    if (arr[i] < min) min = arr[i]
  return min
}

function getUTCDay(openTimeStr) {
  return openTimeStr.substring(0, 10)
}

export function runSoporteBacktest(candles, params) {
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
    trailingSteps = [],
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

  let activeRangeBottom = null
  let firstRangeTouchDone = false
  let prevIsTightRange = false

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

  const trades  = []
  const signals = []
  const debugLog = []

  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i]
    const high  = highs[i]
    const low   = lows[i]
    const close = closes[i]
    const open  = opens[i]

    const day = getUTCDay(candle.OpenTime)
    if (day !== currentDay) { currentDay = day; dailySignalUsed = false }

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

    const highestPrice = highest(highs, lookbackCandles, i)
    const lowestPrice  = lowest(lows,  lookbackCandles, i)
    const rangeUsd = highestPrice - lowestPrice
    const rangePct = close !== 0 ? (rangeUsd / close) * 100 : 0

    const isTightRange    = rangePct >= minRangePct && rangePct <= maxRangePct
    const newRangeStarted = isTightRange && !prevIsTightRange

    const candleRange  = high - low
    const lowerWick    = Math.min(open, close) - low
    const lowerWickPct = candleRange > 0 ? (lowerWick / candleRange) * 100 : 0

    const emaGapPct = (ema10arr[i] !== null && ema50arr[i] !== null && ema10arr[i] > 0)
      ? (ema10arr[i] - ema50arr[i]) / ema10arr[i] * 100 : 0
    const isBullishTrend = ema10arr[i] !== null && ema50arr[i] !== null
      ? ema10arr[i] > ema50arr[i] && emaGapPct >= emaMinGapPct
      : false

    if (newRangeStarted) { activeRangeBottom = lowestPrice; firstRangeTouchDone = false }
    if (!isTightRange)   { activeRangeBottom = null; firstRangeTouchDone = false }

    // Toca el mínimo del rango con mecha inferior
    const touchRangeBottom =
      isTightRange &&
      !firstRangeTouchDone &&
      activeRangeBottom !== null &&
      low <= activeRangeBottom &&
      candleRange > 0 &&
      lowerWickPct >= minWickPct

    // ── Evaluar TP / SL de trades abiertos ──
    const stillOpen = []
    for (const t of openTrades) {
      // adverso para LONG: cuánto bajó el precio desde la entrada
      const adversePct = (t.price - low) / t.price * 100
      if (adversePct > t.maxAdverse) t.maxAdverse = adversePct

      for (const step of trailingSteps) {
        if (adversePct >= step.trigger && step.newSL < t.currentSLpct)
          t.currentSLpct = step.newSL
      }

      const dynamicSL = t.price * (1 - t.currentSLpct / 100)
      const tpHit = high >= t.tp
      const slHit = low <= dynamicSL

      // SL tiene prioridad: colisión TP+SL en misma vela → asumimos SL (conservador)
      if (slHit) {
        const actualLossPct = (t.currentSLpct + feeSlPct) * leverage
        totalSl++; totalClosed++
        totalLossPct += actualLossPct; totalNetPct = totalProfitPct - totalLossPct
        equityPct -= actualLossPct
        equityPeakPct = Math.max(equityPeakPct, equityPct)
        maxDrawdownPct = Math.max(maxDrawdownPct, equityPeakPct - equityPct)
        simpleCapital = initialCapital * (1 + totalNetPct / 100)
        compoundCapital = compoundCapital * (1 - actualLossPct / 100)
        trades.push({ ...t, result: 'SL', closeTime: candle.OpenTime, closePrice: dynamicSL, capitalAtExit: compoundCapital })
      } else if (tpHit) {
        totalTp++; totalClosed++
        totalProfitPct += effectiveTpPct; totalNetPct = totalProfitPct - totalLossPct
        equityPct += effectiveTpPct
        equityPeakPct = Math.max(equityPeakPct, equityPct)
        maxDrawdownPct = Math.max(maxDrawdownPct, equityPeakPct - equityPct)
        simpleCapital = initialCapital * (1 + totalNetPct / 100)
        compoundCapital = compoundCapital * (1 + effectiveTpPct / 100)
        trades.push({ ...t, result: 'TP', closeTime: candle.OpenTime, closePrice: t.tp, capitalAtExit: compoundCapital })
      } else {
        stillOpen.push(t)
      }
    }
    openTrades = stillOpen

    const finalSignal = touchRangeBottom && !dailySignalUsed && isBullishTrend

    if (finalSignal) {
      dailySignalUsed = true
      firstRangeTouchDone = true

      const ep = close
      const sl = ep * (1 - slPct / 100)
      const tp = ep * (1 + tpPct / 100)

      const signal = {
        time: candle.OpenTime,
        price: ep, sl, tp,
        rangePct: rangePct.toFixed(3),
        lowerWickPct: lowerWickPct.toFixed(2),
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
      isBullishTrend,
      highestPrice:       highestPrice.toFixed(2),
      lowestPrice:        lowestPrice.toFixed(2),
      rangePct:           rangePct.toFixed(3),
      isTightRange,
      activeRangeBottom:  activeRangeBottom !== null ? activeRangeBottom.toFixed(2) : null,
      firstRangeTouchDone,
      candleRange:        candleRange.toFixed(2),
      lowerWick:          lowerWick.toFixed(2),
      lowerWickPct:       lowerWickPct.toFixed(2),
      touchRangeBottom,
      dailySignalUsed,
      finalSignal,
    })

    prevIsTightRange = isTightRange
  }

  const winRate = totalClosed > 0 ? (totalTp / totalClosed) * 100 : 0
  const bestMethod = compoundCapital > simpleCapital ? 'Compuesto' : simpleCapital > compoundCapital ? 'Simple' : 'Iguales'

  const maeArr = trades.filter(t => t.result === 'TP').map(t => t.maxAdverse)
  const maeAvgTp    = maeArr.length > 0 ? maeArr.reduce((a, b) => a + b, 0) / maeArr.length : 0
  const maeSorted   = [...maeArr].sort((a, b) => a - b)
  const maeMedianTp = maeSorted.length > 0 ? maeSorted[Math.floor(maeSorted.length / 2)] : 0
  const maeMaxTp    = maeSorted.length > 0 ? maeSorted[maeSorted.length - 1] : 0

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
      totalTp, totalSl, totalClosed,
      totalProfitPct: totalProfitPct.toFixed(2),
      totalLossPct:   totalLossPct.toFixed(2),
      totalNetPct:    totalNetPct.toFixed(2),
      winRate:        winRate.toFixed(2),
      maxDrawdownPct: maxDrawdownPct.toFixed(2),
      simpleCapital:  (simpleCapital + totalContributed).toFixed(2),
      compoundCapital: compoundCapital.toFixed(2),
      bestMethod,
      effectiveTpPct: effectiveTpPct.toFixed(3),
      effectiveSlPct: effectiveSlPct.toFixed(3),
      totalContributed: totalContributed.toFixed(2),
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
 * Backtest multi-combinación LONG: hasta 15 conjuntos de parámetros en simultáneo.
 * Cada combo tiene su propia máquina de estados de rango, pero comparten el
 * límite de 1 operación por día. El primer combo por índice que dispare señal
 * en un día toma el trade; los demás no operan ese día.
 */
export function runMultiSoporteBacktest(candles, combos, shared) {
  const { feeSlPct, feeTpPct, leverage, initialCapital, monthlyContribution = 0, emaMinGapPct = 0 } = shared

  const closes = candles.map(c => parseFloat(c.CloseCandle))
  const highs  = candles.map(c => parseFloat(c.HighCandle))
  const lows   = candles.map(c => parseFloat(c.LowCandle))
  const opens  = candles.map(c => parseFloat(c.OpenCandle))

  const ema10arr = ema(closes, 10)
  const ema50arr = ema(closes, 50)

  const states = combos.map(() => ({
    activeRangeBottom: null,
    firstRangeTouchDone: false,
    prevIsTightRange: false,
  }))

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

    const _emaGapPct = (ema10arr[i] !== null && ema50arr[i] !== null && ema10arr[i] > 0)
      ? (ema10arr[i] - ema50arr[i]) / ema10arr[i] * 100 : 0
    const isBullishTrend = ema10arr[i] !== null && ema50arr[i] !== null
      ? ema10arr[i] > ema50arr[i] && _emaGapPct >= emaMinGapPct : false

    const candleRange = high - low
    const lowerWick = Math.min(open, close) - low
    const lowerWickPct = candleRange > 0 ? (lowerWick / candleRange) * 100 : 0

    // Cerrar trades abiertos — SL tiene prioridad (conservador)
    const stillOpen = []
    for (const t of openTrades) {
      const adversePct = (t.price - low) / t.price * 100
      if (adversePct > t.maxAdverse) t.maxAdverse = adversePct

      const slHit = low <= t.sl
      const tpHit = high >= t.tp

      if (slHit) {
        totalSl++; totalClosed++
        totalLossPct += t.effectiveSlPct
        totalNetPct = totalProfitPct - totalLossPct
        equityPct -= t.effectiveSlPct
        equityPeakPct = Math.max(equityPeakPct, equityPct)
        maxDrawdownPct = Math.max(maxDrawdownPct, equityPeakPct - equityPct)
        simpleCapital = initialCapital * (1 + totalNetPct / 100)
        compoundCapital = compoundCapital * (1 - t.effectiveSlPct / 100)
        trades.push({ ...t, result: 'SL', closeTime: candle.OpenTime, closePrice: t.sl, capitalAtExit: compoundCapital })
      } else if (tpHit) {
        totalTp++; totalClosed++
        totalProfitPct += t.effectiveTpPct
        totalNetPct = totalProfitPct - totalLossPct
        equityPct += t.effectiveTpPct
        equityPeakPct = Math.max(equityPeakPct, equityPct)
        maxDrawdownPct = Math.max(maxDrawdownPct, equityPeakPct - equityPct)
        simpleCapital = initialCapital * (1 + totalNetPct / 100)
        compoundCapital = compoundCapital * (1 + t.effectiveTpPct / 100)
        trades.push({ ...t, result: 'TP', closeTime: candle.OpenTime, closePrice: t.tp, capitalAtExit: compoundCapital })
      } else {
        stillOpen.push(t)
      }
    }
    openTrades = stillOpen

    let firedCombo = null

    for (let ci = 0; ci < combos.length; ci++) {
      const combo = combos[ci]
      const state = states[ci]

      const highestPrice = highest(highs, combo.lookbackCandles, i)
      const lowestPrice  = lowest(lows,  combo.lookbackCandles, i)
      const rangePct = close !== 0 ? (highestPrice - lowestPrice) / close * 100 : 0

      const isTightRange = rangePct >= combo.minRangePct && rangePct <= combo.maxRangePct
      const newRangeStarted = isTightRange && !state.prevIsTightRange

      if (newRangeStarted) { state.activeRangeBottom = lowestPrice; state.firstRangeTouchDone = false }
      if (!isTightRange)   { state.activeRangeBottom = null; state.firstRangeTouchDone = false }

      const touchRangeBottom =
        isTightRange && !state.firstRangeTouchDone && state.activeRangeBottom !== null &&
        low <= state.activeRangeBottom && candleRange > 0 && lowerWickPct >= combo.minWickPct

      const fired = touchRangeBottom && isBullishTrend

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
      const sl = ep * (1 - combo.slPct / 100)
      const tp = ep * (1 + combo.tpPct / 100)
      const effectiveTpPct = Math.max(combo.tpPct - feeTpPct, 0) * leverage
      const effectiveSlPct = (combo.slPct + feeSlPct) * leverage

      const sig = {
        time: candle.OpenTime,
        price: ep, sl, tp,
        rangePct: rangePct.toFixed(3),
        lowerWickPct: lowerWickPct.toFixed(2),
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

  const BUCKETS = [0.1, 0.2, 0.3, 0.4, 0.5, 0.75, 1.0]
  const maeDist = []
  let prev = 0
  for (const b of BUCKETS) {
    maeDist.push({ from: prev, to: b, count: maeArr.filter(v => v >= prev && v < b).length })
    prev = b
  }
  maeDist.push({ from: prev, to: Infinity, count: maeArr.filter(v => v >= prev).length })

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
