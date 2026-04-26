// =============================================================================
// Pin Bar Backtest — Velas de rechazo por cuerpo y mecha
//
// LONG : mecha inferior >= minWickPct% del rango + cuerpo <= maxBodyPct% del rango
// SHORT: mecha superior >= minWickPct% del rango + cuerpo <= maxBodyPct% del rango
// =============================================================================

export function runPinBarBacktest(candles, params) {
  const {
    maxBodyPct          = 0.5,
    minWickPct          = 100,
    tpPct               = 1.5,
    slPct               = 0.8,
    feeTpPct            = 0.05,
    feeSlPct            = 0.10,
    leverage            = 1,
    initialCapital      = 1000,
    monthlyContribution = 0,
    tradeDirection      = 'both',
  } = params

  const N = candles.length
  if (N < 10) return null

  const effTp   = Math.max(tpPct - feeTpPct, 0) * leverage
  const effSl   = (slPct + feeSlPct) * leverage
  const canLong  = tradeDirection === 'both' || tradeDirection === 'long'
  const canShort = tradeDirection === 'both' || tradeDirection === 'short'

  let inTrade = false, isLong = false
  let entryPr = 0, tpPr = 0, slPr = 0
  let openTime = null, capAtEntry = initialCapital
  let totalTp = 0, totalSl = 0, totalClosed = 0
  let profitPct = 0, lossPct = 0
  let eqPct = 0, eqPeak = 0, maxDrawdown = 0
  let compound = initialCapital, simple = initialCapital
  let currentMonth = null

  const trades  = []
  const signals = []

  for (let i = 0; i < N; i++) {
    const c     = candles[i]
    const open  = parseFloat(c.OpenCandle)
    const high  = parseFloat(c.HighCandle)
    const low   = parseFloat(c.LowCandle)
    const close = parseFloat(c.CloseCandle)
    const time  = c.OpenTime

    // Aporte mensual al inicio de cada nuevo mes
    const month = time.substring(0, 7)
    if (monthlyContribution > 0 && currentMonth !== null && month !== currentMonth) {
      compound += monthlyContribution
      simple   += monthlyContribution
    }
    currentMonth = month

    if (open <= 0) continue

    const body      = Math.abs(close - open)
    if (body <= 0) continue                         // doji puro: mecha/cuerpo indefinida
    const lowerWick = Math.min(open, close) - low
    const upperWick = high - Math.max(open, close)
    const bodyPct   = (body       / open) * 100     // % del precio BTC
    const lwPct     = (lowerWick  / body) * 100     // mecha inferior como % del cuerpo
    const uwPct     = (upperWick  / body) * 100     // mecha superior como % del cuerpo

    // ── Evaluar TP / SL de la posición abierta ──
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

    // ── Buscar señal pin bar ──
    if (!inTrade) {
      const bodyOk  = bodyPct <= maxBodyPct
      const longOk  = canLong  && bodyOk && lwPct >= minWickPct
      const shortOk = canShort && bodyOk && uwPct >= minWickPct

      let goLong = false, goShort = false
      if (longOk && shortOk) {
        // Ambas califican: gana la mecha más grande
        if (lwPct >= uwPct) goLong = true; else goShort = true
      } else if (longOk)  { goLong  = true }
        else if (shortOk) { goShort = true }

      if (goLong || goShort) {
        signals.push({
          time,
          type:     goLong ? 'LONG' : 'SHORT',
          price:    close,
          bodyPct:  bodyPct.toFixed(1),
          wickPct:  goLong ? lwPct.toFixed(1) : uwPct.toFixed(1),
        })
        inTrade    = true
        isLong     = goLong
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
