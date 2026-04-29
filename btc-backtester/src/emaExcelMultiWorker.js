/**
 * Web Worker — Análisis Multi-Combo EMA Touch desde Excel
 * Recibe: { combos, candles, params, groupSizes, samplesPerSize }
 * Cada combo: { emaPeriod, minWickPct, slPct, tpPct }
 * Params compartidos: feeSlPct, feeTpPct, leverage, initialCapital,
 *   direction, slowEmaPeriod, emaSlopeLookback, maxBodyPct,
 *   emaConsistencyBars, minCrossBodyPct, atrPeriod, atrMaPeriod,
 *   atrMaxMultiplier, rsiPeriod, rsiShortMax, rsiLongMin
 *
 * Pre-computa firstTouchShort/Long por período EMA único (una vez).
 * Para cada grupo aleatorio corre un backtest multi-combo idéntico
 * al de backtesterEma.js (1 trade abierto a la vez, 1 señal por día).
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

function rsi(closes, period) {
  const N = closes.length
  const result = new Float64Array(N)
  if (N <= period) return result
  let gainSum = 0, lossSum = 0
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1]
    if (d > 0) gainSum += d; else lossSum -= d
  }
  let avgGain = gainSum / period
  let avgLoss = lossSum / period
  result[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss)
  for (let i = period + 1; i < N; i++) {
    const d = closes[i] - closes[i - 1]
    avgGain = (avgGain * (period - 1) + (d > 0 ? d : 0)) / period
    avgLoss = (avgLoss * (period - 1) + (d < 0 ? -d : 0)) / period
    result[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss)
  }
  return result
}

function runGroupBacktest(comboData, N, closes, highs, lows, isNewDay, direction, initialCapital) {
  let dailySignalUsed = false
  let tradeOpen = false, tradeTipo = 0, tradeSl = 0, tradeTp = 0
  let tradeEntryBar = -1, tradeEffTp = 0, tradeEffSl = 0, tradeSlPct = 0, tradeTpPct = 0

  let totalTp = 0, totalSl = 0
  let profitPct = 0, lossPct = 0
  let equityPct = 0, equityPeak = 0, maxDd = 0
  let capital = initialCapital

  for (let i = 0; i < N; i++) {
    if (isNewDay[i]) dailySignalUsed = false

    if (tradeOpen && i > tradeEntryBar) {
      const h = highs[i], l = lows[i]
      const slHit = tradeTipo === 1 ? h >= tradeSl : l <= tradeSl
      const tpHit = tradeTipo === 1 ? l <= tradeTp : h >= tradeTp
      if (slHit) {
        totalSl++
        lossPct   += tradeEffSl
        equityPct -= tradeEffSl
        equityPeak = Math.max(equityPeak, equityPct)
        maxDd      = Math.max(maxDd, equityPeak - equityPct)
        capital   *= (1 - tradeEffSl / 100)
        tradeOpen  = false
      } else if (tpHit) {
        totalTp++
        profitPct  += tradeEffTp
        equityPct  += tradeEffTp
        equityPeak  = Math.max(equityPeak, equityPct)
        maxDd       = Math.max(maxDd, equityPeak - equityPct)
        capital    *= (1 + tradeEffTp / 100)
        tradeOpen   = false
      }
    }

    if (!dailySignalUsed && !tradeOpen) {
      for (const cd of comboData) {
        let sigTipo = 0
        if ((direction === 'R' || direction === 'BOTH') && cd.ftShort[i] && cd.upperWick[i] >= cd.minWickPct)
          sigTipo = 1
        if (!sigTipo && (direction === 'S' || direction === 'BOTH') && cd.ftLong[i] && cd.lowerWick[i] >= cd.minWickPct)
          sigTipo = 2
        if (sigTipo) {
          dailySignalUsed = true
          tradeOpen       = true
          tradeTipo       = sigTipo
          tradeEntryBar   = i
          tradeEffTp      = cd.effTp
          tradeEffSl      = cd.effSl
          const ep = closes[i]
          tradeSl = sigTipo === 1 ? ep * (1 + cd.slPct / 100) : ep * (1 - cd.slPct / 100)
          tradeTp = sigTipo === 1 ? ep * (1 - cd.tpPct / 100) : ep * (1 + cd.tpPct / 100)
          break
        }
      }
    }
  }

  const totalClosed = totalTp + totalSl
  const netPct = profitPct - lossPct
  const winRate = totalClosed > 0 ? (totalTp / totalClosed) * 100 : 0
  return {
    totalTp, totalSl, totalClosed,
    totalNetPct:     netPct.toFixed(2),
    winRate:         winRate.toFixed(2),
    maxDrawdownPct:  maxDd.toFixed(2),
    compoundCapital: capital.toFixed(2),
  }
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

self.onmessage = function (e) {
  const { combos, candles, params, groupSizes = [3,4,5,6,7,8,9,10,11,12,13,14,15], samplesPerSize = 5000 } = e.data

  try {
    if (!combos || combos.length < 3) {
      self.postMessage({ type: 'error', message: 'Se necesitan al menos 3 combos cargados' })
      return
    }

    const N = candles.length
    const closes = new Float64Array(N)
    const highs  = new Float64Array(N)
    const lows   = new Float64Array(N)
    const opens  = new Float64Array(N)
    for (let i = 0; i < N; i++) {
      closes[i] = parseFloat(candles[i].CloseCandle)
      highs[i]  = parseFloat(candles[i].HighCandle)
      lows[i]   = parseFloat(candles[i].LowCandle)
      opens[i]  = parseFloat(candles[i].OpenCandle)
    }

    const isNewDay = new Uint8Array(N)
    isNewDay[0] = 1
    for (let i = 1; i < N; i++) {
      isNewDay[i] = candles[i].OpenTime.substring(0, 10) !== candles[i - 1].OpenTime.substring(0, 10) ? 1 : 0
    }

    const {
      feeSlPct, feeTpPct, leverage, initialCapital,
      direction        = 'BOTH',
      slowEmaPeriod    = 200,
      emaSlopeLookback = 5,
      maxBodyPct       = 50,
      emaConsistencyBars = 3,
      minCrossBodyPct  = 30,
      atrPeriod        = 0,
      atrMaPeriod      = 0,
      atrMaxMultiplier = 1.5,
      rsiPeriod        = 0,
      rsiShortMax      = 65,
      rsiLongMin       = 35,
    } = params

    // ── ATR ──
    const atrOk = new Uint8Array(N).fill(1)
    if (atrPeriod > 1 && atrMaPeriod > 1 && N >= atrPeriod + atrMaPeriod) {
      const atrArr = new Float64Array(N)
      let sumTr = highs[0] - lows[0]
      for (let i = 1; i < atrPeriod; i++)
        sumTr += Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i-1]), Math.abs(lows[i] - closes[i-1]))
      atrArr[atrPeriod - 1] = sumTr / atrPeriod
      for (let i = atrPeriod; i < N; i++) {
        const tr = Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i-1]), Math.abs(lows[i] - closes[i-1]))
        atrArr[i] = (atrArr[i-1] * (atrPeriod - 1) + tr) / atrPeriod
      }
      let sumAtr = 0
      for (let i = atrPeriod - 1; i < N; i++) {
        sumAtr += atrArr[i]
        const cnt = i - (atrPeriod - 1) + 1
        if (cnt > atrMaPeriod) sumAtr -= atrArr[i - atrMaPeriod]
        if (cnt >= atrMaPeriod) {
          const atrMa = sumAtr / atrMaPeriod
          atrOk[i] = atrArr[i] <= atrMa * atrMaxMultiplier ? 1 : 0
        }
      }
    }

    // ── RSI ──
    const rsiArr = rsiPeriod > 1 && N > rsiPeriod ? rsi(closes, rsiPeriod) : null

    // ── EMA lenta ──
    const slowEmaArr = slowEmaPeriod > 0 ? ema(closes, slowEmaPeriod) : null

    // ── Pre-cómputo por período EMA único ──
    const uniquePeriods = [...new Set(combos.map(c => c.emaPeriod))]
    const perPeriod = {}

    for (const period of uniquePeriods) {
      const emaArr   = ema(closes, period)
      const upperWick = new Float64Array(N)
      const lowerWick = new Float64Array(N)
      const canShort  = new Uint8Array(N)
      const canLong   = new Uint8Array(N)

      for (let i = 0; i < N; i++) {
        const ev = emaArr[i]
        if (ev === null) continue
        const h = highs[i], l = lows[i], o = opens[i], c = closes[i]
        const cr = h - l
        if (cr <= 0) continue
        const maxOC = o > c ? o : c
        const minOC = o < c ? o : c
        upperWick[i] = (h - maxOC) / cr * 100
        lowerWick[i] = (minOC - l) / cr * 100
        const sv      = slowEmaArr ? slowEmaArr[i] : null
        const prevEv  = emaSlopeLookback > 0 && i >= emaSlopeLookback ? emaArr[i - emaSlopeLookback] : null
        const bearish  = sv === null || ev < sv
        const bullish  = sv === null || ev > sv
        const slopeDown = prevEv === null || ev < prevEv
        const slopeUp   = prevEv === null || ev > prevEv
        const bodyRatio = (o > c ? o - c : c - o) / cr * 100
        const bodyOk    = maxBodyPct <= 0 || bodyRatio < maxBodyPct
        canShort[i] = (h >= ev && maxOC < ev && bearish && slopeDown && bodyOk && c < o) ? 1 : 0
        canLong[i]  = (l <= ev && minOC > ev && bullish && slopeUp   && bodyOk && c > o) ? 1 : 0
      }

      // Máquina de estados — primer toque tras cruzar (idéntico a emaOptimWorker)
      const ftShort = new Uint8Array(N)
      const ftLong  = new Uint8Array(N)
      let bodyAboveCount = 0, crossedToBelow = false, firstShortDone = false, crossBodyOkShort = false
      let bodyBelowCount = 0, crossedToAbove = false, firstLongDone  = false, crossBodyOkLong  = false

      for (let i = 0; i < N; i++) {
        const ev = emaArr[i]
        if (ev === null) continue
        const o = opens[i], c = closes[i], h = highs[i], l = lows[i]
        const maxOC = o > c ? o : c
        const minOC = o < c ? o : c
        const cr = h - l

        if (maxOC >= ev) {
          bodyAboveCount++
          crossedToBelow = false; firstShortDone = false; crossBodyOkShort = false
        } else {
          if (bodyAboveCount >= emaConsistencyBars) {
            crossedToBelow = true
            crossBodyOkShort = minCrossBodyPct <= 0 || (o > c && cr > 0 && (o - c) / cr * 100 >= minCrossBodyPct)
          }
          bodyAboveCount = 0
        }
        const rsiVal     = rsiArr ? rsiArr[i] : 0
        const rsiOkShort = rsiPeriod <= 0 || rsiVal === 0 || rsiVal <= rsiShortMax
        ftShort[i] = (canShort[i] && crossedToBelow && crossBodyOkShort && !firstShortDone && atrOk[i] && rsiOkShort) ? 1 : 0
        if (ftShort[i]) firstShortDone = true

        if (minOC <= ev) {
          bodyBelowCount++
          crossedToAbove = false; firstLongDone = false; crossBodyOkLong = false
        } else {
          if (bodyBelowCount >= emaConsistencyBars) {
            crossedToAbove = true
            crossBodyOkLong = minCrossBodyPct <= 0 || (c > o && cr > 0 && (c - o) / cr * 100 >= minCrossBodyPct)
          }
          bodyBelowCount = 0
        }
        const rsiOkLong = rsiPeriod <= 0 || rsiVal === 0 || rsiVal >= rsiLongMin
        ftLong[i] = (canLong[i] && crossedToAbove && crossBodyOkLong && !firstLongDone && atrOk[i] && rsiOkLong) ? 1 : 0
        if (ftLong[i]) firstLongDone = true
      }

      perPeriod[period] = { upperWick, lowerWick, ftShort, ftLong }
    }

    // ── Muestreo aleatorio de grupos ──
    const M = combos.length
    const validSizes = groupSizes.filter(s => s <= M)
    const total = validSizes.reduce((sum, s) => sum + Math.min(samplesPerSize, approxCombinations(M, s)), 0)
    const REPORT_EVERY = Math.max(50, Math.floor(total / 100))
    let allResults = []
    let done = 0

    for (const size of validSizes) {
      const maxCombinations = approxCombinations(M, size)
      const samples = Math.min(samplesPerSize, maxCombinations)

      for (let n = 0; n < samples; n++) {
        const indices = pickDistinct(size, M)
        const group   = indices.map(idx => combos[idx])

        const comboData = group.map(combo => ({
          ...perPeriod[combo.emaPeriod],
          minWickPct: combo.minWickPct,
          slPct:      combo.slPct,
          tpPct:      combo.tpPct,
          effTp:      Math.max(combo.tpPct - feeTpPct, 0) * leverage,
          effSl:      (combo.slPct + feeSlPct) * leverage,
        }))

        const bt  = runGroupBacktest(comboData, N, closes, highs, lows, isNewDay, direction, initialCapital)
        const net = parseFloat(bt.totalNetPct)
        const dd  = parseFloat(bt.maxDrawdownPct)

        if (bt.totalClosed >= 3 && net > 0 && dd <= 50) {
          const score = net / Math.max(dd, 0.1)
          allResults.push({
            size,
            combos: indices.map(idx => ({ idx, ...combos[idx] })),
            ...bt,
            _score: score,
          })
        }

        done++
        if (done % REPORT_EVERY === 0) {
          const sorted = allResults.slice().sort((a, b) => b._score - a._score)
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
