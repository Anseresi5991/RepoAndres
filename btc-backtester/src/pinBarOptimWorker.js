/**
 * Web Worker — Análisis Profundo Pin Bar
 *
 * Optimiza sobre: maxBodyPct × minWickPct × tpPct × slPct
 * Pre-computa las características de cada vela una sola vez.
 * Señales (longSig/shortSig) se pre-calculan para cada combo body/wick.
 *
 * Entrada:  { candles, optimRanges, params }
 * Salida:   postMessage({ type: 'progress'|'done'|'error', ... })
 */

function rangeValues(min, max, step) {
  const vals = []
  const s = parseFloat(step)
  if (s <= 0) return [parseFloat(min)]
  for (let v = parseFloat(min); v <= parseFloat(max) + 1e-9; v += s)
    vals.push(parseFloat(v.toFixed(6)))
  return vals
}

self.onmessage = function (e) {
  const { candles, optimRanges, params } = e.data

  try {
    const {
      feeTpPct       = 0.05,
      feeSlPct       = 0.10,
      leverage       = 1,
      tradeDirection = 'both',
    } = params

    const N = candles.length

    // Pre-computar datos OHLC y características de cada vela
    const highs      = new Float64Array(N)
    const lows       = new Float64Array(N)
    const closes     = new Float64Array(N)
    const bodyPcts   = new Float64Array(N)
    const lwPcts     = new Float64Array(N)
    const uwPcts     = new Float64Array(N)
    const validBar   = new Uint8Array(N)

    for (let i = 0; i < N; i++) {
      const open  = parseFloat(candles[i].OpenCandle)
      highs[i]    = parseFloat(candles[i].HighCandle)
      lows[i]     = parseFloat(candles[i].LowCandle)
      closes[i]   = parseFloat(candles[i].CloseCandle)
      if (open <= 0) continue
      const body = Math.abs(closes[i] - open)
      if (body <= 0) continue                       // doji puro: skip
      validBar[i] = 1
      const lowerWick  = Math.min(open, closes[i]) - lows[i]
      const upperWick  = highs[i] - Math.max(open, closes[i])
      bodyPcts[i] = (body      / open) * 100        // % del precio BTC
      lwPcts[i]   = (lowerWick / body) * 100        // mecha inferior como % del cuerpo
      uwPcts[i]   = (upperWick / body) * 100        // mecha superior como % del cuerpo
    }

    const canLong  = tradeDirection === 'both' || tradeDirection === 'long'
    const canShort = tradeDirection === 'both' || tradeDirection === 'short'

    const maxBodyVals = rangeValues(optimRanges.maxBodyPct.min, optimRanges.maxBodyPct.max, optimRanges.maxBodyPct.step)
    const minWickVals = rangeValues(optimRanges.minWickPct.min, optimRanges.minWickPct.max, optimRanges.minWickPct.step)
    const tpVals      = rangeValues(optimRanges.tpPct.min,      optimRanges.tpPct.max,      optimRanges.tpPct.step)
    const slVals      = rangeValues(optimRanges.slPct.min,      optimRanges.slPct.max,      optimRanges.slPct.step)

    const total       = maxBodyVals.length * minWickVals.length * tpVals.length * slVals.length
    const REPORT_EVERY = Math.max(10, Math.floor(total / 200))
    let done = 0
    let topResults = []

    for (const maxBody of maxBodyVals) {
      for (const minWick of minWickVals) {

        // Pre-calcular señales para este combo body/wick
        const longSig  = new Uint8Array(N)
        const shortSig = new Uint8Array(N)
        for (let i = 0; i < N; i++) {
          if (!validBar[i]) continue
          const bodyOk = bodyPcts[i] <= maxBody
          const lOk    = canLong  && bodyOk && lwPcts[i] >= minWick
          const sOk    = canShort && bodyOk && uwPcts[i] >= minWick
          if (lOk && sOk) {
            if (lwPcts[i] >= uwPcts[i]) longSig[i] = 1; else shortSig[i] = 1
          } else if (lOk) { longSig[i]  = 1
          } else if (sOk) { shortSig[i] = 1 }
        }

        for (const tp of tpVals) {
          const effTp = Math.max(tp - feeTpPct, 0) * leverage

          for (const sl of slVals) {
            const effSl = (sl + feeSlPct) * leverage

            let inTrade = false, isLong = false
            let tpPr = 0, slPr = 0
            let totalTp = 0, totalSl = 0, totalClosed = 0
            let profitPct = 0, lossPct = 0
            let eqPct = 0, eqPeak = 0, maxDrawdown = 0
            let compound = 1.0

            for (let i = 0; i < N; i++) {
              if (!validBar[i]) continue
              const close = closes[i]
              const high  = highs[i]
              const low   = lows[i]

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
                inTrade = false
              }

              if (!inTrade && (longSig[i] || shortSig[i])) {
                inTrade = true; isLong = longSig[i] === 1
                tpPr = isLong ? close * (1 + tp / 100) : close * (1 - tp / 100)
                slPr = isLong ? close * (1 - sl / 100) : close * (1 + sl / 100)
              }
            }

            const netPct  = profitPct - lossPct
            const winRate = totalClosed > 0 ? (totalTp / totalClosed) * 100 : 0
            const score   = totalClosed >= 5 && netPct > 0
              ? netPct / Math.max(maxDrawdown, 0.1)
              : -Infinity

            if (score > -Infinity) {
              topResults.push({
                maxBodyPct:     maxBody,
                minWickPct:     minWick,
                tpPct:          tp,
                slPct:          sl,
                totalTp, totalSl, totalClosed,
                totalNetPct:    netPct.toFixed(2),
                winRate:        winRate.toFixed(2),
                maxDrawdownPct: maxDrawdown.toFixed(2),
                compoundFactor: compound.toFixed(4),
                _score:         score,
              })
              if (topResults.length > 600) {
                topResults.sort((a, b) => b._score - a._score)
                topResults = topResults.slice(0, 400)
              }
            }

            done++
            if (done % REPORT_EVERY === 0) {
              const sorted = topResults.slice().sort((a, b) => b._score - a._score)
              self.postMessage({ type: 'progress', done, total, topResults: sorted.slice(0, 400) })
            }
          }
        }
      }
    }

    topResults.sort((a, b) => b._score - a._score)
    self.postMessage({ type: 'done', results: topResults.slice(0, 400) })

  } catch (err) {
    self.postMessage({ type: 'error', message: err.message })
  }
}
