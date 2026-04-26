// =============================================================================
// EMA Pullback Backtest — EMA21 pullback dentro de tendencia EMA55
//
// LONG : EMA21 > EMA55 (uptrend) + cierre anterior < EMA21 + cierre actual > EMA21
//         + RSI en rango [rsiMin, rsiMax] + opcional volumen
// SHORT: EMA21 < EMA55 (downtrend) + cierre anterior > EMA21 + cierre actual < EMA21
//         + RSI en rango [rsiMin, rsiMax] + opcional volumen
// =============================================================================

function computeEMA(values, period) {
  const k = 2 / (period + 1)
  const N = values.length
  const result = new Float64Array(N).fill(NaN)
  let prev = null, warmup = 0, warmupSum = 0
  for (let i = 0; i < N; i++) {
    if (prev === null) {
      warmupSum += values[i]; warmup++
      if (warmup === period) { prev = warmupSum / period; result[i] = prev }
    } else {
      prev = values[i] * k + prev * (1 - k); result[i] = prev
    }
  }
  return result
}

function computeRSI(closes, period) {
  const N = closes.length
  const result = new Float64Array(N).fill(NaN)
  if (N < period + 1) return result
  let avgGain = 0, avgLoss = 0
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1]
    if (d > 0) avgGain += d; else avgLoss -= d
  }
  avgGain /= period; avgLoss /= period
  result[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss)
  for (let i = period + 1; i < N; i++) {
    const d = closes[i] - closes[i - 1]
    const g = d > 0 ? d : 0; const l = d < 0 ? -d : 0
    avgGain = (avgGain * (period - 1) + g) / period
    avgLoss = (avgLoss * (period - 1) + l) / period
    result[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss)
  }
  return result
}

function computeSMA(values, period) {
  const N = values.length
  const result = new Float64Array(N).fill(NaN)
  let sum = 0
  for (let i = 0; i < N; i++) {
    sum += values[i]
    if (i >= period) sum -= values[i - period]
    if (i >= period - 1) result[i] = sum / period
  }
  return result
}

// =============================================================================
// Backtest principal
// =============================================================================
export function runEmaPullbackBacktest(candles, params) {
  const {
    emaFast          = 21,
    emaSlow          = 55,
    rsiPeriod        = 14,
    rsiMin           = 30,
    rsiMax           = 70,
    volMAPeriod      = 20,
    volMultiplier    = 1.0,
    useVolumeFilter  = false,
    tpPct            = 1.5,
    slPct            = 0.8,
    feeTpPct         = 0.05,
    feeSlPct         = 0.10,
    leverage         = 1,
    initialCapital   = 1000,
    tradeDirection   = 'both',
  } = params

  const N = candles.length
  if (N < 100) return null

  const closes  = new Float64Array(N)
  const highs   = new Float64Array(N)
  const lows    = new Float64Array(N)
  const volumes = new Float64Array(N)
  const times   = new Array(N)
  for (let i = 0; i < N; i++) {
    closes[i]  = parseFloat(candles[i].CloseCandle)
    highs[i]   = parseFloat(candles[i].HighCandle)
    lows[i]    = parseFloat(candles[i].LowCandle)
    volumes[i] = parseFloat(candles[i].Volume)
    times[i]   = candles[i].OpenTime
  }

  const emaFastArr = computeEMA(closes, emaFast)
  const emaSlowArr = computeEMA(closes, emaSlow)
  const rsiArr     = computeRSI(closes, rsiPeriod)
  const volMAArr   = computeSMA(volumes, volMAPeriod)

  const effTp = Math.max(tpPct - feeTpPct, 0) * leverage
  const effSl = (slPct + feeSlPct) * leverage

  const canLong  = tradeDirection === 'both' || tradeDirection === 'long'
  const canShort = tradeDirection === 'both' || tradeDirection === 'short'

  let inTrade = false, isLong = false
  let entryPr = 0, tpPr = 0, slPr = 0
  let openTime = null, capAtEntry = initialCapital
  let totalTp = 0, totalSl = 0, totalClosed = 0
  let profitPct = 0, lossPct = 0
  let eqPct = 0, eqPeak = 0, maxDrawdown = 0
  let compound = initialCapital, simple = initialCapital

  const trades  = []
  const signals = []

  for (let i = 2; i < N; i++) {
    const close   = closes[i]
    const high    = highs[i]
    const low     = lows[i]
    const vol     = volumes[i]
    const time    = times[i]
    const prevClose = closes[i - 1]

    // Necesitamos que todos los indicadores estén calculados
    if (
      isNaN(emaFastArr[i]) || isNaN(emaFastArr[i - 1]) ||
      isNaN(emaSlowArr[i]) ||
      isNaN(rsiArr[i])     ||
      isNaN(volMAArr[i])
    ) continue

    // ── Evaluar TP / SL ──
    let tpHit = false, slHit = false
    if (inTrade) {
      tpHit = isLong  ? high >= tpPr : low  <= tpPr
      slHit = !tpHit && (isLong ? low <= slPr : high >= slPr)
    }

    if (tpHit || slHit) {
      const win = tpHit
      if (win) { totalTp++; profitPct += effTp; eqPct += effTp }
      else     { totalSl++; lossPct   += effSl; eqPct -= effSl }
      totalClosed++
      eqPeak      = Math.max(eqPeak, eqPct)
      maxDrawdown = Math.max(maxDrawdown, eqPeak - eqPct)
      compound    = win ? compound * (1 + effTp / 100) : compound * (1 - effSl / 100)
      simple      = initialCapital * (1 + (profitPct - lossPct) / 100)
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

    // ── Buscar señal de pullback ──
    if (!inTrade) {
      const rsiOk    = rsiArr[i] >= rsiMin && rsiArr[i] <= rsiMax
      const highVol  = !useVolumeFilter || vol > volMAArr[i] * volMultiplier

      // LONG: uptrend + precio cruzó EMA rápida hacia arriba (pullback terminó)
      const uptrend   = emaFastArr[i] > emaSlowArr[i]
      const longCross = prevClose < emaFastArr[i - 1] && close > emaFastArr[i]
      const longOk    = canLong && uptrend && longCross && rsiOk && highVol

      // SHORT: downtrend + precio cruzó EMA rápida hacia abajo (pullback terminó)
      const downtrend  = emaFastArr[i] < emaSlowArr[i]
      const shortCross = prevClose > emaFastArr[i - 1] && close < emaFastArr[i]
      const shortOk    = canShort && downtrend && shortCross && rsiOk && highVol

      if (longOk || shortOk) {
        signals.push({
          time,
          type:    longOk ? 'LONG' : 'SHORT',
          price:   close,
          rsi:     rsiArr[i].toFixed(1),
          emaFast: emaFastArr[i].toFixed(2),
          emaSlow: emaSlowArr[i].toFixed(2),
        })
        inTrade    = true
        isLong     = longOk
        entryPr    = close
        openTime   = time
        capAtEntry = compound
        tpPr = isLong ? close * (1 + tpPct / 100) : close * (1 - tpPct / 100)
        slPr = isLong ? close * (1 - slPct / 100) : close * (1 + slPct / 100)
      }
    }
  }

  const netPct    = profitPct - lossPct
  const winRate   = totalClosed > 0 ? (totalTp / totalClosed) * 100 : 0
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
      effectiveTpPct:  effTp.toFixed(2),
      effectiveSlPct:  effSl.toFixed(2),
      bestMethod,
    },
    trades,
    signals,
  }
}
