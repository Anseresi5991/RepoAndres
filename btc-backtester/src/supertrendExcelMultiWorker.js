/**
 * Web Worker — Análisis Multi-Combo desde Excel (Supertrend)
 *
 * Recibe combos del Excel exportado por el Análisis Profundo Supertrend,
 * arma grupos aleatorios de 3–15 combos, y evalúa el desempeño colectivo:
 * 1 trade a la vez, el primer combo del grupo que dispare señal toma el trade.
 */

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

function computeSupertrend(highs, lows, closes, period, multiplier) {
  const N            = highs.length
  const direction    = new Int8Array(N)
  const supertrendArr = new Float64Array(N).fill(NaN)
  const atr   = computeATR(highs, lows, closes, period)
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
  finalUpper[start]    = upperRaw[start]
  finalLower[start]    = lowerRaw[start]
  direction[start]     = 1
  supertrendArr[start] = finalLower[start]
  for (let i = start + 1; i < N; i++) {
    finalUpper[i] = closes[i - 1] <= finalUpper[i - 1]
      ? Math.min(upperRaw[i], finalUpper[i - 1])
      : upperRaw[i]
    finalLower[i] = closes[i - 1] >= finalLower[i - 1]
      ? Math.max(lowerRaw[i], finalLower[i - 1])
      : lowerRaw[i]
    direction[i] = direction[i - 1] === -1
      ? (closes[i] > finalUpper[i] ? 1 : -1)
      : (closes[i] < finalLower[i] ? -1 : 1)
    supertrendArr[i] = direction[i] === 1 ? finalLower[i] : finalUpper[i]
  }
  return { direction, supertrendArr }
}

function pickDistinct(n, max) {
  const picked = new Set()
  while (picked.size < n) picked.add(Math.floor(Math.random() * max))
  return [...picked]
}

function approxCombinations(n, k) {
  if (k > n) return 0
  if (k === 0 || k === n) return 1
  let result = 1
  for (let i = 0; i < k; i++) {
    result = result * (n - i) / (i + 1)
    if (result > 1e9) return 1e9
  }
  return Math.round(result)
}

function runMultiBacktestLite(group, comboMeta, highs, lows, closes, N, initialCapital) {
  let inTrade = false
  let isLong  = false
  let tpPrice = 0, slPrice = 0
  let activeEffTp = 0, activeEffSl = 0
  let tradeOpenedBar = -1

  let totalTp = 0, totalSl = 0
  let profitPct = 0, lossPct = 0
  let eqPct = 0, eqPeak = 0, maxDd = 0
  let capital = initialCapital

  for (let i = 0; i < N; i++) {
    // ── Evaluar TP/SL (no en la vela de apertura) ──
    if (inTrade && i !== tradeOpenedBar) {
      const tpHit = isLong ? highs[i] >= tpPrice : lows[i]  <= tpPrice
      const slHit = !tpHit && (isLong ? lows[i] <= slPrice  : highs[i] >= slPrice)

      if (tpHit) {
        totalTp++
        profitPct += activeEffTp; eqPct += activeEffTp
        if (eqPct > eqPeak) eqPeak = eqPct
        const dd = eqPeak - eqPct
        if (dd > maxDd) maxDd = dd
        capital *= (1 + activeEffTp / 100)
        inTrade = false
      } else if (slHit) {
        totalSl++
        lossPct += activeEffSl; eqPct -= activeEffSl
        if (eqPct > eqPeak) eqPeak = eqPct
        const dd = eqPeak - eqPct
        if (dd > maxDd) maxDd = dd
        capital *= (1 - activeEffSl / 100)
        inTrade = false
      }
    }

    // ── Abrir trade: primer combo del grupo que dispare ──
    if (!inTrade) {
      for (const ci of group) {
        const meta = comboMeta[ci]
        if (meta.longSignal[i]) {
          inTrade = true; isLong = true
          tpPrice = closes[i] * (1 + meta.tpPct / 100)
          slPrice = closes[i] * (1 - meta.slPct / 100)
          activeEffTp = meta.effTp; activeEffSl = meta.effSl
          tradeOpenedBar = i
          break
        } else if (meta.shortSignal[i]) {
          inTrade = true; isLong = false
          tpPrice = closes[i] * (1 - meta.tpPct / 100)
          slPrice = closes[i] * (1 + meta.slPct / 100)
          activeEffTp = meta.effTp; activeEffSl = meta.effSl
          tradeOpenedBar = i
          break
        }
      }
    }
  }

  const totalClosed = totalTp + totalSl
  const netPct  = profitPct - lossPct
  const winRate = totalClosed > 0 ? (totalTp / totalClosed) * 100 : 0
  return {
    totalTp, totalSl, totalClosed,
    totalNetPct:     netPct.toFixed(2),
    winRate:         winRate.toFixed(2),
    maxDrawdownPct:  maxDd.toFixed(2),
    compoundCapital: capital.toFixed(2),
  }
}

