/**
 * Backtester — EMA Touch (Resistencia / Soporte)
 *
 * Señal SHORT (resistencia): mecha SUPERIOR toca la EMA, cuerpo queda por debajo.
 * Señal LONG  (soporte)    : mecha INFERIOR toca la EMA, cuerpo queda por encima.
 * Máximo 1 operación por día UTC.
 *
 * direction:        'R' = solo SHORT · 'S' = solo LONG · 'BOTH' = ambas (SHORT con prioridad)
 * slowEmaPeriod:    período de EMA lenta de tendencia (0 = sin filtro)
 *   SHORT solo se activa si EMA toque < EMA lenta (contexto bajista)
 *   LONG  solo se activa si EMA toque > EMA lenta (contexto alcista)
 * emaSlopeLookback: velas atrás para confirmar pendiente de la EMA toque (0 = sin filtro)
 *   SHORT solo se activa si EMA[i] < EMA[i-N] (EMA bajando)
 *   LONG  solo se activa si EMA[i] > EMA[i-N] (EMA subiendo)
 */

function rsi(closes, period) {
  const N = closes.length
  const result = new Array(N).fill(0)
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

export function runEmaTouchBacktest(candles, params) {
  const {
    emaPeriod,
    minWickPct,
    slPct,
    tpPct,
    feeSlPct,
    feeTpPct,
    leverage,
    initialCapital,
    direction = 'BOTH',
    monthlyContribution = 0,
    slowEmaPeriod = 200,
    emaSlopeLookback = 5,
    maxBodyPct = 50,
    emaConsistencyBars = 3,
    atrPeriod = 14,
    atrMaPeriod = 20,
    atrMaxMultiplier = 1.5,
    rsiPeriod = 14,
    rsiShortMax = 65,
    rsiLongMin = 35,
    minCrossBodyPct = 30,
  } = params

  const N = candles.length
  if (N < emaPeriod) return null

  const closes = candles.map(c => parseFloat(c.CloseCandle))
  const highs   = candles.map(c => parseFloat(c.HighCandle))
  const lows    = candles.map(c => parseFloat(c.LowCandle))
  const opens   = candles.map(c => parseFloat(c.OpenCandle))

  const emaArr     = ema(closes, emaPeriod)
  const slowEmaArr = slowEmaPeriod > 0 ? ema(closes, slowEmaPeriod) : null

  // ATR de Wilder + MA para filtro de volatilidad
  const atrArr = new Array(N).fill(0)
  const atrMaArr = new Array(N).fill(0)
  if (atrPeriod > 1 && N >= atrPeriod) {
    let sumTr = highs[0] - lows[0]
    for (let i = 1; i < atrPeriod; i++)
      sumTr += Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i-1]), Math.abs(lows[i] - closes[i-1]))
    atrArr[atrPeriod - 1] = sumTr / atrPeriod
    for (let i = atrPeriod; i < N; i++) {
      const tr = Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i-1]), Math.abs(lows[i] - closes[i-1]))
      atrArr[i] = (atrArr[i-1] * (atrPeriod - 1) + tr) / atrPeriod
    }
    if (atrMaPeriod > 1) {
      let sumAtr = 0
      for (let i = atrPeriod - 1; i < N; i++) {
        sumAtr += atrArr[i]
        const cnt = i - (atrPeriod - 1) + 1
        if (cnt > atrMaPeriod) sumAtr -= atrArr[i - atrMaPeriod]
        if (cnt >= atrMaPeriod) atrMaArr[i] = sumAtr / atrMaPeriod
      }
    }
  }

  // RSI de Wilder
  const rsiArr = rsiPeriod > 1 ? rsi(closes, rsiPeriod) : null

  const effTp = Math.max(tpPct - feeTpPct, 0) * leverage
  const effSl = (slPct + feeSlPct) * leverage

  const trades  = []
  const signals = []

  let openTrade       = null
  let dailySignalUsed = false
  let lastDay         = null
  let lastContribDay  = null

  // Estado para primer toque + cruce decisivo + RSI
  let bodyAboveCount = 0, crossedToBelow = false, firstShortDone = false, crossBodyOkShort = false
  let bodyBelowCount = 0, crossedToAbove = false, firstLongDone  = false, crossBodyOkLong  = false

  let capital    = initialCapital
  let equityPct  = 0
  let equityPeak = 0
  let maxDd      = 0
  let totalTp    = 0
  let totalSl    = 0
  let profitPct  = 0
  let lossPct    = 0

  for (let i = 0; i < N; i++) {
    const currentDay = candles[i].OpenTime.substring(0, 10)

    if (currentDay !== lastDay) {
      lastDay = currentDay
      dailySignalUsed = false

      if (monthlyContribution > 0) {
        const mo = candles[i].OpenTime.substring(0, 7)
        if (mo !== lastContribDay) {
          lastContribDay = mo
          capital += monthlyContribution
        }
      }
    }

    const emaVal = emaArr[i]
    if (emaVal === null) continue

    const high  = highs[i]
    const low   = lows[i]
    const open  = opens[i]
    const close = closes[i]
    const cr    = high - low

    // ── Cerrar trade abierto (desde la vela siguiente a la entrada) ──
    if (openTrade && i > openTrade.entryBar) {
      const { tipo, sl, tp } = openTrade
      const slHit = tipo === 'R' ? high >= sl : low  <= sl
      const tpHit = tipo === 'R' ? low  <= tp : high >= tp

      if (slHit) {
        totalSl++
        lossPct   += effSl
        equityPct -= effSl
        equityPeak = Math.max(equityPeak, equityPct)
        maxDd      = Math.max(maxDd, equityPeak - equityPct)
        const capitalAtExit = capital * (1 - effSl / 100)
        capital    = capitalAtExit
        trades.push({ ...openTrade, result: 'SL', closeTime: candles[i].OpenTime, capitalAtExit: capitalAtExit.toFixed(2) })
        openTrade = null
      } else if (tpHit) {
        totalTp++
        profitPct  += effTp
        equityPct  += effTp
        equityPeak  = Math.max(equityPeak, equityPct)
        maxDd       = Math.max(maxDd, equityPeak - equityPct)
        const capitalAtExit = capital * (1 + effTp / 100)
        capital     = capitalAtExit
        trades.push({ ...openTrade, result: 'TP', closeTime: candles[i].OpenTime, capitalAtExit: capitalAtExit.toFixed(2) })
        openTrade = null
      }
    }

    // ── Detectar señal ──
    if (!dailySignalUsed && !openTrade && emaVal !== null && cr > 0) {
      let signalTipo = null
      let wickPct    = 0

      const slowVal    = slowEmaArr ? slowEmaArr[i] : null
      const prevEmaVal = emaSlopeLookback > 0 && i >= emaSlopeLookback ? emaArr[i - emaSlopeLookback] : null
      const maxOC      = open > close ? open : close
      const minOC      = open < close ? open : close
      const bodyRatio  = (maxOC - minOC) / cr * 100
      const bodyOk     = maxBodyPct <= 0 || bodyRatio < maxBodyPct
      const atrOk      = (atrPeriod <= 1 || atrMaPeriod <= 1 || atrMaArr[i] === 0)
                         || atrArr[i] <= atrMaArr[i] * atrMaxMultiplier
      const rsiVal     = rsiArr ? rsiArr[i] : 0

      // Actualizar máquina de estados: primer toque + cruce decisivo
      if (maxOC >= emaVal) {
        bodyAboveCount++; crossedToBelow = false; firstShortDone = false; crossBodyOkShort = false
      } else {
        if (bodyAboveCount >= emaConsistencyBars) {
          crossedToBelow = true
          crossBodyOkShort = minCrossBodyPct <= 0 || (open > close && (open - close) / cr * 100 >= minCrossBodyPct)
        }
        bodyAboveCount = 0
      }
      if (minOC <= emaVal) {
        bodyBelowCount++; crossedToAbove = false; firstLongDone = false; crossBodyOkLong = false
      } else {
        if (bodyBelowCount >= emaConsistencyBars) {
          crossedToAbove = true
          crossBodyOkLong = minCrossBodyPct <= 0 || (close > open && (close - open) / cr * 100 >= minCrossBodyPct)
        }
        bodyBelowCount = 0
      }

      const rsiOkShort = rsiPeriod <= 0 || rsiVal === 0 || rsiVal <= rsiShortMax
      const rsiOkLong  = rsiPeriod <= 0 || rsiVal === 0 || rsiVal >= rsiLongMin

      // SHORT — filtros A (bajista) + B (RSI) + C (cruce decisivo) + primer toque
      if (bodyOk && atrOk && rsiOkShort && crossedToBelow && crossBodyOkShort && !firstShortDone
          && open > close  // Filtro A: vela bajista
          && (direction === 'R' || direction === 'BOTH')) {
        const trendOk = slowVal === null || emaVal < slowVal
        const slopeOk = prevEmaVal === null || emaVal < prevEmaVal
        if (trendOk && slopeOk && high >= emaVal && maxOC < emaVal) {
          const uw = (high - maxOC) / cr * 100
          if (uw >= minWickPct) { signalTipo = 'R'; wickPct = uw; firstShortDone = true }
        }
      }

      // LONG — filtros A (alcista) + B (RSI) + C (cruce decisivo) + primer toque
      if (!signalTipo && bodyOk && atrOk && rsiOkLong && crossedToAbove && crossBodyOkLong && !firstLongDone
          && close > open  // Filtro A: vela alcista
          && (direction === 'S' || direction === 'BOTH')) {
        const trendOk = slowVal === null || emaVal > slowVal
        const slopeOk = prevEmaVal === null || emaVal > prevEmaVal
        if (trendOk && slopeOk && low <= emaVal && minOC > emaVal) {
          const lw = (minOC - low) / cr * 100
          if (lw >= minWickPct) { signalTipo = 'S'; wickPct = lw; firstLongDone = true }
        }
      }

      if (signalTipo) {
        dailySignalUsed = true
        const ep = close
        const sl = signalTipo === 'R' ? ep * (1 + slPct / 100) : ep * (1 - slPct / 100)
        const tp = signalTipo === 'R' ? ep * (1 - tpPct / 100) : ep * (1 + tpPct / 100)

        signals.push({
          time:    candles[i].OpenTime,
          tipo:    signalTipo,
          price:   ep,
          emaVal:  emaVal.toFixed(2),
          wickPct: wickPct.toFixed(2),
        })

        openTrade = {
          tipo:          signalTipo,
          entryTime:     candles[i].OpenTime,
          entryBar:      i,
          price:         ep,
          sl,
          tp,
          emaVal:        emaVal.toFixed(2),
          wickPct:       wickPct.toFixed(2),
          capitalAtEntry: capital.toFixed(2),
        }
      }
    }
  }

  const totalClosed   = totalTp + totalSl
  const netPct        = profitPct - lossPct
  const winRate       = totalClosed > 0 ? (totalTp / totalClosed * 100) : 0
  const simpleCapital = initialCapital * (1 + netPct / 100)

  return {
    trades,
    signals,
    totalCandles: N,
    stats: {
      totalTp,
      totalSl,
      totalClosed,
      winRate:         winRate.toFixed(2),
      totalProfitPct:  profitPct.toFixed(2),
      totalLossPct:    lossPct.toFixed(2),
      totalNetPct:     netPct.toFixed(2),
      maxDrawdownPct:  maxDd.toFixed(2),
      compoundCapital: capital.toFixed(2),
      simpleCapital:   simpleCapital.toFixed(2),
      bestMethod:      capital > simpleCapital ? 'Compuesto' : simpleCapital > capital ? 'Simple' : 'Iguales',
      effectiveTpPct:  effTp.toFixed(2),
      effectiveSlPct:  effSl.toFixed(2),
    },
  }
}

