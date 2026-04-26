// =============================================================================
// Parabolic SAR — algoritmo de Wilder
// =============================================================================
function computeSAR(highs, lows, closes, start, inc, max) {
  const N      = highs.length
  const sarArr  = new Float64Array(N).fill(NaN)
  const bullArr = new Uint8Array(N)   // 1 = alcista, 0 = bajista

  if (N < 3) return { sarArr, bullArr }

  let bull = closes[1] >= closes[0]
  let ep   = bull ? highs[1] : lows[1]
  let af   = start
  let sar  = bull
    ? Math.min(lows[0], lows[1])
    : Math.max(highs[0], highs[1])

  sarArr[1]  = sar
  bullArr[1] = bull ? 1 : 0

  for (let i = 2; i < N; i++) {
    let nextSar = sar + af * (ep - sar)

    if (bull) {
      // SAR no puede estar por encima de los 2 mínimos anteriores
      nextSar = Math.min(nextSar, lows[i - 1], lows[i - 2])
      if (lows[i] < nextSar) {
        // Reversión → bajista
        bull    = false
        nextSar = ep
        ep      = lows[i]
        af      = start
      } else if (highs[i] > ep) {
        ep = highs[i]
        af = Math.min(af + inc, max)
      }
    } else {
      // SAR no puede estar por debajo de los 2 máximos anteriores
      nextSar = Math.max(nextSar, highs[i - 1], highs[i - 2])
      if (highs[i] > nextSar) {
        // Reversión → alcista
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
// Tendencia por estructura (HH/HL) — equivale a TrendAnalyzer C# leftRight=N
// =============================================================================
function buildStructuralTrend(highs, lows, lr) {
  const N   = highs.length
  const out = new Int8Array(N)   // 1=alcista, -1=bajista, 0=lateral

  let lastPh = null, prevPh = null
  let lastPl = null, prevPl = null

  for (let i = 0; i < N; i++) {
    const j = i - lr   // índice del pivote que se confirma en la barra i
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
      if      (lastPh > prevPh && lastPl > prevPl) out[i] =  1   // HH + HL
      else if (lastPh < prevPh && lastPl < prevPl) out[i] = -1   // LH + LL
      else                                          out[i] =  0
    }
  }

  return out
}

// =============================================================================
// Backtest principal SAR
// =============================================================================
export function runSARBacktest(candles, params) {
  const {
    sarStart       = 0.02,
    sarInc         = 0.02,
    sarMax         = 0.2,
    pivotLr        = 2,
    tpPct          = 0.8,
    slPct          = 0.5,
    feeTpPct       = 0.05,
    feeSlPct       = 0.10,
    leverage       = 10,
    initialCapital = 1000,
    useTrendFilter = true,
    skipSundays    = true,
  } = params

  const N = candles.length
  if (N < 10) return null

  const highs  = candles.map(c => parseFloat(c.HighCandle))
  const lows   = candles.map(c => parseFloat(c.LowCandle))
  const closes = candles.map(c => parseFloat(c.CloseCandle))
  const times  = candles.map(c => c.OpenTime)

  const { sarArr, bullArr } = computeSAR(highs, lows, closes, sarStart, sarInc, sarMax)
  const trend = buildStructuralTrend(highs, lows, pivotLr)

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

  for (let i = 2; i < N; i++) {
    if (isNaN(sarArr[i])) continue

    const high  = highs[i]
    const low   = lows[i]
    const close = closes[i]
    const time  = times[i]

    const sarBull     = bullArr[i]     === 1
    const sarBullPrev = bullArr[i - 1] === 1

    const longCross  = sarBull  && !sarBullPrev
    const shortCross = !sarBull && sarBullPrev

    // Filtro domingos (UTC)
    const isSunday = skipSundays && new Date(time).getUTCDay() === 0

    const isBull = trend[i] ===  1
    const isBear = trend[i] === -1

    const longOk  = longCross  && (!useTrendFilter || isBull) && !isSunday
    const shortOk = shortCross && (!useTrendFilter || isBear) && !isSunday
    const anyOpened = longOk || shortOk

    if (anyOpened) {
      signals.push({ time, type: longOk ? 'LONG' : 'SHORT', price: close, sarVal: sarArr[i], trend: trend[i] })
    }

    // Evaluar TP/SL (nunca en la misma vela de apertura)
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
