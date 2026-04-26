// =============================================================================
// Confluence Backtest — EMA + RSI + MACD + Bollinger Bands + Volumen
// Señal cuando al menos N de 5 condiciones coinciden (long o short)
// =============================================================================

function computeEMA(values, period) {
  const k = 2 / (period + 1)
  const N = values.length
  const result = new Float64Array(N).fill(NaN)
  let prev = null, warmup = 0, warmupSum = 0
  for (let i = 0; i < N; i++) {
    if (prev === null) {
      warmupSum += values[i]
      warmup++
      if (warmup === period) {
        prev = warmupSum / period
        result[i] = prev
      }
    } else {
      prev = values[i] * k + prev * (1 - k)
      result[i] = prev
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
    const g = d > 0 ? d : 0
    const l = d < 0 ? -d : 0
    avgGain = (avgGain * (period - 1) + g) / period
    avgLoss = (avgLoss * (period - 1) + l) / period
    result[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss)
  }
  return result
}

function computeMACD(closes, fastP, slowP, signalP) {
  const emaFast = computeEMA(closes, fastP)
  const emaSlow = computeEMA(closes, slowP)
  const N = closes.length
  const macdLine   = new Float64Array(N).fill(NaN)
  const signalLine = new Float64Array(N).fill(NaN)
  for (let i = 0; i < N; i++) {
    if (!isNaN(emaFast[i]) && !isNaN(emaSlow[i])) macdLine[i] = emaFast[i] - emaSlow[i]
  }
  const k = 2 / (signalP + 1)
  let prev = null, warmup = 0, warmupSum = 0
  for (let i = 0; i < N; i++) {
    if (isNaN(macdLine[i])) continue
    if (prev === null) {
      warmupSum += macdLine[i]; warmup++
      if (warmup === signalP) { prev = warmupSum / signalP; signalLine[i] = prev }
    } else {
      prev = macdLine[i] * k + prev * (1 - k)
      signalLine[i] = prev
    }
  }
  return { macdLine, signalLine }
}

function computeBB(closes, period, mult) {
  const N = closes.length
  const upper = new Float64Array(N).fill(NaN)
  const lower = new Float64Array(N).fill(NaN)
  let sum = 0
  for (let i = 0; i < N; i++) {
    sum += closes[i]
    if (i >= period) sum -= closes[i - period]
    if (i >= period - 1) {
      const sma = sum / period
      let variance = 0
      for (let j = i - period + 1; j <= i; j++) variance += (closes[j] - sma) ** 2
      const sd = Math.sqrt(variance / period)
      upper[i] = sma + mult * sd
      lower[i] = sma - mult * sd
    }
  }
  return { upper, lower }
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
export function runConfluenceBacktest(candles, params) {
  const {
    emaFast             = 21,
    emaSlow             = 55,
    rsiPeriod           = 14,
    rsiOverbought       = 65,
    rsiOversold         = 35,
    macdFast            = 12,
    macdSlow            = 26,
    macdSignalPeriod    = 9,
    bbPeriod            = 20,
    bbStdDev            = 2.0,
    volMAPeriod         = 20,
    volMultiplier       = 1.5,
    confluencesRequired = 3,
    tpPct               = 3.0,
    slPct               = 1.5,
    feeTpPct            = 0.05,
    feeSlPct            = 0.10,
    leverage            = 1,
    initialCapital      = 1000,
    tradeDirection      = 'both',
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
  const { macdLine, signalLine } = computeMACD(closes, macdFast, macdSlow, macdSignalPeriod)
  const { upper: bbUpper, lower: bbLower } = computeBB(closes, bbPeriod, bbStdDev)
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

  for (let i = 1; i < N; i++) {
    const close = closes[i]
    const high  = highs[i]
    const low   = lows[i]
    const vol   = volumes[i]
    const time  = times[i]

    if (
      isNaN(emaFastArr[i]) || isNaN(emaSlowArr[i]) ||
      isNaN(rsiArr[i]) ||
      isNaN(macdLine[i]) || isNaN(signalLine[i]) ||
      isNaN(bbUpper[i])  || isNaN(bbLower[i]) ||
      isNaN(volMAArr[i])
    ) continue

    // ── Evaluar TP / SL del trade abierto ──
    let tpHit = false, slHit = false
    if (inTrade) {
      tpHit = isLong  ? high >= tpPr : low  <= tpPr
      slHit = !tpHit && (isLong ? low  <= slPr : high >= slPr)
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

    // ── Buscar nueva señal si no hay trade abierto ──
    if (!inTrade) {
      const highVol = vol > volMAArr[i] * volMultiplier

      const longScore = [
        emaFastArr[i] > emaSlowArr[i],   // EMA: tendencia alcista
        rsiArr[i]     < rsiOversold,       // RSI: sobrevendido
        macdLine[i]   > signalLine[i],     // MACD: momentum alcista
        highVol,                            // Volumen: confirmación
        close         <= bbLower[i],        // BB: precio en banda inferior
      ].filter(Boolean).length

      const shortScore = [
        emaFastArr[i] < emaSlowArr[i],   // EMA: tendencia bajista
        rsiArr[i]     > rsiOverbought,    // RSI: sobrecomprado
        macdLine[i]   < signalLine[i],    // MACD: momentum bajista
        highVol,                           // Volumen: confirmación
        close         >= bbUpper[i],       // BB: precio en banda superior
      ].filter(Boolean).length

      const longOk  = canLong  && longScore  >= confluencesRequired
      const shortOk = canShort && shortScore >= confluencesRequired

      let signalLong = false, signalShort = false
      if      (longOk && !shortOk)                  signalLong  = true
      else if (shortOk && !longOk)                  signalShort = true
      else if (longOk && shortOk) {
        if (longScore >= shortScore) signalLong  = true
        else                         signalShort = true
      }

      if (signalLong || signalShort) {
        signals.push({
          time,
          type:        signalLong ? 'LONG' : 'SHORT',
          price:       close,
          confluences: signalLong ? longScore : shortScore,
        })
        inTrade    = true
        isLong     = signalLong
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
