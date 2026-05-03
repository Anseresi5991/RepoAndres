// =============================================================================
// EMA estándar (para filtro de tendencia)
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
// ATR — Wilder's RMA (misma fórmula que TradingView ta.atr)
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

  // Primer valor = SMA de los primeros `period` TRs
  if (N < period) return atr
  let sum = 0
  for (let i = 0; i < period; i++) sum += tr[i]
  atr[period - 1] = sum / period

  // RMA (Wilder's smoothing)
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
// Supertrend — mismo algoritmo que TradingView ta.supertrend
// =============================================================================
function computeSupertrend(highs, lows, closes, period, multiplier) {
  const N            = highs.length
  const direction    = new Int8Array(N)       // 1=alcista, -1=bajista
  const supertrendArr = new Float64Array(N).fill(NaN)

  const atr = computeATR(highs, lows, closes, period)

  const start = period - 1
  if (start >= N) return { direction, supertrendArr }

  // Bandas crudas
  const upperRaw = new Float64Array(N)
  const lowerRaw = new Float64Array(N)
  for (let i = start; i < N; i++) {
    const hl2    = (highs[i] + lows[i]) / 2
    upperRaw[i]  = hl2 + multiplier * atr[i]
    lowerRaw[i]  = hl2 - multiplier * atr[i]
  }

  // Bandas finales con "locking" (igual a Pine Script)
  const finalUpper = new Float64Array(N)
  const finalLower = new Float64Array(N)

  finalUpper[start] = upperRaw[start]
  finalLower[start] = lowerRaw[start]
  direction[start]  = 1
  supertrendArr[start] = finalLower[start]

  for (let i = start + 1; i < N; i++) {
    // Upper solo baja si el cierre anterior estaba por debajo de él
    finalUpper[i] = closes[i - 1] <= finalUpper[i - 1]
      ? Math.min(upperRaw[i], finalUpper[i - 1])
      : upperRaw[i]

    // Lower solo sube si el cierre anterior estaba por encima de él
    finalLower[i] = closes[i - 1] >= finalLower[i - 1]
      ? Math.max(lowerRaw[i], finalLower[i - 1])
      : lowerRaw[i]

    // Cambio de dirección
    if (direction[i - 1] === -1) {
      direction[i] = closes[i] > finalUpper[i] ? 1 : -1
    } else {
      direction[i] = closes[i] < finalLower[i] ? -1 : 1
    }

    supertrendArr[i] = direction[i] === 1 ? finalLower[i] : finalUpper[i]
  }

  return { direction, supertrendArr }
}