export function runMultiEmaTouchBacktest(candles, combos, shared) {
  const {
    feeSlPct, feeTpPct, leverage, initialCapital, monthlyContribution = 0,
    slowEmaPeriod = 200, emaSlopeLookback = 5, maxBodyPct = 50, emaConsistencyBars = 3,
    atrPeriod = 14, atrMaPeriod = 20, atrMaxMultiplier = 1.5,
    rsiPeriod = 14, rsiShortMax = 65, rsiLongMin = 35, minCrossBodyPct = 30,
    direction = 'BOTH',
  } = shared

  const N = candles.length
  if (N === 0) return null

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

  // ── Shared pre-computations ──

  const slowEmaArr = slowEmaPeriod > 0 ? ema(closes, slowEmaPeriod) : null

  // atrOk array — identical to emaOptimWorker
  const atrOkArr = new Uint8Array(N).fill(1)
  if (atrPeriod > 1 && atrMaPeriod > 1 && N >= atrPeriod + atrMaPeriod) {
    const atrArr = new Float64Array(N)
    let sumTr = highs[0] - lows[0]
    for (let i = 1; i < atrPeriod; i++)
      sumTr += Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i-1]), Math.abs(lows[i] - closes[i-1]))
    atrArr[atrPeriod - 1] = sumTr / atrPeriod
    for (let i = atrPeriod; i < N; i++) {
      const tr = Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i-1]), Math.abs(lows[i] - closes[i-1]))
      atrArr[i] = (atrArr[i-1] * (atrPeriod - 1) + tr) / atrPeriod
    }
    let sumAtr = 0
    for (let i = atrPeriod - 1; i < N; i++) {
      sumAtr += atrArr[i]
      const cnt = i - (atrPeriod - 1) + 1
      if (cnt > atrMaPeriod) sumAtr -= atrArr[i - atrMaPeriod]
      if (cnt >= atrMaPeriod) {
        const atrMa = sumAtr / atrMaPeriod
        atrOkArr[i] = atrArr[i] <= atrMa * atrMaxMultiplier ? 1 : 0
      }
    }
  }

  const rsiArr = rsiPeriod > 1 && N > rsiPeriod ? rsi(closes, rsiPeriod) : null

  // Shared wick percentages
  const upperWickPct = new Float64Array(N)
  const lowerWickPct = new Float64Array(N)
  for (let i = 0; i < N; i++) {
    const cr = highs[i] - lows[i]
    if (cr <= 0) continue
    const maxOC = opens[i] > closes[i] ? opens[i] : closes[i]
    const minOC = opens[i] < closes[i] ? opens[i] : closes[i]
    upperWickPct[i] = (highs[i] - maxOC) / cr * 100
    lowerWickPct[i] = (minOC - lows[i]) / cr * 100
  }

  // ── Per-combo pre-computation (mirrors emaOptimWorker exactly) ──
  const comboMeta = combos.map(combo => {
    const emaPer = combo.emaPeriod || 20
    const emaArr = ema(closes, emaPer)

    // canShort / canLong (same as emaOptimWorker)
    const canShort = new Uint8Array(N)
    const canLong  = new Uint8Array(N)
    for (let i = 0; i < N; i++) {
      const ev = emaArr[i]
      if (ev === null) continue
      const h = highs[i], l = lows[i], o = opens[i], c = closes[i]
      const cr = h - l
      if (cr <= 0) continue
      const maxOC = o > c ? o : c
      const minOC = o < c ? o : c
      const sv       = slowEmaArr ? slowEmaArr[i] : null
      const prevEv   = emaSlopeLookback > 0 && i >= emaSlopeLookback ? emaArr[i - emaSlopeLookback] : null
      const bearish  = sv === null || ev < sv
      const bullish  = sv === null || ev > sv
      const slopeDown = prevEv === null || ev < prevEv
      const slopeUp   = prevEv === null || ev > prevEv
      const bodyRatio = (o > c ? o - c : c - o) / cr * 100
      const bodyOk    = maxBodyPct <= 0 || bodyRatio < maxBodyPct
      canShort[i] = (h >= ev && maxOC < ev && bearish && slopeDown && bodyOk && c < o) ? 1 : 0
      canLong[i]  = (l <= ev && minOC > ev && bullish && slopeUp   && bodyOk && c > o) ? 1 : 0
    }

    // firstTouchShort / firstTouchLong state machine (mirrors emaOptimWorker exactly)
    const ftShort = new Uint8Array(N)
    const ftLong  = new Uint8Array(N)
    let bodyAboveCount = 0, crossedToBelow = false, firstShortDone = false, crossBodyOkShort = false
    let bodyBelowCount = 0, crossedToAbove = false, firstLongDone  = false, crossBodyOkLong  = false

    for (let i = 0; i < N; i++) {
      const ev = emaArr[i]
      if (ev === null) continue
      const o = opens[i], c = closes[i], h = highs[i], l = lows[i]
      const maxOC = o > c ? o : c
      const minOC = o < c ? o : c
      const cr = h - l

      if (maxOC >= ev) {
        bodyAboveCount++
        crossedToBelow = false; firstShortDone = false; crossBodyOkShort = false
      } else {
        if (bodyAboveCount >= emaConsistencyBars) {
          crossedToBelow = true
          crossBodyOkShort = minCrossBodyPct <= 0 || (o > c && cr > 0 && (o - c) / cr * 100 >= minCrossBodyPct)
        }
        bodyAboveCount = 0
      }
      const rsiVal     = rsiArr ? rsiArr[i] : 0
      const rsiOkShort = rsiPeriod <= 0 || rsiVal === 0 || rsiVal <= rsiShortMax
      ftShort[i] = (canShort[i] && crossedToBelow && crossBodyOkShort && !firstShortDone && atrOkArr[i] && rsiOkShort) ? 1 : 0
      if (ftShort[i]) firstShortDone = true

      if (minOC <= ev) {
        bodyBelowCount++
        crossedToAbove = false; firstLongDone = false; crossBodyOkLong = false
      } else {
        if (bodyBelowCount >= emaConsistencyBars) {
          crossedToAbove = true
          crossBodyOkLong = minCrossBodyPct <= 0 || (c > o && cr > 0 && (c - o) / cr * 100 >= minCrossBodyPct)
        }
        bodyBelowCount = 0
      }
      const rsiOkLong = rsiPeriod <= 0 || rsiVal === 0 || rsiVal >= rsiLongMin
      ftLong[i] = (canLong[i] && crossedToAbove && crossBodyOkLong && !firstLongDone && atrOkArr[i] && rsiOkLong) ? 1 : 0
      if (ftLong[i]) firstLongDone = true
    }

    return {
      emaArr,
      ftShort,
      ftLong,
      effTp: Math.max((combo.tpPct - feeTpPct), 0) * leverage,
      effSl: (combo.slPct + feeSlPct) * leverage,
    }
  })

  // ── Backtest loop (mirrors emaOptimWorker inner loop + multi-combo competition) ──
  let capital = initialCapital
  let equityPct = 0, equityPeak = 0, maxDd = 0
  let totalTp = 0, totalSl = 0
  let profitPct = 0, lossPct = 0
  let openTrade = null
  let dailySignalUsed = false
  let lastDay = null, lastContribDay = null
  const trades = [], signals = []

  for (let i = 0; i < N; i++) {
    const currentDay = candles[i].OpenTime.substring(0, 10)
    if (currentDay !== lastDay) {
      lastDay = currentDay
      dailySignalUsed = false
      if (monthlyContribution > 0) {
        const mo = candles[i].OpenTime.substring(0, 7)
        if (mo !== lastContribDay) { lastContribDay = mo; capital += monthlyContribution }
      }
    }

    const high = highs[i], low = lows[i], close = closes[i]

    if (openTrade && i > openTrade.entryBar) {
      const { tipo, sl, tp, effectiveTpPct: eTp, effectiveSlPct: eSl } = openTrade
      const slHit = tipo === 'R' ? high >= sl : low <= sl
      const tpHit = tipo === 'R' ? low <= tp : high >= tp
      if (slHit) {
        totalSl++; lossPct += eSl; equityPct -= eSl
        equityPeak = Math.max(equityPeak, equityPct)
        maxDd = Math.max(maxDd, equityPeak - equityPct)
        capital *= (1 - eSl / 100)
        trades.push({ ...openTrade, result: 'SL', closeTime: candles[i].OpenTime, capitalAtExit: capital.toFixed(2) })
        openTrade = null
      } else if (tpHit) {
        totalTp++; profitPct += eTp; equityPct += eTp
        equityPeak = Math.max(equityPeak, equityPct)
        maxDd = Math.max(maxDd, equityPeak - equityPct)
        capital *= (1 + eTp / 100)
        trades.push({ ...openTrade, result: 'TP', closeTime: candles[i].OpenTime, capitalAtExit: capital.toFixed(2) })
        openTrade = null
      }
    }

    if (!dailySignalUsed && !openTrade) {
      for (let ci = 0; ci < combos.length; ci++) {
        const combo  = combos[ci]
        const cm     = comboMeta[ci]
        let sigTipo  = 0

        if ((direction === 'R' || direction === 'BOTH') && cm.ftShort[i] && upperWickPct[i] >= combo.minWickPct)
          sigTipo = 1
        if (!sigTipo && (direction === 'S' || direction === 'BOTH') && cm.ftLong[i] && lowerWickPct[i] >= combo.minWickPct)
          sigTipo = 2

        if (sigTipo) {
          dailySignalUsed = true
          const tipo = sigTipo === 1 ? 'R' : 'S'
          const ep   = close
          const sl   = tipo === 'R' ? ep * (1 + combo.slPct / 100) : ep * (1 - combo.slPct / 100)
          const tp   = tipo === 'R' ? ep * (1 - combo.tpPct / 100) : ep * (1 + combo.tpPct / 100)
          const emaVal     = cm.emaArr[i]
          const wickPct    = sigTipo === 1 ? upperWickPct[i] : lowerWickPct[i]
          const comboLabel = combo.label || `Combo ${ci + 1}`
          signals.push({ time: candles[i].OpenTime, tipo, price: ep, emaVal: emaVal != null ? emaVal.toFixed(2) : '0', wickPct: wickPct.toFixed(2), comboLabel })
          openTrade = {
            tipo, entryTime: candles[i].OpenTime, entryBar: i,
            price: ep, sl, tp,
            emaVal: emaVal != null ? emaVal.toFixed(2) : '0',
            wickPct: wickPct.toFixed(2),
            comboLabel,
            effectiveTpPct: cm.effTp,
            effectiveSlPct: cm.effSl,
            capitalAtEntry: capital.toFixed(2),
          }
          break
        }
      }
    }
  }

  const totalClosed2  = totalTp + totalSl
  const netPct2       = profitPct - lossPct
  const winRate2      = totalClosed2 > 0 ? totalTp / totalClosed2 * 100 : 0
  const simpleCapital2 = initialCapital * (1 + netPct2 / 100)

  return {
    trades, signals,
    totalCandles: N,
    isMulti: true,
    stats: {
      totalTp, totalSl, totalClosed: totalClosed2,
      winRate:        winRate2.toFixed(2),
      totalProfitPct: profitPct.toFixed(2),
      totalLossPct:   lossPct.toFixed(2),
      totalNetPct:    netPct2.toFixed(2),
      maxDrawdownPct: maxDd.toFixed(2),
      compoundCapital: capital.toFixed(2),
      simpleCapital:   simpleCapital2.toFixed(2),
      bestMethod: capital > simpleCapital2 ? 'Compuesto' : simpleCapital2 > capital ? 'Simple' : 'Iguales',
    },
  }
}
