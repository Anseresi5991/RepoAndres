// =============================================================================
// ATR — Wilder's RMA
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
  if (N < period) return atr
  let sum = 0
  for (let i = 0; i < period; i++) sum += tr[i]
  atr[period - 1] = sum / period
  for (let i = period; i < N; i++) {
    atr[i] = (atr[i - 1] * (period - 1) + tr[i]) / period
  }
  return atr
}

// =============================================================================
// SMA rodante
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
// direction: 1 = alcista (precio sobre la banda), -1 = bajista
// =============================================================================
function computeSupertrend(highs, lows, closes, period, multiplier) {
  const N = highs.length
  const direction    = new Int8Array(N)
  const supertrendArr = new Float64Array(N).fill(NaN)
  const atr = computeATR(highs, lows, closes, period)
  const start = period - 1
  if (start >= N) return { direction, supertrendArr }

  const upperRaw = new Float64Array(N)
  const lowerRaw = new Float64Array(N)
  for (let i = start; i < N; i++) {
    const hl2   = (highs[i] + lows[i]) / 2
    upperRaw[i] = hl2 + multiplier * atr[i]
    lowerRaw[i] = hl2 - multiplier * atr[i]
  }

  const finalUpper = new Float64Array(N)
  const finalLower = new Float64Array(N)
  finalUpper[start] = upperRaw[start]
  finalLower[start] = lowerRaw[start]
  direction[start]  = 1
  supertrendArr[start] = finalLower[start]

  for (let i = start + 1; i < N; i++) {
    finalUpper[i] = closes[i - 1] <= finalUpper[i - 1]
      ? Math.min(upperRaw[i], finalUpper[i - 1])
      : upperRaw[i]
    finalLower[i] = closes[i - 1] >= finalLower[i - 1]
      ? Math.max(lowerRaw[i], finalLower[i - 1])
      : lowerRaw[i]

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
// Mapa de sincronización: para cada vela 5m[i] retorna el índice del último
// candle 15m cuyo OpenTime <= OpenTime de la vela 5m[i].
// Ambos arrays deben estar ordenados ASC por OpenTime.
// Usa dos punteros → O(n+m).
// =============================================================================
function build15mIndexMap(candles5m, candles15m) {
  const n5  = candles5m.length
  const n15 = candles15m.length
  const map = new Int32Array(n5).fill(-1)
  let ptr = 0
  for (let i = 0; i < n5; i++) {
    const t5 = candles5m[i].OpenTime
    while (ptr < n15 && candles15m[ptr].OpenTime <= t5) ptr++
    map[i] = ptr - 1   // último 15m con OpenTime <= t5 de la vela 5m
  }
  return map
}

// =============================================================================
// Backtest principal Scalping 5m
// Entradas: cruce de Supertrend en 5m
// Filtro de tendencia: dirección del Supertrend en 15m
// =============================================================================
export function runScalping5mBacktest(candles5m, candles15m, params) {
  const {
    // Supertrend 5m (entrada)
    atrPeriod5m      = 10,
    atrMultiplier5m  = 3.0,
    // Supertrend 15m (filtro de tendencia)
    atrPeriod15m     = 10,
    atrMultiplier15m = 3.0,
    use15mFilter     = true,    // false = desactiva el filtro 15m
    // TP / SL
    tpPct            = 0.8,
    slPct            = 0.5,
    feeTpPct         = 0.05,
    feeSlPct         = 0.10,
    leverage         = 10,
    initialCapital   = 1000,
    // Filtros opcionales
    tradeDirection   = 'both',  // 'both' | 'long' | 'short'
    skipSundays      = true,
    rsiPeriod        = 14,
    rsiThreshold     = 0,       // 0 = desactivado
    atrVolFilter     = 0,       // 0 = desactivado; >0 = solo si ATR <= ratio × SMA(ATR)
    atrVolPeriod     = 20,
    bodyRatioMin     = 0,       // 0 = desactivado
    maxTradesPerDay  = 0,       // 0 = sin límite (scalping); >0 = límite diario
  } = params

  const N5  = candles5m.length
  const N15 = candles15m.length
  if (N5 < atrPeriod5m + 5 || N15 < atrPeriod15m + 5) return null

  // ── Arrays 5m ──────────────────────────────────────────────────────────────
  const highs5m  = new Float64Array(N5)
  const lows5m   = new Float64Array(N5)
  const closes5m = new Float64Array(N5)
  const opens5m  = new Float64Array(N5)
  for (let i = 0; i < N5; i++) {
    highs5m[i]  = parseFloat(candles5m[i].HighCandle)
    lows5m[i]   = parseFloat(candles5m[i].LowCandle)
    closes5m[i] = parseFloat(candles5m[i].CloseCandle)
    opens5m[i]  = parseFloat(candles5m[i].OpenCandle)
  }

  // ── Arrays 15m ─────────────────────────────────────────────────────────────
  const highs15m  = new Float64Array(N15)
  const lows15m   = new Float64Array(N15)
  const closes15m = new Float64Array(N15)
  for (let i = 0; i < N15; i++) {
    highs15m[i]  = parseFloat(candles15m[i].HighCandle)
    lows15m[i]   = parseFloat(candles15m[i].LowCandle)
    closes15m[i] = parseFloat(candles15m[i].CloseCandle)
  }

  // ── Indicadores ────────────────────────────────────────────────────────────
  const { direction: dir5m }  = computeSupertrend(highs5m,  lows5m,  closes5m,  atrPeriod5m,  atrMultiplier5m)
  const { direction: dir15m } = use15mFilter
    ? computeSupertrend(highs15m, lows15m, closes15m, atrPeriod15m, atrMultiplier15m)
    : { direction: new Int8Array(N15).fill(1) }   // filtro desactivado = siempre alcista

  const rsiArr    = rsiThreshold > 0  ? computeRSI(closes5m, rsiPeriod)                        : null
  const rawAtrArr = atrVolFilter > 0  ? computeATR(highs5m, lows5m, closes5m, atrPeriod5m)     : null
  const atrSmaArr = rawAtrArr         ? computeRollingSMA(rawAtrArr, atrVolPeriod)              : null

  const idx15m = build15mIndexMap(candles5m, candles15m)

  const effTp = Math.max(tpPct - feeTpPct, 0) * leverage
  const effSl = (slPct + feeSlPct) * leverage

  const canLong  = tradeDirection === 'both' || tradeDirection === 'long'
  const canShort = tradeDirection === 'both' || tradeDirection === 'short'

  // ── Estado del backtest ────────────────────────────────────────────────────
  let inTrade    = false
  let isLong     = false
  let entryPr    = 0
  let tpPr       = 0
  let slPr       = 0
  let openTime   = null
  let tradeBar   = -1
  let capAtEntry = initialCapital

  let totalTp    = 0, totalSl = 0, totalClosed = 0
  let profitPct  = 0, lossPct = 0, netPct = 0
  let eqPct      = 0, eqPeak = 0, maxDrawdown = 0
  let compound   = initialCapital
  let simple     = initialCapital

  // Contador de trades por día (para maxTradesPerDay)
  let currentDay      = ''
  let tradesThisDay   = 0

  const trades  = []
  const signals = []

  for (let i = Math.max(atrPeriod5m, 1); i < N5; i++) {
    const time  = candles5m[i].OpenTime
    const high  = highs5m[i]
    const low   = lows5m[i]
    const close = closes5m[i]

    // ── Evaluar TP/SL (nunca en la vela de apertura) ─────────────────────────
    if (inTrade && i !== tradeBar) {
      const tpHit = isLong ? high >= tpPr  : low  <= tpPr
      const slHit = !tpHit && (isLong ? low <= slPr : high >= slPr)

      if (tpHit || slHit) {
        const win = tpHit
        if (win) { totalTp++; profitPct += effTp; eqPct += effTp }
        else     { totalSl++; lossPct  += effSl;  eqPct -= effSl }
        totalClosed++
        netPct      = profitPct - lossPct
        eqPeak      = Math.max(eqPeak, eqPct)
        maxDrawdown = Math.max(maxDrawdown, eqPeak - eqPct)
        compound    = win ? compound * (1 + effTp / 100) : compound * (1 - effSl / 100)
        simple      = initialCapital * (1 + netPct / 100)

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
    }

    if (inTrade) continue

    // ── Cruce de Supertrend 5m ────────────────────────────────────────────────
    const longCross5m  = dir5m[i] === 1  && dir5m[i - 1] === -1
    const shortCross5m = dir5m[i] === -1 && dir5m[i - 1] === 1
    if (!longCross5m && !shortCross5m) continue

    // ── Filtro de día / conteo diario ─────────────────────────────────────────
    const utcDay = time.slice(0, 10)
    if (utcDay !== currentDay) { currentDay = utcDay; tradesThisDay = 0 }
    if (maxTradesPerDay > 0 && tradesThisDay >= maxTradesPerDay) continue

    // ── Filtros auxiliares ────────────────────────────────────────────────────
    if (skipSundays && new Date(time).getUTCDay() === 0) continue

    const atrOk = !rawAtrArr || (!isNaN(atrSmaArr[i]) && rawAtrArr[i] <= atrVolFilter * atrSmaArr[i])
    if (!atrOk) continue

    const rsiVal     = rsiArr ? rsiArr[i] : NaN
    const longRsiOk  = rsiThreshold === 0 || (!isNaN(rsiVal) && rsiVal <= rsiThreshold)
    const shortRsiOk = rsiThreshold === 0 || (!isNaN(rsiVal) && rsiVal >= (100 - rsiThreshold))

    const range   = high - low
    const bodyOk  = bodyRatioMin === 0 || (range > 0 && Math.abs(close - opens5m[i]) / range >= bodyRatioMin)

    // ── Filtro de tendencia 15m ───────────────────────────────────────────────
    const idx = idx15m[i]
    const trend15m = use15mFilter && idx >= 0 ? dir15m[idx] : 1   // 1=alcista, -1=bajista
    const longTrendOk  = !use15mFilter || trend15m === 1
    const shortTrendOk = !use15mFilter || trend15m === -1

    const longOk  = longCross5m  && canLong  && longTrendOk  && longRsiOk  && bodyOk
    const shortOk = shortCross5m && canShort && shortTrendOk && shortRsiOk && bodyOk
    if (!longOk && !shortOk) continue

    // ── Abrir trade ───────────────────────────────────────────────────────────
    inTrade    = true
    isLong     = longOk
    entryPr    = close
    openTime   = time
    tradeBar   = i
    capAtEntry = compound
    tradesThisDay++

    tpPr = isLong ? close * (1 + tpPct / 100) : close * (1 - tpPct / 100)
    slPr = isLong ? close * (1 - slPct / 100) : close * (1 + slPct / 100)

    signals.push({
      time,
      type:      isLong ? 'LONG' : 'SHORT',
      price:     close,
      trend15m,
    })
  }

  const winRate    = totalClosed > 0 ? (totalTp / totalClosed) * 100 : 0
  const bestMethod = compound > simple ? 'Compuesto' : simple > compound ? 'Simple' : 'Iguales'
  const avgPerDay  = totalClosed > 0
    ? (() => {
        const days = new Set(trades.map(t => t.time.slice(0, 10))).size
        return days > 0 ? (totalClosed / days).toFixed(2) : '0'
      })()
    : '0'

  return {
    totalCandles5m:  N5,
    totalCandles15m: N15,
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
      avgTradesPerDay: avgPerDay,
    },
    trades,
    signals,
  }
}