// =============================================================================
// Tendencia estructural HH/HL — mismo algoritmo que SAR
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
// Backtest principal Supertrend
// =============================================================================
export function runSupertrendBacktest(candles, params) {
  const {
    atrPeriod      = 10,
    atrMultiplier  = 3.0,
    tpPct          = 0.8,
    slPct          = 0.5,
    feeTpPct       = 0.05,
    feeSlPct       = 0.10,
    leverage       = 10,
    initialCapital = 1000,
    useTrendFilter    = false,
    pivotLr           = 2,
    tradeDirection    = 'both',   // 'both' | 'long' | 'short'
    skipSundays       = true,
    emaFilterPeriod   = 0,        // 0 = desactivado; >0 = solo LONG si close>EMA, SHORT si close<EMA
    maxConsecLosses   = 0,        // 0 = desactivado; >0 = pausa tras N SLs consecutivos
    consecCooldownBars = 20,      // velas de pausa tras racha de pérdidas
    adxPeriod         = 14,       // período ADX
    adxMinimum        = 0,        // 0 = desactivado; >0 = solo operar si ADX >= umbral
    slopeEmaPeriod    = 0,        // 0 = desactivado; >0 = EMA cuya pendiente filtra dirección
    slopeLookback     = 3,        // barras de lookback para medir pendiente EMA
    atrVolFilter      = 0,        // 0 = desactivado; >0 = solo operar si ATR <= ratio × SMA(ATR)
    atrVolPeriod      = 20,       // período de la SMA del ATR para el baseline
    rsiPeriod         = 14,       // período RSI
    rsiThreshold      = 0,        // 0 = desactivado; >0 = no LONG si RSI > thr, no SHORT si RSI < (100-thr)
    bodyRatioMin      = 0,        // 0 = desactivado; >0 = solo entrar si cuerpo/rango >= valor
  } = params

  const N = candles.length
  if (N < atrPeriod + 5) return null

  const highs  = candles.map(c => parseFloat(c.HighCandle))
  const lows   = candles.map(c => parseFloat(c.LowCandle))
  const closes = candles.map(c => parseFloat(c.CloseCandle))
  const opens  = candles.map(c => parseFloat(c.OpenCandle))
  const times  = candles.map(c => c.OpenTime)

  const { direction, supertrendArr } = computeSupertrend(highs, lows, closes, atrPeriod, atrMultiplier)
  const trend      = useTrendFilter       ? buildStructuralTrend(highs, lows, pivotLr)              : null
  const emaArr     = emaFilterPeriod > 0  ? computeEMA(closes, emaFilterPeriod)                     : null
  const adxArr     = adxMinimum > 0       ? computeADX(highs, lows, closes, adxPeriod)              : null
  const slopeArr   = slopeEmaPeriod > 0   ? computeEMA(closes, slopeEmaPeriod)                      : null
  const rawAtrArr  = atrVolFilter > 0     ? computeATR(highs, lows, closes, atrPeriod)              : null
  const atrSmaArr  = rawAtrArr            ? computeRollingSMA(rawAtrArr, atrVolPeriod)               : null
  const rsiArr     = rsiThreshold > 0     ? computeRSI(closes, rsiPeriod)                           : null

  const effTp = Math.max(tpPct - feeTpPct, 0) * leverage
  const effSl = (slPct + feeSlPct) * leverage

  let totalTp = 0, totalSl = 0, totalClosed = 0
  let profitPct = 0, lossPct = 0, netPct = 0
  let eqPct = 0, eqPeak = 0, maxDrawdown = 0
  let compound = initialCapital
  let simple   = initialCapital

  const trades  = []
  const signals = []

  let inTrade    = false
  let isLong     = false
  let entryPr    = 0
  let tpPr       = 0
  let slPr       = 0
  let openTime   = null
  let capAtEntry = initialCapital

  let consecLosses  = 0
  let pauseUntilBar = -1

  const canLong  = tradeDirection === 'both' || tradeDirection === 'long'
  const canShort = tradeDirection === 'both' || tradeDirection === 'short'

  for (let i = atrPeriod; i < N; i++) {
    if (isNaN(supertrendArr[i])) continue

    const high  = highs[i]
    const low   = lows[i]
    const close = closes[i]
    const time  = times[i]

    const longCross  = direction[i] === 1  && direction[i - 1] === -1
    const shortCross = direction[i] === -1 && direction[i - 1] === 1

    const isSunday = skipSundays && new Date(time).getUTCDay() === 0
    const isBull   = trend ? trend[i] === 1  : true
    const isBear   = trend ? trend[i] === -1 : true
    const isPaused = maxConsecLosses > 0 && i < pauseUntilBar

    const emaVal      = emaArr ? emaArr[i] : NaN
    const emaReady    = !emaArr || !isNaN(emaVal)
    const longEmaOk   = !emaArr || (emaReady && close > emaVal)
    const shortEmaOk  = !emaArr || (emaReady && close < emaVal)

    const adxVal      = adxArr ? adxArr[i] : NaN
    const adxOk       = !adxArr || (!isNaN(adxVal) && adxVal >= adxMinimum)

    const slopeVal    = slopeArr ? slopeArr[i] : NaN
    const slopePrev   = slopeArr ? slopeArr[i - slopeLookback] : NaN
    const slopeReady  = !slopeArr || (i >= slopeLookback && !isNaN(slopeVal) && !isNaN(slopePrev))
    const longSlopeOk  = !slopeArr || (slopeReady && slopeVal > slopePrev)
    const shortSlopeOk = !slopeArr || (slopeReady && slopeVal < slopePrev)

    const atrOk = !rawAtrArr || (!isNaN(atrSmaArr[i]) && rawAtrArr[i] <= atrVolFilter * atrSmaArr[i])

    const rsiVal      = rsiArr ? rsiArr[i] : NaN
    const longRsiOk   = !rsiArr || (!isNaN(rsiVal) && rsiVal <= rsiThreshold)
    const shortRsiOk  = !rsiArr || (!isNaN(rsiVal) && rsiVal >= (100 - rsiThreshold))

    const range   = highs[i] - lows[i]
    const bodyOk  = bodyRatioMin === 0 || (range > 0 && Math.abs(close - opens[i]) / range >= bodyRatioMin)

    const longOk  = longCross  && canLong  && (!useTrendFilter || isBull) && !isSunday && longEmaOk  && !isPaused && adxOk && longSlopeOk  && atrOk && longRsiOk  && bodyOk
    const shortOk = shortCross && canShort && (!useTrendFilter || isBear) && !isSunday && shortEmaOk && !isPaused && adxOk && shortSlopeOk && atrOk && shortRsiOk && bodyOk
    const anyOpened = longOk || shortOk

    if (anyOpened) {
      signals.push({
        time,
        type:           longOk ? 'LONG' : 'SHORT',
        price:          close,
        supertrendVal:  supertrendArr[i],
        trend:          trend ? trend[i] : 0,
      })
    }

    // Evaluar TP/SL (nunca en vela de apertura)
    let tpHit = false, slHit = false
    if (inTrade && !anyOpened) {
      tpHit = isLong ? high >= tpPr : low  <= tpPr
      slHit = !tpHit && (isLong ? low <= slPr : high >= slPr)
    }

    if (tpHit || slHit) {
      const win = tpHit
      if (win) {
        totalTp++; profitPct += effTp; eqPct += effTp
        consecLosses = 0
      } else {
        totalSl++; lossPct += effSl; eqPct -= effSl
        consecLosses++
        if (maxConsecLosses > 0 && consecLosses >= maxConsecLosses) {
          pauseUntilBar = i + consecCooldownBars
          consecLosses  = 0
        }
      }
      totalClosed++
      netPct      = profitPct - lossPct
      eqPeak      = Math.max(eqPeak, eqPct)
      maxDrawdown = Math.max(maxDrawdown, eqPeak - eqPct)
      simple      = initialCapital * (1 + netPct / 100)
      compound    = win ? compound * (1 + effTp / 100) : compound * (1 - effSl / 100)

      trades.push({
        result:         win ? 'TP' : 'SL',
        side:           isLong ? 'LONG' : 'SHORT',
        time:           openTime,
        closeTime:      time,
        price:          entryPr,
        tp:             tpPr,
        sl:             slPr,
        capitalAtEntry: capAtEntry,
        capitalAtExit:  compound,
        effectiveTpPct: effTp,
        effectiveSlPct: effSl,
      })
      inTrade = false
    }

    // Abrir nuevo trade
    if (anyOpened && !inTrade) {
      inTrade    = true
      isLong     = longOk
      entryPr    = close
      openTime   = time
      capAtEntry = compound
      tpPr = isLong ? close * (1 + tpPct / 100) : close * (1 - tpPct / 100)
      slPr = isLong ? close * (1 - slPct / 100) : close * (1 + slPct / 100)
    }
  }

  const winRate    = totalClosed > 0 ? (totalTp / totalClosed) * 100 : 0
  const bestMethod = compound > simple ? 'Compuesto' : simple > compound ? 'Simple' : 'Iguales'

  return {
    isMulti:      false,
    totalCandles: N,
    stats: {
      totalTp, totalSl, totalClosed,
      totalProfitPct:  profitPct.toFixed(2),
      totalLossPct:    lossPct.toFixed(2),
      totalNetPct:     netPct.toFixed(2),
      winRate:         winRate.toFixed(2),
      maxDrawdownPct:  maxDrawdown.toFixed(2),
      simpleCapital:   simple.toFixed(2),
      compoundCapital: compound.toFixed(2),
      effectiveTpPct:  effTp,
      effectiveSlPct:  effSl,
      bestMethod,
    },
    trades,
    signals,
  }
}

