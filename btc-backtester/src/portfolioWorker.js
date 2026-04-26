/**
 * Web Worker — Portfolio Multi-Estrategia SHORT
 * Recibe: { strategies: [{name, combos}], candles, params }
 * combo fields: minRangePct, maxRangePct, lookbackCandles, minWickPct, slPct, tpPct, emaMinGapPct
 * params: { feeSlPct, feeTpPct, leverage, capitalPerStrategy }
 *
 * Reglas:
 *   - Máx 1 trade abierto por estrategia a la vez
 *   - Máx 1 señal por día por estrategia (dailySignalUsed independiente)
 *   - Distintas estrategias pueden tener trades simultáneos
 */

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

function precomputeWindows(highs, lows, lookbacks) {
  const highestByLb = {}, lowestByLb = {}
  const N = highs.length
  for (const lb of lookbacks) {
    const h = new Float64Array(N), l = new Float64Array(N)
    for (let i = 0; i < N; i++) {
      let max = -Infinity, min = Infinity
      const start = Math.max(0, i - lb + 1)
      for (let j = start; j <= i; j++) {
        if (highs[j] > max) max = highs[j]
        if (lows[j]  < min) min = lows[j]
      }
      h[i] = max; l[i] = min
    }
    highestByLb[lb] = h; lowestByLb[lb] = l
  }
  return { highestByLb, lowestByLb }
}

