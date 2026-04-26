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
    useTrendFilter = false,
    pivotLr        = 2,
    tradeDirection = 'both',   // 'both' | 'long' | 'short'
    skipSundays    = true,
  } = params

  const N = candles.length
  if (N < atrPeriod + 5) return null

  const highs  = candles.map(c => parseFloat(c.HighCandle))
  const lows   = candles.map(c => parseFloat(c.LowCandle))
  const closes = candles.map(c => parseFloat(c.CloseCandle))
  const times  = candles.map(c => c.OpenTime)

  const { direction, supertrendArr } = computeSupertrend(highs, lows, closes, atrPeriod, atrMultiplier)
  const trend = useTrendFilter ? buildStructuralTrend(highs, lows, pivotLr) : null

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

    const longOk  = longCross  && canLong  && (!useTrendFilter || isBull) && !isSunday
    const shortOk = shortCross && canShort && (!useTrendFilter || isBear) && !isSunday
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
      if (win) { totalTp++; profitPct += effTp; eqPct += effTp }
      else     { totalSl++; lossPct   += effSl; eqPct -= effSl }
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