// =============================================================================
// Multi-combo Supertrend: 1 trade a la vez, primer combo que dispare señal gana
// =============================================================================
export function runMultiSupertrendBacktest(candles, combos, params) {
  const {
    feeSlPct       = 0.10,
    feeTpPct       = 0.05,
    leverage       = 10,
    initialCapital = 1000,
    tradeDirection = 'both',
    skipSundays    = true,
    atrVolPeriod   = 20,
    rsiPeriod      = 14,
  } = params

  const N = candles.length
  if (N < 10 || !combos?.length) return null

  const highs  = candles.map(c => parseFloat(c.HighCandle))
  const lows   = candles.map(c => parseFloat(c.LowCandle))
  const closes = candles.map(c => parseFloat(c.CloseCandle))
  const opens  = candles.map(c => parseFloat(c.OpenCandle))
  const times  = candles.map(c => c.OpenTime)

  const canLong  = tradeDirection === 'both' || tradeDirection === 'long'
  const canShort = tradeDirection === 'both' || tradeDirection === 'short'

  const stCache  = {}
  const atrCache = {}

  const needsRsi = combos.some(c => (c.rsiThreshold || 0) > 0)
  const rsiArr   = needsRsi ? computeRSI(closes, rsiPeriod) : null

  const comboMeta = combos.map(combo => {
    const period     = Math.round(combo.atrPeriod)
    const multiplier = parseFloat(combo.atrMultiplier)
    const atrVF      = combo.atrVolFilter  || 0
    const rsiThr     = combo.rsiThreshold  || 0
    const bodyMin    = combo.bodyRatioMin  || 0

    const key = `${period}_${multiplier}`
    if (!stCache[key]) stCache[key] = computeSupertrend(highs, lows, closes, period, multiplier)
    const { direction } = stCache[key]

    let rawAtrArr = null, atrSmaArr = null
    if (atrVF > 0) {
      if (!atrCache[period]) {
        const raw = computeATR(highs, lows, closes, period)
        atrCache[period] = { raw, sma: computeRollingSMA(raw, atrVolPeriod) }
      }
      rawAtrArr = atrCache[period].raw
      atrSmaArr = atrCache[period].sma
    }

    const effTp = Math.max(combo.tpPct - feeTpPct, 0) * leverage
    const effSl = (combo.slPct + feeSlPct) * leverage

    const longSignal  = new Uint8Array(N)
    const shortSignal = new Uint8Array(N)
    for (let i = period; i < N; i++) {
      if (skipSundays && new Date(times[i]).getUTCDay() === 0) continue
      const longCross  = direction[i] === 1  && direction[i - 1] === -1
      const shortCross = direction[i] === -1 && direction[i - 1] === 1
      if (!longCross && !shortCross) continue

      const atrOk      = atrVF === 0 || (!isNaN(atrSmaArr[i]) && rawAtrArr[i] <= atrVF * atrSmaArr[i])
      if (!atrOk) continue

      const rsiVal     = rsiArr ? rsiArr[i] : NaN
      const longRsiOk  = rsiThr === 0 || (!isNaN(rsiVal) && rsiVal <= rsiThr)
      const shortRsiOk = rsiThr === 0 || (!isNaN(rsiVal) && rsiVal >= (100 - rsiThr))

      const range   = highs[i] - lows[i]
      const bodyOk  = bodyMin === 0 || (range > 0 && Math.abs(closes[i] - opens[i]) / range >= bodyMin)

      if (longCross  && canLong  && longRsiOk  && bodyOk) longSignal[i]  = 1
      if (shortCross && canShort && shortRsiOk && bodyOk) shortSignal[i] = 1
    }
    return { longSignal, shortSignal, tpPct: combo.tpPct, slPct: combo.slPct, effTp, effSl }
  })

  let inTrade = false, isLong = false
  let tpPr = 0, slPr = 0, entryPr = 0, openTime = null, capAtEntry = initialCapital
  let activeEffTp = 0, activeEffSl = 0, tradeOpenedBar = -1

  let totalTp = 0, totalSl = 0, totalClosed = 0
  let profitPct = 0, lossPct = 0, netPct = 0
  let eqPct = 0, eqPeak = 0, maxDrawdown = 0
  let compound = initialCapital
  let simple   = initialCapital

  const trades  = []
  const signals = []

  for (let i = 0; i < N; i++) {
    if (inTrade && i !== tradeOpenedBar) {
      const tpHit = isLong ? highs[i] >= tpPr : lows[i]  <= tpPr
      const slHit = !tpHit && (isLong ? lows[i] <= slPr  : highs[i] >= slPr)

      if (tpHit || slHit) {
        const win = tpHit
        if (win) { totalTp++; profitPct += activeEffTp; eqPct += activeEffTp }
        else     { totalSl++; lossPct += activeEffSl;   eqPct -= activeEffSl }
        totalClosed++
        netPct      = profitPct - lossPct
        eqPeak      = Math.max(eqPeak, eqPct)
        maxDrawdown = Math.max(maxDrawdown, eqPeak - eqPct)
        compound    = win ? compound * (1 + activeEffTp / 100) : compound * (1 - activeEffSl / 100)
        simple      = initialCapital * (1 + netPct / 100)
        trades.push({
          result:         win ? 'TP' : 'SL',
          side:           isLong ? 'LONG' : 'SHORT',
          time:           openTime,
          closeTime:      times[i],
          price:          entryPr,
          tp:             tpPr,
          sl:             slPr,
          capitalAtEntry: capAtEntry,
          capitalAtExit:  compound,
          effectiveTpPct: activeEffTp,
          effectiveSlPct: activeEffSl,
        })
        inTrade = false
      }
    }

    if (!inTrade) {
      for (const meta of comboMeta) {
        if (meta.longSignal[i] || meta.shortSignal[i]) {
          const long = !!meta.longSignal[i]
          inTrade        = true
          isLong         = long
          entryPr        = closes[i]
          openTime       = times[i]
          capAtEntry     = compound
          tradeOpenedBar = i
          tpPr           = long ? closes[i] * (1 + meta.tpPct / 100) : closes[i] * (1 - meta.tpPct / 100)
          slPr           = long ? closes[i] * (1 - meta.slPct / 100) : closes[i] * (1 + meta.slPct / 100)
          activeEffTp    = meta.effTp
          activeEffSl    = meta.effSl
          signals.push({ time: times[i], type: long ? 'LONG' : 'SHORT', price: closes[i] })
          break
        }
      }
    }
  }

  const winRate    = totalClosed > 0 ? (totalTp / totalClosed) * 100 : 0
  const bestMethod = compound > simple ? 'Compuesto' : simple > compound ? 'Simple' : 'Iguales'

  return {
    isMulti:      true,
    totalCandles: N,
    stats: {
      totalTp, totalSl, totalClosed,
      totalProfitPct:  profitPct.toFixed(2),
      totalLossPct:    lossPct.toFixed(2),
      totalNetPct:     netPct.toFixed(2),
      winRate:         winRate.toFixed(2),
      maxDrawdownPct:  maxDrawdown.toFixed(2),
      simpleCapital:   simple.toFixed(2),
      compoundCapital: compound.toFixed(2),
      bestMethod,
    },
    trades,
    signals,
  }
}