self.onmessage = function(e) {
  const { strategies, candles, params } = e.data
  try {
    const { feeSlPct, feeTpPct, leverage, capitalPerStrategy = 1000 } = params
    const N = candles.length

    const closes = new Float64Array(N), highs = new Float64Array(N)
    const lows   = new Float64Array(N), opens = new Float64Array(N)
    for (let i = 0; i < N; i++) {
      closes[i] = parseFloat(candles[i].CloseCandle)
      highs[i]  = parseFloat(candles[i].HighCandle)
      lows[i]   = parseFloat(candles[i].LowCandle)
      opens[i]  = parseFloat(candles[i].OpenCandle)
    }

    const ema10 = ema(closes, 10)
    const ema50 = ema(closes, 50)

    const isNewDay = new Uint8Array(N)
    isNewDay[0] = 1
    for (let i = 1; i < N; i++)
      isNewDay[i] = candles[i].OpenTime.substring(0, 10) !== candles[i - 1].OpenTime.substring(0, 10) ? 1 : 0

    const allCombos = strategies.flatMap(s => s.combos)
    const uniqueLookbacks = [...new Set(allCombos.map(c => c.lookbackCandles))]
    const { highestByLb, lowestByLb } = precomputeWindows(highs, lows, uniqueLookbacks)

    // Estado por estrategia
    const ss = strategies.map(strategy => ({
      name:            strategy.name,
      combos:          strategy.combos,
      comboStates:     strategy.combos.map(() => ({
        activeRangeTop: 0, hasActiveRange: false,
        firstTouchDone: false, prevIsTight: false,
      })),
      dailySignalUsed: false,
      openTrade:       null,
      trades:          [],
      equityPct:       0, equityPeakPct: 0, maxDrawdownPct: 0,
      compoundCapital: capitalPerStrategy,
      totalTp: 0, totalSl: 0, totalClosed: 0,
      totalProfitPct: 0, totalLossPct: 0,
    }))

    // Simulación candle a candle
    for (let i = 0; i < N; i++) {
      const newDay  = isNewDay[i] === 1
      const high    = highs[i], low = lows[i], close = closes[i], open = opens[i]
      const time    = candles[i].OpenTime
      const cRange  = high - low
      const uwPct   = cRange > 0 ? (high - Math.max(open, close)) / cRange * 100 : 0
      const emaGap  = (ema10[i] != null && ema50[i] != null && ema50[i] > 0)
        ? (ema50[i] - ema10[i]) / ema50[i] * 100 : 0
      const bearBase = ema10[i] != null && ema50[i] != null && ema10[i] < ema50[i]

      for (const st of ss) {
        if (newDay) st.dailySignalUsed = false

        // Cerrar trade abierto si alcanza TP o SL
        if (st.openTrade) {
          const t = st.openTrade
          let result = null, pnl = 0
          if      (low <= t.tp)  { result = 'TP'; pnl =  t.effTp; st.totalTp++; st.totalProfitPct += t.effTp }
          else if (high >= t.sl) { result = 'SL'; pnl = -t.effSl; st.totalSl++; st.totalLossPct  += t.effSl }
          if (result) {
            st.totalClosed++
            st.equityPct      += pnl
            st.equityPeakPct   = Math.max(st.equityPeakPct, st.equityPct)
            st.maxDrawdownPct  = Math.max(st.maxDrawdownPct, st.equityPeakPct - st.equityPct)
            st.compoundCapital *= result === 'TP' ? (1 + t.effTp / 100) : (1 - t.effSl / 100)
            st.trades.push({ ...t, result, closeTime: time, pnlPct: pnl })
            st.openTrade = null
          }
        }

        // Intentar nueva entrada: sin trade abierto y sin señal del día
        const canEnter = !st.openTrade && !st.dailySignalUsed

        let fired = false
        for (let ci = 0; ci < st.combos.length; ci++) {
          const combo = st.combos[ci]
          const cst   = st.comboStates[ci]
          const hh    = highestByLb[combo.lookbackCandles][i]
          const ll    = lowestByLb[combo.lookbackCandles][i]
          const rPct  = close > 0 ? (hh - ll) / close * 100 : 0
          const tight = rPct >= combo.minRangePct && rPct <= combo.maxRangePct

          // Actualizar estado de rango siempre
          if  (tight && !cst.prevIsTight) { cst.activeRangeTop = hh; cst.hasActiveRange = true; cst.firstTouchDone = false }
          if  (!tight)                    { cst.hasActiveRange = false; cst.firstTouchDone = false }

          // Verificar señal de entrada
          if (!fired && canEnter) {
            const isBear = bearBase && emaGap >= (combo.emaMinGapPct ?? 0)
            if (isBear && tight && !cst.firstTouchDone && cst.hasActiveRange &&
                high >= cst.activeRangeTop && cRange > 0 && uwPct >= combo.minWickPct) {
              cst.firstTouchDone = true
              st.dailySignalUsed = true
              const effTp = Math.max(combo.tpPct - feeTpPct, 0) * leverage
              const effSl = (combo.slPct + feeSlPct) * leverage
              st.openTrade = {
                strategyName: st.name,
                entryTime:    time,
                entryPrice:   close,
                slPrice:      close * (1 + combo.slPct / 100),
                tpPrice:      close * (1 - combo.tpPct / 100),
                sl:           close * (1 + combo.slPct / 100),
                tp:           close * (1 - combo.tpPct / 100),
                effTp, effSl,
              }
              fired = true
            }
          }

          cst.prevIsTight = tight
        }
      }
    }

    // Construir resultados por estrategia
    const perStrategy = ss.map(st => {
      const netPct  = st.totalProfitPct - st.totalLossPct
      const winRate = st.totalClosed > 0 ? (st.totalTp / st.totalClosed) * 100 : 0
      return {
        name:            st.name,
        numCombos:       st.combos.length,
        totalTp:         st.totalTp,
        totalSl:         st.totalSl,
        totalClosed:     st.totalClosed,
        totalNetPct:     netPct.toFixed(2),
        winRate:         winRate.toFixed(2),
        maxDrawdownPct:  st.maxDrawdownPct.toFixed(2),
        initialCapital:  capitalPerStrategy,
        compoundCapital: st.compoundCapital.toFixed(2),
        trades:          st.trades,
      }
    })

    // Trades combinados ordenados por fecha de entrada
    const allTrades = ss
      .flatMap(st => st.trades)
      .sort((a, b) => new Date(a.entryTime) - new Date(b.entryTime))

    // Stats combinados
    const totalClosed  = ss.reduce((s, st) => s + st.totalClosed, 0)
    const totalTp      = ss.reduce((s, st) => s + st.totalTp, 0)
    const totalNetPct  = ss.reduce((s, st) => s + (st.totalProfitPct - st.totalLossPct), 0)
    const winRate      = totalClosed > 0 ? (totalTp / totalClosed) * 100 : 0
    const maxDD        = ss.length > 0 ? Math.max(...ss.map(st => st.maxDrawdownPct)) : 0
    const finalCapital = ss.reduce((s, st) => s + st.compoundCapital, 0)
    const initCapTotal = capitalPerStrategy * strategies.length

    const combined = {
      totalTp,
      totalSl:        totalClosed - totalTp,
      totalClosed,
      totalNetPct:    totalNetPct.toFixed(2),
      winRate:        winRate.toFixed(2),
      maxDrawdownPct: maxDD.toFixed(2),
      initialCapital: initCapTotal,
      compoundCapital: finalCapital.toFixed(2),
    }

    self.postMessage({ type: 'done', perStrategy, combined, allTrades })
  } catch (err) {
    self.postMessage({ type: 'error', message: err.message })
  }
}