self.onmessage = function (e) {
  const {
    combos,
    candles,
    params,
    groupSizes   = [3,4,5,6,7,8,9,10,11,12,13,14,15],
    samplesPerSize = 5000,
  } = e.data

  const {
    feeSlPct,
    feeTpPct,
    leverage,
    initialCapital,
    tradeDirection = 'both',
    atrVolPeriod   = 20,
    rsiPeriod      = 14,
  } = params

  try {
    if (!combos || combos.length < 3) {
      self.postMessage({ type: 'error', message: 'Se necesitan al menos 3 combos cargados' })
      return
    }

    const N = candles.length
    const highs  = new Float64Array(N)
    const lows   = new Float64Array(N)
    const closes = new Float64Array(N)
    const opens  = new Float64Array(N)
    for (let i = 0; i < N; i++) {
      highs[i]  = parseFloat(candles[i].HighCandle)
      lows[i]   = parseFloat(candles[i].LowCandle)
      closes[i] = parseFloat(candles[i].CloseCandle)
      opens[i]  = parseFloat(candles[i].OpenCandle)
    }

    // Arrays compartidos
    const isSundayArr = new Uint8Array(N)
    for (let i = 0; i < N; i++) {
      isSundayArr[i] = new Date(candles[i].OpenTime).getUTCDay() === 0 ? 1 : 0
    }

    const rsiArr = computeRSI(closes, rsiPeriod)

    const bodyRatioArr = new Float64Array(N)
    for (let i = 0; i < N; i++) {
      const range = highs[i] - lows[i]
      bodyRatioArr[i] = range > 0 ? Math.abs(closes[i] - opens[i]) / range : 0
    }

    const canLong  = tradeDirection === 'both' || tradeDirection === 'long'
    const canShort = tradeDirection === 'both' || tradeDirection === 'short'

    // Cache de Supertrend por (period, multiplier) y ATR por period
    const stCache  = {}
    const atrCache = {}

    // Pre-computar señales por combo
    const comboMeta = combos.map(combo => {
      const period     = Math.round(combo.atrPeriod)
      const multiplier = combo.atrMultiplier
      const atrVF      = combo.atrVolFilter  || 0
      const rsiThr     = combo.rsiThreshold  || 0
      const bodyMin    = combo.bodyRatioMin   || 0

      const stKey = `${period}_${multiplier}`
      if (!stCache[stKey]) {
        stCache[stKey] = computeSupertrend(highs, lows, closes, period, multiplier)
      }
      const { direction, supertrendArr } = stCache[stKey]

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
        if (isNaN(supertrendArr[i])) continue
        const longCross  = direction[i] === 1  && direction[i - 1] === -1
        const shortCross = direction[i] === -1 && direction[i - 1] === 1
        if (!longCross && !shortCross) continue
        if (isSundayArr[i]) continue

        const atrOk = atrVF === 0 || (!isNaN(atrSmaArr[i]) && rawAtrArr[i] <= atrVF * atrSmaArr[i])
        if (!atrOk) continue

        const rsiVal     = rsiArr[i]
        const longRsiOk  = rsiThr === 0 || (!isNaN(rsiVal) && rsiVal <= rsiThr)
        const shortRsiOk = rsiThr === 0 || (!isNaN(rsiVal) && rsiVal >= (100 - rsiThr))

        const bodyOk = bodyMin === 0 || bodyRatioArr[i] >= bodyMin

        if (longCross  && canLong  && longRsiOk  && bodyOk) longSignal[i]  = 1
        if (shortCross && canShort && shortRsiOk && bodyOk) shortSignal[i] = 1
      }

      return {
        longSignal, shortSignal,
        tpPct: combo.tpPct, slPct: combo.slPct,
        effTp, effSl,
      }
    })

    // Muestreo aleatorio de grupos
    const M = combos.length
    const validSizes = groupSizes.filter(s => s <= M)
    const total = validSizes.reduce((sum, s) => {
      return sum + Math.min(samplesPerSize, approxCombinations(M, s))
    }, 0)

    const REPORT_EVERY = Math.max(50, Math.floor(total / 100))
    const MAX_RESULTS = 500
    let allResults = []
    let minScore = -Infinity
    let done = 0

    for (const size of validSizes) {
      const maxCombinations = approxCombinations(M, size)
      const samples = Math.min(samplesPerSize, maxCombinations)

      for (let n = 0; n < samples; n++) {
        const indices = pickDistinct(size, M)
        const bt = runMultiBacktestLite(indices, comboMeta, highs, lows, closes, N, initialCapital)

        const net = parseFloat(bt.totalNetPct)
        const dd  = parseFloat(bt.maxDrawdownPct)

        if (bt.totalClosed >= 3 && net > 0 && dd <= 50) {
          const score = net / Math.max(dd, 0.1)
          if (allResults.length < MAX_RESULTS || score > minScore) {
            allResults.push({
              size,
              combos: indices.map(idx => ({ idx, ...combos[idx] })),
              ...bt,
              _score: score,
            })
            if (allResults.length > MAX_RESULTS * 2) {
              allResults.sort((a, b) => b._score - a._score)
              allResults = allResults.slice(0, MAX_RESULTS)
              minScore = allResults[allResults.length - 1]._score
            }
          }
        }

        done++
        if (done % REPORT_EVERY === 0) {
          const sorted = allResults.slice().sort((a, b) => b._score - a._score).slice(0, 50)
          self.postMessage({ type: 'progress', done, total, topResults: sorted })
        }
      }
    }

    allResults.sort((a, b) => b._score - a._score)
    self.postMessage({ type: 'done', results: allResults })
  } catch (err) {
    self.postMessage({ type: 'error', message: err.message })
  }
}
