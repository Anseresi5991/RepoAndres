import { useState, useEffect, useMemo, useRef } from 'react'
import { createChart, CandlestickSeries, createSeriesMarkers, LineStyle } from 'lightweight-charts'
import { runBacktest, runMultiBacktest } from './backtester.js'
import { runSARBacktest } from './backtesterSAR.js'
import { runSupertrendBacktest, runMultiSupertrendBacktest } from './backtesterSupertrend.js'
import { runConfluenceBacktest } from './backtesterConfluence.js'
import { runEmaPullbackBacktest } from './backtesterEmaPullback.js'
import { runPinBarBacktest } from './backtesterPinBar.js'
import { runSoporteBacktest, runMultiSoporteBacktest } from './backtesterSoporte.js'
import { runEmaTouchBacktest, runMultiEmaTouchBacktest } from './backtesterEma.js'
import { runBacktest as runRangeHighBacktest, runMultiBacktest as runMultiRangeHighBacktest } from './backtesterRangeHigh.js'
import * as XLSX from 'xlsx'
import './App.css'

const isOptimMode       = new URLSearchParams(window.location.search).get('mode') === 'optim'
const isMultiOptimMode  = new URLSearchParams(window.location.search).get('mode') === 'multioptim'
const isExcelOptimMode  = new URLSearchParams(window.location.search).get('mode') === 'exceloptim'
const isSarMode         = new URLSearchParams(window.location.search).get('strategy') === 'sar'
const isSarOptimMode         = isSarMode && new URLSearchParams(window.location.search).get('mode') === 'optim'
const isSupertrendMode       = new URLSearchParams(window.location.search).get('strategy') === 'supertrend'
const isSupertrendOptimMode      = isSupertrendMode && new URLSearchParams(window.location.search).get('mode') === 'optim'
const isSupertrendExcelOptimMode = isSupertrendMode && new URLSearchParams(window.location.search).get('mode') === 'exceloptim'
const isConfluenceMode       = new URLSearchParams(window.location.search).get('strategy') === 'confluence'
const isConfluenceOptimMode  = isConfluenceMode && new URLSearchParams(window.location.search).get('mode') === 'optim'
const isEmaPullbackMode      = new URLSearchParams(window.location.search).get('strategy') === 'emapullback'
const isEmaPullbackOptimMode = isEmaPullbackMode && new URLSearchParams(window.location.search).get('mode') === 'optim'
const isPinBarMode           = new URLSearchParams(window.location.search).get('strategy') === 'pinbar'
const isPinBarOptimMode      = isPinBarMode && new URLSearchParams(window.location.search).get('mode') === 'optim'
const isSoporteMode              = new URLSearchParams(window.location.search).get('strategy') === 'soporte'
const isSoporteOptimMode         = isSoporteMode && new URLSearchParams(window.location.search).get('mode') === 'optim'
const isSoporteExcelOptimMode    = isSoporteMode && new URLSearchParams(window.location.search).get('mode') === 'exceloptim'
const isPortfolioMode            = new URLSearchParams(window.location.search).get('mode') === 'portfolio'
const isEmaMode                  = new URLSearchParams(window.location.search).get('strategy') === 'ema'
const isEmaOptimMode             = isEmaMode && new URLSearchParams(window.location.search).get('mode') === 'optim'
const isEmaExcelOptimMode        = isEmaMode && new URLSearchParams(window.location.search).get('mode') === 'exceloptim'
const isRangeHighMode            = new URLSearchParams(window.location.search).get('strategy') === 'rangehigh'

// ── Helpers para paralelizar el Análisis Profundo en múltiples workers ──
function optRangeValues(min, max, step) {
  const s = parseFloat(step)
  const vals = []
  if (s <= 0) return [parseFloat(min)]
  for (let v = parseFloat(min); v <= parseFloat(max) + 1e-9; v += s)
    vals.push(parseFloat(v.toFixed(6)))
  return vals
}

function chunkArray(arr, n) {
  const total = arr.length
  const numChunks = Math.min(n, total)
  const chunks = []
  for (let i = 0; i < numChunks; i++) {
    const start = Math.floor(i * total / numChunks)
    const end   = Math.floor((i + 1) * total / numChunks)
    chunks.push(arr.slice(start, end))
  }
  return chunks
}

function mergeWorkerRankings(resultArrays) {
  const rangeMap = new Map()
  for (const results of resultArrays) {
    if (!results?.length) continue
    for (const c of results) {
      const key = `${c.minRangePct}|${c.maxRangePct}`
      if (!rangeMap.has(key)) rangeMap.set(key, [])
      const bucket = rangeMap.get(key)
      if (bucket.length < 5) {
        bucket.push(c); bucket.sort((a, b) => b._score - a._score)
      } else if (c._score > bucket[4]._score) {
        bucket[4] = c; bucket.sort((a, b) => b._score - a._score)
      }
    }
  }
  const all = []
  for (const b of rangeMap.values()) for (const c of b) all.push(c)
  return all.sort((a, b) => b._score - a._score)
}

function mergeEmaWorkerRankings(resultArrays) {
  const periodMap = new Map()
  for (const results of resultArrays) {
    if (!results?.length) continue
    for (const c of results) {
      const key = `${c.emaPeriod}`
      if (!periodMap.has(key)) periodMap.set(key, [])
      const bucket = periodMap.get(key)
      if (bucket.length < 5) {
        bucket.push(c); bucket.sort((a, b) => b._score - a._score)
      } else if (c._score > bucket[4]._score) {
        bucket[4] = c; bucket.sort((a, b) => b._score - a._score)
      }
    }
  }
  const all = []
  for (const b of periodMap.values()) for (const c of b) all.push(c)
  return all.sort((a, b) => b._score - a._score)
}

const DEFAULT_EMA_TOUCH_PARAMS = {
  emaPeriod:          20,
  slowEmaPeriod:      200,
  emaSlopeLookback:   5,
  emaConsistencyBars: 3,
  maxBodyPct:         50,
  atrPeriod:          14,
  atrMaPeriod:        20,
  atrMaxMultiplier:   1.5,
  rsiPeriod:          14,
  rsiShortMax:        65,
  rsiLongMin:         35,
  minCrossBodyPct:    30,
  minWickPct:     15.0,
  slPct:          0.5,
  tpPct:          0.15,
  feeSlPct:       0.10,
  feeTpPct:       0.05,
  leverage:       10,
  initialCapital: 1000,
  monthlyContribution: 0,
  direction:      'BOTH',
  dateFrom:       '2022-01-01',
  dateTo:         new Date().toISOString().split('T')[0],
}

const DEFAULT_EMA_TOUCH_OPTIM = {
  emaPeriod:  { min: 5,   max: 200, step: 5   },
  minWickPct: { min: 5,   max: 40,  step: 5   },
  slPct:      { min: 0.3, max: 1.0, step: 0.2 },
  tpPct:      { min: 0.1, max: 0.5, step: 0.1 },
}

function countEmaTouchCombinations(optimRanges) {
  return ['emaPeriod', 'minWickPct', 'slPct', 'tpPct']
    .reduce((acc, k) => acc * rangeValues(optimRanges[k].min, optimRanges[k].max, optimRanges[k].step).length, 1)
}

const DEFAULT_PARAMS = {
  minRangePct: 0.6,
  maxRangePct: 1.2,
  lookbackCandles: 20,
  minWickPct: 15.0,
  slPct: 0.5,
  tpPct: 0.15,
  feeSlPct: 0.10,
  feeTpPct: 0.05,
  leverage: 10,
  initialCapital: 1000,
  monthlyContribution: 0,
  emaMinGapPct: 0,
  res1: 0,
  res2: 0,
  res3: 0,
  dateFrom: '2022-01-01',
  dateTo: new Date().toISOString().split('T')[0],
}

const DEFAULT_OPTIM = {
  minRangePct:     { min: 0.3, max: 1.5, step: 0.3 },
  maxRangePct:     { min: 0.8, max: 2.0, step: 0.3 },
  lookbackCandles: { min: 10,  max: 30,  step: 5   },
  minWickPct:      { min: 10,  max: 30,  step: 5   },
  slPct:           { min: 0.3, max: 1.0, step: 0.2 },
  tpPct:           { min: 0.05,max: 0.5, step: 0.1 },
}

const DEFAULT_SUPERTREND_PARAMS = {
  atrPeriod:          10,
  atrMultiplier:      3.0,
  tpPct:              0.8,
  slPct:              0.5,
  feeTpPct:           0.05,
  feeSlPct:           0.10,
  leverage:           10,
  initialCapital:     1000,
  useTrendFilter:     false,
  pivotLr:            2,
  tradeDirection:     'both',
  skipSundays:        true,
  emaFilterPeriod:    0,
  maxConsecLosses:    0,
  consecCooldownBars: 20,
  adxPeriod:          14,
  adxMinimum:         0,
  slopeEmaPeriod:     0,
  slopeLookback:      3,
  atrVolFilter:       0,
  atrVolPeriod:       20,
  rsiPeriod:          14,
  rsiThreshold:       0,
  bodyRatioMin:       0,
  dateFrom:           '2022-01-01',
  dateTo:             new Date().toISOString().split('T')[0],
}

const DEFAULT_SUPERTREND_OPTIM = {
  atrPeriod:     { min: 5,   max: 20,  step: 3   },
  atrMultiplier: { min: 1.0, max: 4.0, step: 0.5 },
  tpPct:         { min: 0.3, max: 1.5, step: 0.3 },
  slPct:         { min: 0.2, max: 1.0, step: 0.2 },
  atrVolFilter:  { min: 0,   max: 2.0, step: 0.5 },
  rsiThreshold:  { min: 0,   max: 70,  step: 35  },
  bodyRatioMin:  { min: 0,   max: 0.4, step: 0.2 },
  maxDdFilter:   20,
  topN:          500,
}

const DEFAULT_SUPERTREND_MULTI_COMBOS = [
  { atrPeriod:  8, atrMultiplier:  6.0, atrVolFilter: 1.5, rsiThreshold:  0, bodyRatioMin: 1.0, tpPct: 2.45, slPct: 2.6 },
  { atrPeriod: 11, atrMultiplier:  5.0, atrVolFilter: 2.0, rsiThreshold:  0, bodyRatioMin: 1.0, tpPct: 1.25, slPct: 2.9 },
  { atrPeriod: 14, atrMultiplier:  6.5, atrVolFilter: 1.0, rsiThreshold: 70, bodyRatioMin: 0.9, tpPct: 1.05, slPct: 2.9 },
  { atrPeriod:  8, atrMultiplier:  3.5, atrVolFilter: 1.0, rsiThreshold: 60, bodyRatioMin: 0.8, tpPct: 0.45, slPct: 2.9 },
  { atrPeriod: 17, atrMultiplier:  2.5, atrVolFilter: 0.0, rsiThreshold: 55, bodyRatioMin: 1.0, tpPct: 2.25, slPct: 2.1 },
  { atrPeriod: 14, atrMultiplier:  3.5, atrVolFilter: 0.0, rsiThreshold: 50, bodyRatioMin: 0.8, tpPct: 2.95, slPct: 2.7 },
  { atrPeriod:  8, atrMultiplier:  6.0, atrVolFilter: 1.0, rsiThreshold: 65, bodyRatioMin: 0.1, tpPct: 0.35, slPct: 2.4 },
  { atrPeriod: 11, atrMultiplier:  1.0, atrVolFilter: 2.0, rsiThreshold: 25, bodyRatioMin: 0.3, tpPct: 1.05, slPct: 2.4 },
  { atrPeriod:  8, atrMultiplier:  9.5, atrVolFilter: 1.0, rsiThreshold:  0, bodyRatioMin: 0.8, tpPct: 0.75, slPct: 2.8 },
  { atrPeriod:  5, atrMultiplier:  6.5, atrVolFilter: 0.0, rsiThreshold:  0, bodyRatioMin: 1.0, tpPct: 2.65, slPct: 1.9 },
  { atrPeriod: 14, atrMultiplier:  3.5, atrVolFilter: 0.0, rsiThreshold: 50, bodyRatioMin: 0.8, tpPct: 3.35, slPct: 2.9 },
  { atrPeriod: 11, atrMultiplier:  1.5, atrVolFilter: 2.0, rsiThreshold: 30, bodyRatioMin: 0.0, tpPct: 1.65, slPct: 2.2 },
  { atrPeriod: 14, atrMultiplier:  6.5, atrVolFilter: 1.0, rsiThreshold:  0, bodyRatioMin: 0.9, tpPct: 0.75, slPct: 2.9 },
  { atrPeriod: 11, atrMultiplier:  7.5, atrVolFilter: 1.0, rsiThreshold: 70, bodyRatioMin: 0.8, tpPct: 0.75, slPct: 2.4 },
  { atrPeriod:  5, atrMultiplier:  7.0, atrVolFilter: 1.0, rsiThreshold: 65, bodyRatioMin: 0.8, tpPct: 1.35, slPct: 2.8 },
]

const DEFAULT_CONFLUENCE_PARAMS = {
  emaFast:             21,
  emaSlow:             55,
  rsiPeriod:           14,
  rsiOverbought:       65,
  rsiOversold:         35,
  macdFast:            12,
  macdSlow:            26,
  macdSignalPeriod:    9,
  bbPeriod:            20,
  bbStdDev:            2.0,
  volMAPeriod:         20,
  volMultiplier:       1.5,
  confluencesRequired: 3,
  tpPct:               3.0,
  slPct:               1.5,
  feeTpPct:            0.05,
  feeSlPct:            0.10,
  leverage:            1,
  initialCapital:      1000,
  tradeDirection:      'both',
  dateFrom:            '2022-01-01',
  dateTo:              new Date().toISOString().split('T')[0],
}

const DEFAULT_CONFLUENCE_OPTIM = {
  tpPct:               { min: 1.0, max: 8.0, step: 1.0 },
  slPct:               { min: 0.5, max: 3.0, step: 0.5 },
  confluencesRequired: { min: 2,   max: 5,   step: 1   },
  rsiOverbought:       { min: 60,  max: 75,  step: 5   },
}

const DEFAULT_EMA_PULLBACK_PARAMS = {
  emaFast:         21,
  emaSlow:         55,
  rsiPeriod:       14,
  rsiMin:          30,
  rsiMax:          70,
  volMAPeriod:     20,
  volMultiplier:   1.0,
  useVolumeFilter: false,
  tpPct:           1.5,
  slPct:           0.8,
  feeTpPct:        0.05,
  feeSlPct:        0.10,
  leverage:        1,
  initialCapital:  1000,
  tradeDirection:  'both',
  dateFrom:        '2022-01-01',
  dateTo:          new Date().toISOString().split('T')[0],
}

const DEFAULT_EMA_PULLBACK_OPTIM = {
  emaFast: { min: 8,   max: 34,  step: 4   },
  rsiMin:  { min: 30,  max: 50,  step: 5   },
  tpPct:   { min: 0.5, max: 4.0, step: 0.5 },
  slPct:   { min: 0.3, max: 2.0, step: 0.3 },
}

const DEFAULT_PINBAR_PARAMS = {
  maxBodyPct:          0.5,
  minWickPct:          100,
  tpPct:               1.5,
  slPct:               0.8,
  feeTpPct:            0.05,
  feeSlPct:            0.10,
  leverage:            1,
  initialCapital:      1000,
  monthlyContribution: 0,
  tradeDirection:      'both',
  dateFrom:            '2022-01-01',
  dateTo:              new Date().toISOString().split('T')[0],
}

const DEFAULT_PINBAR_OPTIM = {
  maxBodyPct: { min: 0.1, max: 1.5,  step: 0.2  },
  minWickPct: { min: 50,  max: 300,  step: 50   },
  tpPct:      { min: 0.5, max: 4.0,  step: 0.5  },
  slPct:      { min: 0.3, max: 2.0,  step: 0.3  },
}

function countPinBarCombinations(optimRanges) {
  return ['maxBodyPct','minWickPct','tpPct','slPct']
    .reduce((acc, k) => acc * rangeValues(optimRanges[k].min, optimRanges[k].max, optimRanges[k].step).length, 1)
}

const DEFAULT_SOPORTE_PARAMS = {
  minRangePct:         0.6,
  maxRangePct:         1.2,
  lookbackCandles:     20,
  minWickPct:          15.0,
  slPct:               0.5,
  tpPct:               0.15,
  feeSlPct:            0.10,
  feeTpPct:            0.05,
  leverage:            10,
  initialCapital:      1000,
  monthlyContribution: 0,
  emaMinGapPct:        0,
  dateFrom:            '2022-01-01',
  dateTo:              new Date().toISOString().split('T')[0],
}

const DEFAULT_RANGE_HIGH_PARAMS = {
  minRangePct:         0.6,
  maxRangePct:         1.2,
  lookbackCandles:     20,
  minWickPct:          15.0,
  slBufferPct:         0.05,
  tpPct:               1.0,
  feeSlPct:            0.10,
  feeTpPct:            0.05,
  leverage:            10,
  initialCapital:      1000,
  monthlyContribution: 0,
  dateFrom:            '2022-01-01',
  dateTo:              new Date().toISOString().split('T')[0],
}

const DEFAULT_RANGE_HIGH_MULTI_COMBOS = [
  { label: 'Combo 1', minRangePct: 0.6, maxRangePct: 1.2, lookbackCandles: 20, minWickPct: 15.0, slBufferPct: 0.05, tpPct: 1.0 },
]

const DEFAULT_SOPORTE_OPTIM = {
  minRangePct:     { min: 0.3, max: 1.5, step: 0.3 },
  maxRangePct:     { min: 0.8, max: 2.0, step: 0.3 },
  lookbackCandles: { min: 10,  max: 30,  step: 5   },
  minWickPct:      { min: 10,  max: 30,  step: 5   },
  slPct:           { min: 0.3, max: 1.0, step: 0.2 },
  tpPct:           { min: 0.05,max: 0.5, step: 0.1 },
}

function countSoporteCombinations(optimRanges) {
  return ['minRangePct','maxRangePct','lookbackCandles','minWickPct','slPct','tpPct']
    .reduce((acc, k) => acc * rangeValues(optimRanges[k].min, optimRanges[k].max, optimRanges[k].step).length, 1)
}

function countEmaPullbackCombinations(optimRanges) {
  return ['emaFast','rsiMin','tpPct','slPct']
    .reduce((acc, k) => acc * rangeValues(optimRanges[k].min, optimRanges[k].max, optimRanges[k].step).length, 1)
}

function countConfluenceCombinations(optimRanges) {
  return ['tpPct','slPct','confluencesRequired','rsiOverbought']
    .reduce((acc, k) => acc * rangeValues(optimRanges[k].min, optimRanges[k].max, optimRanges[k].step).length, 1)
}

function countSupertrendCombinations(optimRanges) {
  return ['atrPeriod','atrMultiplier','tpPct','slPct','atrVolFilter','rsiThreshold','bodyRatioMin']
    .reduce((acc, k) => acc * rangeValues(optimRanges[k].min, optimRanges[k].max, optimRanges[k].step).length, 1)
}

const DEFAULT_SAR_OPTIM = {
  tpPct:    { min: 0.3,  max: 1.5,  step: 0.2  },
  slPct:    { min: 0.2,  max: 1.0,  step: 0.2  },
  sarStart: { min: 0.01, max: 0.04, step: 0.01 },
  sarInc:   { min: 0.01, max: 0.04, step: 0.01 },
  sarMax:   { min: 0.1,  max: 0.3,  step: 0.1  },
  pivotLr:  { min: 1,    max: 4,    step: 1    },
}

function countSARCombinations(optimRanges) {
  return ['tpPct','slPct','sarStart','sarInc','sarMax','pivotLr']
    .reduce((acc, k) => acc * rangeValues(optimRanges[k].min, optimRanges[k].max, optimRanges[k].step).length, 1)
}

const DEFAULT_SAR_PARAMS = {
  sarStart:       0.02,
  sarInc:         0.02,
  sarMax:         0.2,
  pivotLr:        2,
  tpPct:          0.8,
  slPct:          0.5,
  feeTpPct:       0.05,
  feeSlPct:       0.10,
  leverage:       10,
  initialCapital: 1000,
  useTrendFilter: true,
  skipSundays:    true,
  dateFrom:       '2022-01-01',
  dateTo:         new Date().toISOString().split('T')[0],
}

const DEFAULT_MULTI_COMBOS = [
  { label: 'Combo 1', minRangePct: 0.6, maxRangePct: 1.2, lookbackCandles: 20, minWickPct: 15, slPct: 0.5, tpPct: 0.15 },
  { label: 'Combo 2', minRangePct: 0.6, maxRangePct: 1.2, lookbackCandles: 20, minWickPct: 15, slPct: 0.5, tpPct: 0.15 },
]

const DEFAULT_SOPORTE_MULTI_COMBOS = [
  { label: 'Combo 1', minRangePct: 0.6, maxRangePct: 1.2, lookbackCandles: 20, minWickPct: 15, slPct: 0.5, tpPct: 0.15 },
  { label: 'Combo 2', minRangePct: 0.6, maxRangePct: 1.2, lookbackCandles: 20, minWickPct: 15, slPct: 0.5, tpPct: 0.15 },
]

const DEFAULT_EMA_TOUCH_MULTI_COMBOS = [
  { label: 'Combo 1', emaPeriod: 20, minWickPct: 15, slPct: 0.5, tpPct: 0.15 },
  { label: 'Combo 2', emaPeriod: 50, minWickPct: 15, slPct: 0.5, tpPct: 0.15 },
]

function rangeValues(min, max, step) {
  const vals = []
  const s = parseFloat(step)
  if (s <= 0) return [parseFloat(min)]
  for (let v = parseFloat(min); v <= parseFloat(max) + 1e-9; v += s) {
    vals.push(parseFloat(v.toFixed(6)))
  }
  return vals
}

function formatEta(ms) {
  if (ms < 60000) return `~${Math.round(ms / 1000)}s`
  const m = Math.floor(ms / 60000)
  const s = Math.round((ms % 60000) / 1000)
  return s > 0 ? `~${m}m ${s}s` : `~${m}m`
}

function countCombinations(optimRanges) {
  return ['minRangePct','maxRangePct','lookbackCandles','minWickPct','slPct','tpPct']
    .reduce((acc, k) => acc * rangeValues(optimRanges[k].min, optimRanges[k].max, optimRanges[k].step).length, 1)
}

function InputGroup({ label, tooltip, children }) {
  return (
    <div className="input-group">
      <label title={tooltip}>{label}{tooltip && <span className="tip">?</span>}</label>
      {children}
    </div>
  )
}

function Section({ title, children }) {
  return (
    <div className="section">
      <div className="section-title">{title}</div>
      {children}
    </div>
  )
}

function computePeriodStats(trades, defaultEffTp, defaultEffSl) {
  const years = {}
  const months = {}
  for (const t of trades) {
    const yr = t.closeTime.substring(0, 4)
    const mo = t.closeTime.substring(0, 7)
    const effTp = t.effectiveTpPct != null ? t.effectiveTpPct : defaultEffTp
    const effSl = t.effectiveSlPct != null ? t.effectiveSlPct : defaultEffSl
    for (const [key, map] of [[yr, years], [mo, months]]) {
      if (!map[key]) map[key] = { tp: 0, sl: 0, netPct: 0 }
      if (t.result === 'TP') { map[key].tp++; map[key].netPct += effTp }
      else { map[key].sl++; map[key].netPct -= effSl }
    }
  }
  const combos = {}
  for (const t of trades) {
    const key = t.comboLabel || 'Combo 1'
    const effTp = t.effectiveTpPct != null ? t.effectiveTpPct : defaultEffTp
    const effSl = t.effectiveSlPct != null ? t.effectiveSlPct : defaultEffSl
    if (!combos[key]) combos[key] = { tp: 0, sl: 0, netPct: 0 }
    if (t.result === 'TP') { combos[key].tp++; combos[key].netPct += effTp }
    else { combos[key].sl++; combos[key].netPct -= effSl }
  }
  const toArr = (map, sort = true) => {
    const entries = Object.entries(map)
    if (sort) entries.sort(([a], [b]) => a.localeCompare(b))
    return entries.map(([period, d]) => ({
      period,
      tp: d.tp, sl: d.sl, total: d.tp + d.sl,
      winRate: d.tp + d.sl > 0 ? (d.tp / (d.tp + d.sl) * 100).toFixed(1) : '0.0',
      netPct: d.netPct.toFixed(2),
    }))
  }
  return { byYear: toArr(years), byMonth: toArr(months), byCombo: toArr(combos, false) }
}

function PeriodTable({ title, rows }) {
  return (
    <div className="mae-section">
      <div className="mae-title">{title}</div>
      <div className="table-wrap" style={{marginTop: 8}}>
        <table className="data-table">
          <thead>
            <tr><th>Período</th><th>TP ✅</th><th>SL ❌</th><th>Trades</th><th>Win%</th><th>Neto%</th></tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.period} className={parseFloat(r.netPct) >= 0 ? 'row-win' : 'row-loss'}>
                <td style={{fontFamily:'var(--font-mono)', fontWeight:600}}>{r.period}</td>
                <td>{r.tp}</td>
                <td>{r.sl}</td>
                <td>{r.total}</td>
                <td>{r.winRate}%</td>
                <td className={parseFloat(r.netPct) >= 0 ? 'tp-cell' : 'sl-cell'}>{r.netPct}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function StatCard({ label, value, variant = 'default' }) {
  return (
    <div className={`stat-card stat-${variant}`}>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
    </div>
  )
}

function OptimRow({ label, field, stepHint, ranges, onChange }) {
  const set = (key, val) => onChange(field, key, val)
  return (
    <div className="optim-row">
      <span className="optim-label">{label}</span>
      <input type="number" step={stepHint} value={ranges[field].min}  onChange={e => set('min',  e.target.value)} placeholder="Min" />
      <input type="number" step={stepHint} value={ranges[field].max}  onChange={e => set('max',  e.target.value)} placeholder="Max" />
      <input type="number" step={stepHint} value={ranges[field].step} onChange={e => set('step', e.target.value)} placeholder="Paso" />
    </div>
  )
}

function TradeModal({ trade, candles, onClose }) {
  const chartRef = useRef(null)

  useEffect(() => {
    if (!chartRef.current) return

    // Encontrar índices de entrada y cierre en el array de velas
    const entryMs  = new Date(trade.time).getTime()
    const closeMs  = new Date(trade.closeTime).getTime()
    const entryIdx = candles.findIndex(c => new Date(c.OpenTime).getTime() >= entryMs)
    const closeIdx = candles.findIndex(c => new Date(c.OpenTime).getTime() >= closeMs)
    const start = Math.max(0, (entryIdx === -1 ? 0 : entryIdx) - 5)
    const end   = Math.min(candles.length - 1, (closeIdx === -1 ? candles.length - 1 : closeIdx) + 5)
    const slice = candles.slice(start, end + 1)

    const chart = createChart(chartRef.current, {
      width:  chartRef.current.clientWidth,
      height: 420,
      layout: { background: { color: '#0f172a' }, textColor: '#94a3b8' },
      grid:   { vertLines: { color: '#1e293b' }, horzLines: { color: '#1e293b' } },
      crosshair: { mode: 1 },
      rightPriceScale: { borderColor: '#1e293b' },
      timeScale: { borderColor: '#1e293b', timeVisible: true, secondsVisible: false },
    })

    const series = chart.addSeries(CandlestickSeries, {
      upColor: '#22c55e', downColor: '#ef4444',
      borderUpColor: '#22c55e', borderDownColor: '#ef4444',
      wickUpColor: '#22c55e', wickDownColor: '#ef4444',
    })

    series.setData(slice.map(c => ({
      time:  Math.floor(new Date(c.OpenTime).getTime() / 1000),
      open:  parseFloat(c.OpenCandle),
      high:  parseFloat(c.HighCandle),
      low:   parseFloat(c.LowCandle),
      close: parseFloat(c.CloseCandle),
    })))

    // Líneas horizontales de referencia
    series.createPriceLine({ price: trade.price, color: '#60a5fa', lineWidth: 2, lineStyle: LineStyle.Solid,  axisLabelVisible: true, title: 'Entrada' })
    series.createPriceLine({ price: trade.tp,    color: '#22c55e', lineWidth: 2, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: 'TP' })
    series.createPriceLine({ price: trade.sl,    color: '#ef4444', lineWidth: 2, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: 'SL' })

    // Marcadores de entrada y cierre
    const entrySec = Math.floor(entryMs / 1000)
    const closeSec = Math.floor(closeMs / 1000)
    createSeriesMarkers(series, [
      { time: entrySec, position: 'aboveBar', color: '#60a5fa', shape: 'arrowDown', text: 'Short' },
      { time: closeSec, position: trade.result === 'TP' ? 'belowBar' : 'aboveBar',
        color: trade.result === 'TP' ? '#22c55e' : '#ef4444',
        shape: 'circle', text: trade.result },
    ])

    chart.timeScale().fitContent()

    const ro = new ResizeObserver(() => {
      if (chartRef.current) chart.applyOptions({ width: chartRef.current.clientWidth })
    })
    ro.observe(chartRef.current)

    return () => { chart.remove(); ro.disconnect() }
  }, [trade, candles])

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <div className="modal-title">
            <span className={`badge badge-${trade.result.toLowerCase()}`}>{trade.result === 'TP' ? '✅ TP' : '❌ SL'}</span>
            <span>Entrada: {new Date(trade.time).toLocaleString('es-CO', { timeZone: 'UTC' })}</span>
            <span>·</span>
            <span>Cierre: {new Date(trade.closeTime).toLocaleString('es-CO', { timeZone: 'UTC' })}</span>
          </div>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="modal-prices">
          <span style={{color:'#60a5fa'}}>Entrada ${parseFloat(trade.price).toLocaleString('en-US')}</span>
          <span style={{color:'#22c55e'}}>TP ${parseFloat(trade.tp).toLocaleString('en-US')}</span>
          <span style={{color:'#ef4444'}}>SL ${parseFloat(trade.sl).toLocaleString('en-US')}</span>
          <span style={{color:'#94a3b8'}}>Capital entrada ${parseFloat(trade.capitalAtEntry).toLocaleString('es-CO', {minimumFractionDigits:2, maximumFractionDigits:2})}</span>
          <span style={{color: trade.result === 'TP' ? '#22c55e' : '#ef4444'}}>Capital salida ${parseFloat(trade.capitalAtExit).toLocaleString('es-CO', {minimumFractionDigits:2, maximumFractionDigits:2})}</span>
        </div>
        <div ref={chartRef} style={{width: '100%'}} />
      </div>
    </div>
  )
}

function OptimView() {
  const [status, setStatus] = useState('waiting')
  const [progress, setProgress] = useState(null)
  const [ranking, setRanking] = useState([])
  const [errorMsg, setErrorMsg] = useState('')
  const startTimeRef = useRef(null)
  const bcRef = useRef(null)
  const multiOptimBcRef = useRef(null)
  const initDataRef = useRef(null) // guarda { candles, params } para multi-optim

  useEffect(() => {
    const bc = new BroadcastChannel('btc-optim')
    bcRef.current = bc

    const sendReady = () => bc.postMessage({ type: 'ready' })
    sendReady()
    const retryTimer = setTimeout(sendReady, 1500)

    bc.onmessage = (e) => {
      const msg = e.data
      if (msg.type === 'init') {
        clearTimeout(retryTimer)
        const { candles, optimRanges, params } = msg
        initDataRef.current = { candles, params }
        setStatus('running')
        startTimeRef.current = Date.now()

        const allLb = optRangeValues(
          optimRanges.lookbackCandles.min,
          optimRanges.lookbackCandles.max,
          optimRanges.lookbackCandles.step
        ).map(v => Math.round(v))
        const chunks = chunkArray(allLb, Math.min(navigator.hardwareConcurrency || 4, allLb.length))
        const numWorkers = chunks.length

        const wpDone    = new Array(numWorkers).fill(0)
        const wpTotal   = new Array(numWorkers).fill(0)
        const wpResults = new Array(numWorkers).fill(null)
        let doneCount = 0
        const workersArr = []

        chunks.forEach((subset, wi) => {
          const w = new Worker(new URL('./optimWorker.js', import.meta.url), { type: 'module' })
          w.onmessage = (ev) => {
            const m = ev.data
            if (m.type === 'progress') {
              wpDone[wi] = m.done
              wpTotal[wi] = m.total
              if (m.topResults?.length) wpResults[wi] = m.topResults
              const totalDone = wpDone.reduce((s, v) => s + v, 0)
              const totalAll  = wpTotal.reduce((s, v) => s + v, 0)
              const elapsed = Date.now() - startTimeRef.current
              const eta = (totalDone >= 100 && elapsed >= 500)
                ? Math.round((totalAll - totalDone) / (totalDone / elapsed)) : null
              setProgress({ done: totalDone, total: totalAll, eta })
              const merged = mergeWorkerRankings(wpResults)
              if (merged.length) setRanking(merged)
            } else if (m.type === 'done') {
              wpDone[wi] = wpTotal[wi]
              wpResults[wi] = m.results ?? []
              doneCount++
              w.terminate()
              if (doneCount === numWorkers) {
                setStatus('done')
                setProgress(p => p ? { ...p, done: p.total } : null)
                setRanking(mergeWorkerRankings(wpResults))
              }
            } else if (m.type === 'error') {
              setErrorMsg(m.message); setStatus('error')
              workersArr.forEach(wk => wk.terminate())
            }
          }
          w.onerror = (ev) => {
            setErrorMsg(ev.message); setStatus('error')
            workersArr.forEach(wk => wk.terminate())
          }
          w.postMessage({ candles, optimRanges, params, lookbackSubset: subset })
          workersArr.push(w)
        })
      }
    }

    return () => { clearTimeout(retryTimer); bc.close(); multiOptimBcRef.current?.close() }
  }, [])

  function handleOpenMultiOptim() {
    const { candles, params } = initDataRef.current || {}
    if (!candles || ranking.length < 2) return

    multiOptimBcRef.current?.close()
    const bc = new BroadcastChannel('btc-multioptim')
    multiOptimBcRef.current = bc

    bc.onmessage = (e) => {
      if (e.data.type === 'ready') {
        bc.postMessage({ type: 'init', topCombos: ranking, candles, params })
      }
    }

    window.open(window.location.pathname + '?mode=multioptim', '_blank')
  }

  function applyParams(row) {
    bcRef.current?.postMessage({ type: 'apply', row })
  }

  function handleExportExcel() {
    const rows = ranking.map((r, i) => ({
      '#':          i + 1,
      'Score':      parseFloat(r._score?.toFixed(4)),
      'Min%':       r.minRangePct,
      'Max%':       r.maxRangePct,
      'LB':         r.lookbackCandles,
      'Mecha%':     r.minWickPct,
      'SL%':        r.slPct,
      'TP%':        r.tpPct,
      'Trades':     r.totalClosed,
      'Win%':       r.winRate,
      'Neto%':      r.totalNetPct,
      'Drawdown%':  r.maxDrawdownPct,
      'Capital$':   parseFloat(r.compoundCapital),
    }))
    const ws = XLSX.utils.json_to_sheet(rows)
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Análisis Profundo')
    XLSX.writeFile(wb, 'analisis_profundo.xlsx')
  }

  const pct = progress ? Math.round(progress.done / progress.total * 100) : 0

  return (
    <div className="optim-page">
      <header className="optim-page-header">
        <div className="logo">
          <span className="logo-icon">₿</span>
          <div>
            <div className="logo-title">MariaPaz<span style={{color:'var(--accent)'}}>Indicator</span></div>
            <div className="logo-sub">🔬 Análisis Profundo · Ranking en vivo</div>
          </div>
        </div>
        <div className="optim-page-status">
          {status === 'waiting' && 'Esperando datos de la pestaña principal...'}
          {status === 'running' && progress && (
            <span>
              {progress.done.toLocaleString()} / {progress.total.toLocaleString()} · {pct}%
              {progress.eta != null && ` · faltan ${formatEta(progress.eta)}`}
              {' · '}{ranking.length} en ranking
            </span>
          )}
          {status === 'done' && <span style={{color:'var(--green)'}}>✅ Completado · {ranking.length} en ranking</span>}
          {status === 'error' && <span style={{color:'var(--red)'}}>⚠️ {errorMsg}</span>}
        </div>
      </header>

      {progress && (
        <div className="optim-page-progress">
          <div className="progress-track" style={{borderRadius:0, height:3}}>
            <div className="progress-fill" style={{width:`${pct}%`, transition:'width 0.5s ease'}} />
          </div>
        </div>
      )}

      <div className="optim-page-body">
        {status === 'waiting' && (
          <div className="optim-page-waiting">
            <div className="loading-ring" />
            <div>Esperando datos del análisis profundo...</div>
            <div style={{fontSize:12}}>Haz clic en "🔬 Abrir Análisis Profundo" en la pestaña principal</div>
          </div>
        )}

        {status === 'done' && ranking.length >= 2 && (
          <div style={{padding:'12px 16px 0'}}>
            <button
              className="run-btn optim-btn"
              style={{width:'100%', marginBottom:4}}
              onClick={handleOpenMultiOptim}
            >
              🎲 Análisis Múltiple entre los {ranking.length} mejores
            </button>
            <div style={{fontSize:11, color:'var(--text-muted)', textAlign:'center', marginBottom:8}}>
              Evalúa grupos aleatorios de 2 y 3 combos — busca las 60 mejores combinaciones que conviven
            </div>
            <button
              className="run-btn optim-btn"
              style={{width:'100%', marginBottom:8, background:'var(--green)', color:'#000'}}
              onClick={handleExportExcel}
            >
              📥 Exportar ranking a Excel (para Multi-Combo)
            </button>
          </div>
        )}

        {ranking.length > 0 && (
          <>
            <div className="optim-rank-meta">
              Ranking por Score = Neto% ÷ Drawdown% · filtro: drawdown ≤ 50% · top 200
              {status === 'running' && ' · actualizando en vivo...'}
            </div>
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Score</th>
                    <th>Min%</th><th>Max%</th><th>LB</th><th>Mecha%</th><th>SL%</th><th>TP%</th>
                    <th>Trades</th><th>Win%</th><th>Neto%</th><th>Drawdown%</th><th>Capital $</th>
                    <th>Aplicar</th>
                  </tr>
                </thead>
                <tbody>
                  {ranking.map((r, i) => (
                    <tr key={i} className="row-win">
                      <td>{i + 1}</td>
                      <td style={{color:'var(--accent)', fontWeight:600}}>{r._score?.toFixed(2)}</td>
                      <td>{r.minRangePct}</td>
                      <td>{r.maxRangePct}</td>
                      <td>{r.lookbackCandles}</td>
                      <td>{r.minWickPct}</td>
                      <td>{r.slPct}</td>
                      <td>{r.tpPct}</td>
                      <td>{r.totalClosed}</td>
                      <td>{r.winRate}%</td>
                      <td className="tp-cell">{r.totalNetPct}%</td>
                      <td className={parseFloat(r.maxDrawdownPct) > 30 ? 'sl-cell' : ''}>{r.maxDrawdownPct}%</td>
                      <td>${parseFloat(r.compoundCapital).toLocaleString('es-CO', {minimumFractionDigits:2})}</td>
                      <td><button className="apply-btn" onClick={() => applyParams(r)} title="Aplicar en pestaña principal">▶</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function MultiOptimView() {
  const [status, setStatus] = useState('waiting')
  const [progress, setProgress] = useState(null)
  const [ranking, setRanking] = useState([])
  const [errorMsg, setErrorMsg] = useState('')
  const startTimeRef = useRef(null)

  useEffect(() => {
    const bc = new BroadcastChannel('btc-multioptim')

    const sendReady = () => bc.postMessage({ type: 'ready' })
    sendReady()
    const retryTimer = setTimeout(sendReady, 1500)

    bc.onmessage = (e) => {
      const msg = e.data
      if (msg.type === 'init') {
        clearTimeout(retryTimer)
        const { topCombos, candles, params } = msg
        setStatus('running')
        startTimeRef.current = Date.now()

        const worker = new Worker(new URL('./multiOptimWorker.js', import.meta.url), { type: 'module' })
        worker.onmessage = (ev) => {
          const m = ev.data
          if (m.type === 'progress') {
            const elapsed = Date.now() - startTimeRef.current
            let eta = null
            if (m.done >= 50 && elapsed >= 500) {
              eta = Math.round((m.total - m.done) / (m.done / elapsed))
            }
            setProgress({ done: m.done, total: m.total, eta })
            if (m.topResults?.length > 0) setRanking(m.topResults)
          } else if (m.type === 'done') {
            setStatus('done')
            setProgress(p => p ? { ...p, done: p.total } : null)
            if (m.results?.length > 0) setRanking(m.results)
            worker.terminate()
          } else if (m.type === 'error') {
            setErrorMsg(m.message)
            setStatus('error')
            worker.terminate()
          }
        }
        worker.onerror = (ev) => { setErrorMsg(ev.message); setStatus('error'); worker.terminate() }
        worker.postMessage({ topCombos, candles, params })
      }
    }

    return () => { clearTimeout(retryTimer); bc.close() }
  }, [])

  const pct = progress ? Math.round(progress.done / progress.total * 100) : 0

  return (
    <div className="optim-page">
      <header className="optim-page-header">
        <div className="logo">
          <span className="logo-icon">₿</span>
          <div>
            <div className="logo-title">MariaPaz<span style={{color:'var(--accent)'}}>Indicator</span></div>
            <div className="logo-sub">🎲 Análisis Múltiple · Top 60 grupos</div>
          </div>
        </div>
        <div className="optim-page-status">
          {status === 'waiting' && 'Esperando datos del Análisis Profundo...'}
          {status === 'running' && progress && (
            <span>
              {progress.done.toLocaleString()} / {progress.total.toLocaleString()} · {pct}%
              {progress.eta != null && ` · faltan ${formatEta(progress.eta)}`}
              {' · '}{ranking.length} en ranking
            </span>
          )}
          {status === 'done' && <span style={{color:'var(--green)'}}>✅ Completado · {ranking.length} grupos encontrados</span>}
          {status === 'error' && <span style={{color:'var(--red)'}}>⚠️ {errorMsg}</span>}
        </div>
      </header>

      {progress && (
        <div className="optim-page-progress">
          <div className="progress-track" style={{borderRadius:0, height:3}}>
            <div className="progress-fill" style={{width:`${pct}%`, transition:'width 0.5s ease'}} />
          </div>
        </div>
      )}

      <div className="optim-page-body">
        {status === 'waiting' && (
          <div className="optim-page-waiting">
            <div className="loading-ring" />
            <div>Esperando datos del Análisis Profundo...</div>
            <div style={{fontSize:12}}>Haz clic en "🎲 Análisis Múltiple" desde la ventana del Análisis Profundo</div>
          </div>
        )}

        {ranking.length > 0 && (
          <>
            <div className="optim-rank-meta">
              Grupos de 2 y 3 combos · Score = Neto% ÷ Drawdown% · drawdown ≤ 50% · top 60
              {status === 'running' && ' · actualizando en vivo...'}
            </div>
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Score</th>
                    <th>Combos</th>
                    <th>Combo 1</th>
                    <th>Combo 2</th>
                    <th>Combo 3</th>
                    <th>Trades</th><th>Win%</th><th>Neto%</th><th>Drawdown%</th><th>Capital $</th>
                  </tr>
                </thead>
                <tbody>
                  {ranking.map((r, i) => {
                    function comboLabel(c) {
                      return `Min${c.minRangePct} Max${c.maxRangePct} LB${c.lookbackCandles} W${c.minWickPct} SL${c.slPct} TP${c.tpPct}`
                    }
                    return (
                      <tr key={i} className="row-win">
                        <td>{i + 1}</td>
                        <td style={{color:'var(--accent)', fontWeight:600}}>{r._score?.toFixed(2)}</td>
                        <td style={{color: r.size === 3 ? 'var(--green)' : 'var(--text-dim)'}}>{r.size}</td>
                        <td style={{fontSize:10, whiteSpace:'nowrap'}}>{r.combos[0] ? comboLabel(r.combos[0]) : '—'}</td>
                        <td style={{fontSize:10, whiteSpace:'nowrap'}}>{r.combos[1] ? comboLabel(r.combos[1]) : '—'}</td>
                        <td style={{fontSize:10, whiteSpace:'nowrap'}}>{r.combos[2] ? comboLabel(r.combos[2]) : '—'}</td>
                        <td>{r.totalClosed}</td>
                        <td>{r.winRate}%</td>
                        <td className="tp-cell">{r.totalNetPct}%</td>
                        <td className={parseFloat(r.maxDrawdownPct) > 30 ? 'sl-cell' : ''}>{r.maxDrawdownPct}%</td>
                        <td>${parseFloat(r.compoundCapital).toLocaleString('es-CO', {minimumFractionDigits:2})}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function SarOptimView() {
  const [status, setStatus] = useState('waiting')
  const [progress, setProgress] = useState(null)
  const [ranking, setRanking] = useState([])
  const [errorMsg, setErrorMsg] = useState('')
  const startTimeRef = useRef(null)
  const bcRef = useRef(null)

  useEffect(() => {
    const bc = new BroadcastChannel('btc-sar-optim')
    bcRef.current = bc

    const sendReady = () => bc.postMessage({ type: 'ready' })
    sendReady()
    const retryTimer = setTimeout(sendReady, 1500)

    bc.onmessage = (e) => {
      const msg = e.data
      if (msg.type === 'init') {
        clearTimeout(retryTimer)
        const { candles, optimRanges, params } = msg
        setStatus('running')
        startTimeRef.current = Date.now()

        const worker = new Worker(new URL('./sarOptimWorker.js', import.meta.url), { type: 'module' })
        worker.onmessage = (ev) => {
          const m = ev.data
          if (m.type === 'progress') {
            const elapsed = Date.now() - startTimeRef.current
            let eta = null
            if (m.done >= 1 && elapsed >= 300) {
              eta = Math.round((m.total - m.done) / (m.done / elapsed))
            }
            setProgress({ done: m.done, total: m.total, eta })
            if (m.topResults?.length > 0) setRanking(m.topResults)
          } else if (m.type === 'done') {
            setStatus('done')
            setProgress(p => p ? { ...p, done: p.total } : null)
            if (m.results?.length > 0) setRanking(m.results)
            worker.terminate()
          } else if (m.type === 'error') {
            setErrorMsg(m.message)
            setStatus('error')
            worker.terminate()
          }
        }
        worker.onerror = (ev) => { setErrorMsg(ev.message); setStatus('error'); worker.terminate() }
        worker.postMessage({ candles, optimRanges, params })
      }
    }

    return () => { clearTimeout(retryTimer); bc.close() }
  }, [])

  function applyParams(row) {
    bcRef.current?.postMessage({ type: 'apply', row })
  }

  const pct = progress ? Math.round(progress.done / progress.total * 100) : 0

  return (
    <div className="optim-page">
      <header className="optim-page-header">
        <div className="logo">
          <span className="logo-icon">₿</span>
          <div>
            <div className="logo-title">MariaPaz<span style={{color:'var(--accent)'}}>Indicator</span></div>
            <div className="logo-sub">🔬 SAR · Análisis Profundo · Ranking en vivo</div>
          </div>
        </div>
        <div className="optim-page-status">
          {status === 'waiting' && 'Esperando datos de la pestaña SAR...'}
          {status === 'running' && progress && (
            <span>
              {progress.done.toLocaleString()} / {progress.total.toLocaleString()} · {pct}%
              {progress.eta != null && ` · faltan ${formatEta(progress.eta)}`}
              {' · '}{ranking.length} en ranking
            </span>
          )}
          {status === 'done' && <span style={{color:'var(--green)'}}>✅ Completado · {ranking.length} en ranking</span>}
          {status === 'error' && <span style={{color:'var(--red)'}}>⚠️ {errorMsg}</span>}
        </div>
      </header>

      {progress && (
        <div className="optim-page-progress">
          <div className="progress-track" style={{borderRadius:0, height:3}}>
            <div className="progress-fill" style={{width:`${pct}%`, transition:'width 0.5s ease'}} />
          </div>
        </div>
      )}

      <div className="optim-page-body">
        {status === 'waiting' && (
          <div className="optim-page-waiting">
            <div className="loading-ring" />
            <div>Esperando datos del análisis profundo SAR...</div>
            <div style={{fontSize:12}}>Haz clic en "🔬 Abrir Análisis Profundo" en la pestaña SAR</div>
          </div>
        )}

        {ranking.length > 0 && (
          <>
            <div className="optim-rank-meta">
              Ranking por Score = Neto% ÷ Drawdown% · filtro: neto &gt; 0% · mín. 5 trades · top 200
              {status === 'running' && ' · actualizando en vivo...'}
            </div>
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Score</th>
                    <th>Start</th><th>Inc</th><th>Max</th><th>LR</th><th>TP%</th><th>SL%</th>
                    <th>Trades</th><th>Win%</th><th>Neto%</th><th>Drawdown%</th><th>Capital $</th>
                    <th>Aplicar</th>
                  </tr>
                </thead>
                <tbody>
                  {ranking.map((r, i) => (
                    <tr key={i} className="row-win">
                      <td>{i + 1}</td>
                      <td style={{color:'var(--accent)', fontWeight:600}}>{r._score?.toFixed(2)}</td>
                      <td>{r.sarStart}</td>
                      <td>{r.sarInc}</td>
                      <td>{r.sarMax}</td>
                      <td>{r.pivotLr}</td>
                      <td>{r.tpPct}</td>
                      <td>{r.slPct}</td>
                      <td>{r.totalClosed}</td>
                      <td>{r.winRate}%</td>
                      <td className="tp-cell">{r.totalNetPct}%</td>
                      <td className={parseFloat(r.maxDrawdownPct) > 30 ? 'sl-cell' : ''}>{r.maxDrawdownPct}%</td>
                      <td>${parseFloat(r.compoundCapital).toLocaleString('es-CO', {minimumFractionDigits:2})}</td>
                      <td><button className="apply-btn" onClick={() => applyParams(r)} title="Aplicar en pestaña SAR">▶</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function SupertrendOptimView() {
  const [status, setStatus]   = useState('waiting')
  const [progress, setProgress] = useState(null)
  const [ranking, setRanking] = useState([])
  const [errorMsg, setErrorMsg] = useState('')
  const [maxDdFilter, setMaxDdFilter] = useState(20)

  const startTimeRef    = useRef(null)
  const bcRef           = useRef(null)
  const workerRef       = useRef(null)
  const initDataRef     = useRef(null)
  const resumeOffsetRef = useRef(0)

  const DEFAULT_COL_ORDER = ['score','atrPeriod','atrMultiplier','atrVolFilter','rsiThreshold','bodyRatioMin','tpPct','slPct','totalClosed','winRate','totalNetPct','maxDrawdownPct','compoundCapital']
  const [colOrder, setColOrder] = useState(DEFAULT_COL_ORDER)
  const dragColRef = useRef(null)

  function launchWorker(candles, optimRanges, params, startOffset, initialRanking) {
    if (workerRef.current) { workerRef.current.terminate() }
    resumeOffsetRef.current = startOffset
    startTimeRef.current    = Date.now()
    const worker = new Worker(new URL('./supertrendOptimWorker.js', import.meta.url), { type: 'module' })
    workerRef.current = worker
    worker.onmessage = (ev) => {
      const m = ev.data
      if (m.type === 'progress') {
        const elapsed  = Date.now() - startTimeRef.current
        const newDone  = m.done - resumeOffsetRef.current
        let eta = null
        if (newDone >= 1 && elapsed >= 300) {
          eta = Math.round((m.total - m.done) / (newDone / elapsed))
        }
        setProgress({ done: m.done, total: m.total, eta })
        if (m.topResults?.length > 0) setRanking(m.topResults)
      } else if (m.type === 'done') {
        setStatus('done')
        setProgress(p => p ? { ...p, done: p.total } : null)
        if (m.results?.length > 0) setRanking(m.results)
        workerRef.current = null
      } else if (m.type === 'error') {
        setErrorMsg(m.message); setStatus('error'); workerRef.current = null
      }
    }
    worker.onerror = (ev) => { setErrorMsg(ev.message); setStatus('error'); workerRef.current = null }
    worker.postMessage({ candles, optimRanges, params, startOffset, initialRanking })
  }

  useEffect(() => {
    const bc = new BroadcastChannel('btc-supertrend-optim')
    bcRef.current = bc
    const sendReady = () => bc.postMessage({ type: 'ready' })
    sendReady()
    const retryTimer = setTimeout(sendReady, 1500)

    bc.onmessage = (e) => {
      const msg = e.data
      if (msg.type === 'init') {
        clearTimeout(retryTimer)
        const { candles, optimRanges, params } = msg
        initDataRef.current = { candles, optimRanges, params }
        setMaxDdFilter(optimRanges.maxDdFilter ?? 20)
        setStatus('running')
        launchWorker(candles, optimRanges, params, 0, [])
      }
    }
    return () => {
      clearTimeout(retryTimer)
      bc.close()
      if (workerRef.current) { workerRef.current.terminate(); workerRef.current = null }
    }
  }, [])

  function applyParams(row) { bcRef.current?.postMessage({ type: 'apply', row }) }

  function handlePause() {
    if (workerRef.current) { workerRef.current.terminate(); workerRef.current = null }
    setStatus('paused')
  }

  function handleResume() {
    if (!initDataRef.current || !progress) return
    const { candles, optimRanges, params } = initDataRef.current
    setStatus('running')
    launchWorker(candles, optimRanges, params, progress.done, ranking)
  }

  function handleExportExcel() {
    if (ranking.length === 0) return
    const rows = ranking.map((r, i) => ({
      '#':          i + 1,
      'Score':      parseFloat(r._score?.toFixed(4)),
      'ATR Period': r.atrPeriod,
      'Mult.':      r.atrMultiplier,
      'ATR Vol.':   r.atrVolFilter ?? 0,
      'RSI':        r.rsiThreshold ?? 0,
      'Body':       r.bodyRatioMin ?? 0,
      'TP%':        r.tpPct,
      'SL%':        r.slPct,
      'Trades':     r.totalClosed,
      'Win%':       r.winRate,
      'Neto%':      r.totalNetPct,
      'Drawdown%':  r.maxDrawdownPct,
      'Capital$':   parseFloat(r.compoundCapital),
    }))
    const ws = XLSX.utils.json_to_sheet(rows)
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Supertrend Profundo')
    XLSX.writeFile(wb, 'supertrend_analisis_profundo.xlsx')
  }

  function onColDragStart(key) { dragColRef.current = key }
  function onColDragOver(e) { e.preventDefault() }
  function onColDrop(e, key) {
    e.preventDefault()
    const from = dragColRef.current
    if (!from || from === key) return
    setColOrder(prev => {
      const arr = [...prev]
      const fi = arr.indexOf(from)
      const ti = arr.indexOf(key)
      if (fi < 0 || ti < 0) return prev
      arr.splice(fi, 1)
      arr.splice(ti, 0, from)
      return arr
    })
  }

  const COL_DEFS = {
    score:           { label: 'Score',     render: (r, k) => <td key={k} style={{color:'var(--accent)', fontWeight:600}}>{r._score?.toFixed(2)}</td> },
    atrPeriod:       { label: 'ATR Per.',  render: (r, k) => <td key={k}>{r.atrPeriod}</td> },
    atrMultiplier:   { label: 'Mult.',     render: (r, k) => <td key={k}>{r.atrMultiplier}</td> },
    atrVolFilter:    { label: 'ATR Vol.',  render: (r, k) => <td key={k}>{r.atrVolFilter ?? '—'}</td> },
    rsiThreshold:    { label: 'RSI',       render: (r, k) => <td key={k}>{r.rsiThreshold ?? '—'}</td> },
    bodyRatioMin:    { label: 'Body',      render: (r, k) => <td key={k}>{r.bodyRatioMin ?? '—'}</td> },
    tpPct:           { label: 'TP%',       render: (r, k) => <td key={k}>{r.tpPct}</td> },
    slPct:           { label: 'SL%',       render: (r, k) => <td key={k}>{r.slPct}</td> },
    totalClosed:     { label: 'Trades',    render: (r, k) => <td key={k}>{r.totalClosed}</td> },
    winRate:         { label: 'Win%',      render: (r, k) => <td key={k}>{r.winRate}%</td> },
    totalNetPct:     { label: 'Neto%',     render: (r, k) => <td key={k} className="tp-cell">{r.totalNetPct}%</td> },
    maxDrawdownPct:  { label: 'Drawdown%', render: (r, k) => <td key={k} className={parseFloat(r.maxDrawdownPct) > maxDdFilter ? 'sl-cell' : ''}>{r.maxDrawdownPct}%</td> },
    compoundCapital: { label: 'Capital $', render: (r, k) => <td key={k}>${parseFloat(r.compoundCapital).toLocaleString('es-CO', {minimumFractionDigits:2})}</td> },
  }

  const pct = progress ? Math.round(progress.done / progress.total * 100) : 0

  return (
    <div className="optim-page">
      <header className="optim-page-header">
        <div className="logo">
          <span className="logo-icon">₿</span>
          <div>
            <div className="logo-title">MariaPaz<span style={{color:'var(--accent)'}}>Indicator</span></div>
            <div className="logo-sub">🔬 Supertrend · Análisis Profundo · Ranking en vivo</div>
          </div>
        </div>
        <div className="optim-page-status">
          {status === 'waiting' && 'Esperando datos de la pestaña Supertrend...'}
          {status === 'running' && progress && (
            <span>
              {progress.done.toLocaleString()} / {progress.total.toLocaleString()} · {pct}%
              {progress.eta != null && ` · faltan ${formatEta(progress.eta)}`}
              {' · '}{ranking.length} en ranking
              <button
                style={{marginLeft:12, padding:'2px 10px', fontSize:12, cursor:'pointer', borderRadius:4, border:'1px solid var(--border)'}}
                onClick={handlePause}
              >⏸ Pausar</button>
            </span>
          )}
          {status === 'paused' && (
            <span>
              <span style={{color:'#f0a500'}}>⏸ Pausado</span>
              {' · '}{progress?.done?.toLocaleString()} / {progress?.total?.toLocaleString()} · {ranking.length} en ranking
              <button
                style={{marginLeft:12, padding:'2px 10px', fontSize:12, cursor:'pointer', borderRadius:4, border:'1px solid var(--border)'}}
                onClick={handleResume}
              >▶ Reanudar</button>
              <button
                style={{marginLeft:8, padding:'2px 10px', fontSize:12, cursor:'pointer', borderRadius:4, background:'var(--green)', color:'#000', border:'none'}}
                onClick={handleExportExcel}
                disabled={ranking.length === 0}
              >📥 Excel</button>
            </span>
          )}
          {status === 'done' && <span style={{color:'var(--green)'}}>✅ Completado · {ranking.length} en ranking</span>}
          {status === 'error' && <span style={{color:'var(--red)'}}>⚠️ {errorMsg}</span>}
        </div>
      </header>

      {progress && (
        <div className="optim-page-progress">
          <div className="progress-track" style={{borderRadius:0, height:3}}>
            <div className="progress-fill" style={{width:`${pct}%`, transition:'width 0.5s ease'}} />
          </div>
        </div>
      )}

      <div className="optim-page-body">
        {status === 'waiting' && (
          <div className="optim-page-waiting">
            <div className="loading-ring" />
            <div>Esperando datos del análisis profundo Supertrend...</div>
            <div style={{fontSize:12}}>Haz clic en "🔬 Abrir Análisis Profundo" en la pestaña Supertrend</div>
          </div>
        )}

        {ranking.length > 0 && (status === 'done' || status === 'paused') && (
          <div style={{padding:'8px 16px 0'}}>
            <button
              className="run-btn optim-btn"
              style={{width:'100%', marginBottom:8, background:'var(--green)', color:'#000'}}
              onClick={handleExportExcel}
            >
              📥 Exportar ranking a Excel
            </button>
          </div>
        )}

        {ranking.length > 0 && (
          <>
            <div className="optim-rank-meta">
              Score = Neto% ÷ DD% · filtro: neto &gt; 0% · DD ≤ {maxDdFilter}% · mín. 5 trades · top {progress?.total ? (initDataRef.current?.optimRanges?.topN ?? 500) : '...'}
              {status === 'running' && ' · actualizando en vivo...'}
              <span style={{opacity:0.55, fontSize:11, marginLeft:10}}>← arrastra encabezados para reordenar →</span>
            </div>
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>#</th>
                    {colOrder.map(key => (
                      <th
                        key={key}
                        draggable
                        onDragStart={() => onColDragStart(key)}
                        onDragOver={onColDragOver}
                        onDrop={e => onColDrop(e, key)}
                        style={{cursor:'grab', userSelect:'none'}}
                        title="Arrastra para reordenar"
                      >
                        {COL_DEFS[key].label}
                      </th>
                    ))}
                    <th>Aplicar</th>
                  </tr>
                </thead>
                <tbody>
                  {ranking.map((r, i) => (
                    <tr key={i} className="row-win">
                      <td>{i + 1}</td>
                      {colOrder.map(key => COL_DEFS[key].render(r, key))}
                      <td><button className="apply-btn" onClick={() => applyParams(r)} title="Aplicar en pestaña Supertrend">▶</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function SupertrendView() {
  const [params, setParams]     = useState(DEFAULT_SUPERTREND_PARAMS)
  const [result, setResult]     = useState(null)
  const [loading, setLoading]   = useState(false)
  const [error, setError]       = useState(null)
  const [dbStatus, setDbStatus] = useState(null)
  const [activeTab, setActiveTab] = useState('stats')

  const [optimMode, setOptimMode]     = useState(false)
  const [optimRanges, setOptimRanges] = useState(DEFAULT_SUPERTREND_OPTIM)
  const optimBcRef = useRef(null)

  const [multiMode, setMultiMode]   = useState(false)
  const [multiCombos, setMultiCombos] = useState(DEFAULT_SUPERTREND_MULTI_COMBOS)

  const estimatedCombos = useMemo(() => countSupertrendCombinations(optimRanges), [optimRanges])

  useEffect(() => {
    fetch('/api/status')
      .then(r => r.json())
      .then(d => setDbStatus(d))
      .catch(() => setDbStatus({ connected: false, error: 'No se pudo conectar al servidor' }))
  }, [])

  const set = (key, val) => setParams(p => ({ ...p, [key]: val }))
  const num = (key, val) => set(key, parseFloat(val) || 0)
  const int = (key, val) => set(key, parseInt(val)   || 1)
  const setOptimField = (field, key, val) =>
    setOptimRanges(r => ({ ...r, [field]: { ...r[field], [key]: parseFloat(val) || 0 } }))

  function applyOptimResult(row) {
    setParams(p => ({
      ...p,
      atrPeriod:    row.atrPeriod,
      atrMultiplier: row.atrMultiplier,
      tpPct:        row.tpPct,
      slPct:        row.slPct,
      ...(row.atrVolFilter  != null ? { atrVolFilter:  row.atrVolFilter  } : {}),
      ...(row.rsiThreshold  != null ? { rsiThreshold:  row.rsiThreshold  } : {}),
      ...(row.bodyRatioMin  != null ? { bodyRatioMin:  row.bodyRatioMin  } : {}),
    }))
  }

  async function handleRun() {
    setLoading(true); setError(null); setResult(null)
    try {
      const resp = await fetch(`/api/candles?from=${params.dateFrom}&to=${params.dateTo}`)
      if (!resp.ok) throw new Error((await resp.json()).error)
      const { candles, total } = await resp.json()
      if (total === 0) throw new Error('No se encontraron velas en ese rango de fechas.')
      const bt = runSupertrendBacktest(candles, params)
      if (!bt) throw new Error('No se pudieron calcular resultados.')
      setResult(bt)
      setActiveTab('stats')
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  async function handleOptimize() {
    setError(null)
    try {
      const resp = await fetch(`/api/candles?from=${params.dateFrom}&to=${params.dateTo}`)
      if (!resp.ok) throw new Error((await resp.json()).error)
      const { candles, total } = await resp.json()
      if (total === 0) throw new Error('No se encontraron velas en ese rango de fechas.')

      if (optimBcRef.current) optimBcRef.current.close()
      const bc = new BroadcastChannel('btc-supertrend-optim')
      optimBcRef.current = bc
      bc.onmessage = (e) => {
        if (e.data.type === 'ready')  bc.postMessage({ type: 'init', candles, optimRanges, params })
        else if (e.data.type === 'apply') applyOptimResult(e.data.row)
      }
      window.open(window.location.pathname + '?strategy=supertrend&mode=optim', '_blank')
    } catch (e) {
      setError(e.message)
    }
  }

  const addStCombo = () => setMultiCombos(cs =>
    cs.length < 15 ? [...cs, { ...DEFAULT_SUPERTREND_MULTI_COMBOS[0] }] : cs
  )
  const removeStCombo = (ci) => setMultiCombos(cs => cs.filter((_, i) => i !== ci))
  const updateStCombo = (ci, key, raw) => {
    const val = key === 'atrPeriod' ? parseInt(raw) || 1 : parseFloat(raw) || 0
    setMultiCombos(cs => cs.map((c, i) => i === ci ? { ...c, [key]: val } : c))
  }

  async function handleMultiStRun() {
    setLoading(true); setError(null); setResult(null)
    try {
      const resp = await fetch(`/api/candles?from=${params.dateFrom}&to=${params.dateTo}`)
      if (!resp.ok) throw new Error((await resp.json()).error)
      const { candles, total } = await resp.json()
      if (total === 0) throw new Error('No se encontraron velas en ese rango de fechas.')
      const bt = runMultiSupertrendBacktest(candles, multiCombos, {
        feeSlPct:       params.feeSlPct,
        feeTpPct:       params.feeTpPct,
        leverage:       params.leverage,
        initialCapital: params.initialCapital,
        tradeDirection: params.tradeDirection,
        skipSundays:    params.skipSundays,
        atrVolPeriod:   params.atrVolPeriod,
        rsiPeriod:      params.rsiPeriod,
      })
      if (!bt) throw new Error('No se pudieron calcular resultados.')
      setResult({ ...bt, totalCandles: total, candles })
      setActiveTab('stats')
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  const stats   = result?.stats
  const winRate = stats ? parseFloat(stats.winRate)     : 0
  const netPct  = stats ? parseFloat(stats.totalNetPct) : 0

  return (
    <div className="app">
      <header className="header">
        <div className="header-inner">
          <div className="logo">
            <span className="logo-icon">₿</span>
            <div>
              <div className="logo-title">MariaPaz<span style={{color:'var(--accent)'}}>Indicator</span></div>
              <div className="logo-sub">Supertrend · BTCUSDC · 15m</div>
            </div>
          </div>
          <div className={`db-badge ${dbStatus?.connected ? 'connected' : 'disconnected'}`}>
            <span className="db-dot" />
            {dbStatus?.connected
              ? `BD conectada · ${dbStatus.totalCandles?.toLocaleString()} velas`
              : dbStatus?.error ?? 'Conectando...'}
          </div>
        </div>
        <div className="strategy-nav">
          <button className="strategy-tab" onClick={() => { window.location.href = '/' }}>📐 Rango + Resistencias</button>
          <button className="strategy-tab" onClick={() => { window.location.href = '?strategy=sar' }}>📈 SAR</button>
          <button className="strategy-tab active">📊 Supertrend</button>
          <button className="strategy-tab" onClick={() => { window.location.href = '?strategy=confluence' }}>🎯 Confluencia</button>
          <button className="strategy-tab" onClick={() => { window.location.href = '?strategy=emapullback' }}>📉 EMA Pullback</button>
          <button className="strategy-tab" onClick={() => { window.location.href = '?strategy=pinbar' }}>🕯️ Pin Bar</button>
          <button className="strategy-tab" onClick={() => { window.location.href = '?strategy=soporte' }}>📗 Rango + Soporte</button>
          <button className="strategy-tab" onClick={() => { window.location.href = '?strategy=ema' }}>📡 EMA Touch</button>
          <button className="strategy-tab" onClick={() => { window.location.href = '?strategy=rangehigh' }}>🏔️ Rango Alto</button>
        </div>
      </header>

      <div className="layout">
        {/* ── SIDEBAR ── */}
        <aside className="sidebar">
          <div className="sidebar-scroll">

            <Section title="📅 Rango de fechas">
              <InputGroup label="Desde">
                <input type="date" value={params.dateFrom} onChange={e => set('dateFrom', e.target.value)} />
              </InputGroup>
              <InputGroup label="Hasta">
                <input type="date" value={params.dateTo}   onChange={e => set('dateTo',   e.target.value)} />
              </InputGroup>
            </Section>

            <Section title="📊 Supertrend (ATR)">
              <InputGroup label="ATR Period" tooltip="Período del ATR (Wilder's RMA). Menor = más sensible">
                <input type="number" value={params.atrPeriod}     step="1"   min="2"   onChange={e => int('atrPeriod',    e.target.value)} />
              </InputGroup>
              <InputGroup label="ATR Multiplier" tooltip="Qué tan lejos del precio van las bandas. Mayor = menos señales">
                <input type="number" value={params.atrMultiplier} step="0.1" min="0.5" onChange={e => num('atrMultiplier', e.target.value)} />
              </InputGroup>
            </Section>

            <Section title="💰 TP / SL">
              <InputGroup label="TP (%)">
                <input type="number" value={params.tpPct}          step="0.01" min="0.01" onChange={e => num('tpPct',          e.target.value)} />
              </InputGroup>
              <InputGroup label="SL (%)">
                <input type="number" value={params.slPct}          step="0.01" min="0.01" onChange={e => num('slPct',          e.target.value)} />
              </InputGroup>
              <InputGroup label="Fee extra SL (%)">
                <input type="number" value={params.feeSlPct}       step="0.01" min="0"    onChange={e => num('feeSlPct',       e.target.value)} />
              </InputGroup>
              <InputGroup label="Fee descontado TP (%)">
                <input type="number" value={params.feeTpPct}       step="0.01" min="0"    onChange={e => num('feeTpPct',       e.target.value)} />
              </InputGroup>
              <InputGroup label="Apalancamiento">
                <input type="number" value={params.leverage}       step="1"    min="1"    onChange={e => num('leverage',       e.target.value)} />
              </InputGroup>
              <InputGroup label="Capital inicial ($)">
                <input type="number" value={params.initialCapital} step="100"  min="1"    onChange={e => num('initialCapital', e.target.value)} />
              </InputGroup>
            </Section>

            <Section title="🔘 Filtros">
              <InputGroup label="Dirección">
                <select value={params.tradeDirection} onChange={e => set('tradeDirection', e.target.value)}
                  style={{background:'var(--surface)',color:'var(--text)',border:'1px solid var(--border)',borderRadius:'var(--radius)',padding:'4px 8px',fontSize:12}}>
                  <option value="both">LONG + SHORT</option>
                  <option value="long">Solo LONG</option>
                  <option value="short">Solo SHORT</option>
                </select>
              </InputGroup>
              <InputGroup label="Filtro estructura HH/HL">
                <label className="toggle">
                  <input type="checkbox" checked={params.useTrendFilter} onChange={e => set('useTrendFilter', e.target.checked)} />
                  <span className="toggle-track"><span className="toggle-thumb" /></span>
                </label>
              </InputGroup>
              {params.useTrendFilter && (
                <InputGroup label="Barras pivote (izq/der)">
                  <input type="number" value={params.pivotLr} step="1" min="1" max="10" onChange={e => int('pivotLr', e.target.value)} />
                </InputGroup>
              )}
              <InputGroup label="Excluir domingos">
                <label className="toggle">
                  <input type="checkbox" checked={params.skipSundays} onChange={e => set('skipSundays', e.target.checked)} />
                  <span className="toggle-track"><span className="toggle-thumb" /></span>
                </label>
              </InputGroup>
              <InputGroup label="Filtro EMA (período)" tooltip="Solo LONG si close > EMA(N), solo SHORT si close < EMA(N). 0 = desactivado.">
                <input type="number" value={params.emaFilterPeriod} step="10" min="0" onChange={e => int('emaFilterPeriod', e.target.value)} />
              </InputGroup>
              <InputGroup label="Pausa tras SLs consecutivos" tooltip="Pausa el trading tras N SLs seguidos. 0 = desactivado.">
                <input type="number" value={params.maxConsecLosses} step="1" min="0" max="20" onChange={e => int('maxConsecLosses', e.target.value)} />
              </InputGroup>
              {params.maxConsecLosses > 0 && (
                <InputGroup label="Velas de pausa" tooltip="Cuántas velas se salta el trading luego de la racha de pérdidas.">
                  <input type="number" value={params.consecCooldownBars} step="5" min="1" onChange={e => int('consecCooldownBars', e.target.value)} />
                </InputGroup>
              )}
              <InputGroup label="ATR volat. máx (ratio)" tooltip="Solo operar si ATR actual ≤ ratio × SMA(ATR). Evita entradas en picos de volatilidad. 0 = desactivado.">
                <input type="number" value={params.atrVolFilter} step="0.1" min="0" max="5" onChange={e => num('atrVolFilter', e.target.value)} />
              </InputGroup>
              {params.atrVolFilter > 0 && (
                <InputGroup label="Período SMA del ATR" tooltip="Barras para calcular el promedio base del ATR.">
                  <input type="number" value={params.atrVolPeriod} step="5" min="5" max="100" onChange={e => int('atrVolPeriod', e.target.value)} />
                </InputGroup>
              )}
              <InputGroup label="ADX mínimo" tooltip="Solo operar si ADX ≥ umbral (fuerza de tendencia). 0 = desactivado.">
                <input type="number" value={params.adxMinimum} step="5" min="0" max="60" onChange={e => num('adxMinimum', e.target.value)} />
              </InputGroup>
              {params.adxMinimum > 0 && (
                <InputGroup label="ADX período" tooltip="Período del ADX de Wilder (estándar = 14).">
                  <input type="number" value={params.adxPeriod} step="1" min="5" max="50" onChange={e => int('adxPeriod', e.target.value)} />
                </InputGroup>
              )}
              <InputGroup label="RSI umbral sobrecompra" tooltip="No LONG si RSI > umbral, no SHORT si RSI < (100-umbral). 0 = desactivado. Ej: 70 → bloquea LONG>70 y SHORT<30.">
                <input type="number" value={params.rsiThreshold} step="5" min="0" max="100" onChange={e => num('rsiThreshold', e.target.value)} />
              </InputGroup>
              {params.rsiThreshold > 0 && (
                <InputGroup label="RSI período">
                  <input type="number" value={params.rsiPeriod} step="1" min="2" max="50" onChange={e => int('rsiPeriod', e.target.value)} />
                </InputGroup>
              )}
              <InputGroup label="Cuerpo vela mínimo (ratio)" tooltip="Solo entrar si |close-open|/(high-low) ≥ valor. Filtra velas de indecisión. 0 = desactivado. Ej: 0.3 = 30%.">
                <input type="number" value={params.bodyRatioMin} step="0.05" min="0" max="1" onChange={e => num('bodyRatioMin', e.target.value)} />
              </InputGroup>
              <InputGroup label="EMA pendiente (período)" tooltip="LONG solo si EMA sube, SHORT solo si EMA baja. 0 = desactivado.">
                <input type="number" value={params.slopeEmaPeriod} step="10" min="0" onChange={e => int('slopeEmaPeriod', e.target.value)} />
              </InputGroup>
              {params.slopeEmaPeriod > 0 && (
                <InputGroup label="Barras para pendiente" tooltip="Cuántas velas atrás comparar para calcular la pendiente.">
                  <input type="number" value={params.slopeLookback} step="1" min="1" max="20" onChange={e => int('slopeLookback', e.target.value)} />
                </InputGroup>
              )}
            </Section>

            <Section title="🔬 Análisis Profundo">
              <InputGroup label="Activar optimización">
                <label className="toggle">
                  <input type="checkbox" checked={optimMode} onChange={e => setOptimMode(e.target.checked)} />
                  <span className="toggle-track"><span className="toggle-thumb" /></span>
                </label>
              </InputGroup>
              {optimMode && (
                <>
                  <div className="optim-hint">Min · Max · Paso</div>
                  <OptimRow label="TP (%)"        field="tpPct"         stepHint="0.1"  ranges={optimRanges} onChange={setOptimField} />
                  <OptimRow label="SL (%)"        field="slPct"         stepHint="0.1"  ranges={optimRanges} onChange={setOptimField} />
                  <OptimRow label="ATR Period"    field="atrPeriod"     stepHint="1"    ranges={optimRanges} onChange={setOptimField} />
                  <OptimRow label="Mult."         field="atrMultiplier" stepHint="0.5"  ranges={optimRanges} onChange={setOptimField} />
                  <OptimRow label="ATR Vol.ratio" field="atrVolFilter"  stepHint="0.1"  ranges={optimRanges} onChange={setOptimField} />
                  <OptimRow label="RSI umbral"    field="rsiThreshold"  stepHint="5"    ranges={optimRanges} onChange={setOptimField} />
                  <OptimRow label="Body ratio"    field="bodyRatioMin"  stepHint="0.05" ranges={optimRanges} onChange={setOptimField} />
                  <InputGroup label="DD máx. (%)">
                    <input type="number" value={optimRanges.maxDdFilter ?? 20} step="5" min="5" onChange={e => setOptimRanges(r => ({ ...r, maxDdFilter: parseFloat(e.target.value) || 20 }))} />
                  </InputGroup>
                  <InputGroup label="Top N ranking">
                    <input type="number" value={optimRanges.topN ?? 500} step="100" min="50" onChange={e => setOptimRanges(r => ({ ...r, topN: parseInt(e.target.value) || 500 }))} />
                  </InputGroup>
                  <div className="optim-combos">{estimatedCombos.toLocaleString()} combinaciones</div>
                </>
              )}
            </Section>

            {/* ── MULTI-COMBINACIONES ── */}
            <div className="section optim-section">
              <div className="optim-section-header" onClick={() => { setMultiMode(v => !v); setOptimMode(false) }}>
                <span className="section-title" style={{marginBottom:0, borderBottom:'none', paddingBottom:0}}>🎯 Multi-Combinaciones</span>
                <span className="optim-chevron">{multiMode ? '▲' : '▼'}</span>
              </div>
              {multiMode && (
                <div className="optim-body">
                  <div style={{fontSize:11, color:'var(--text-muted)', marginBottom:8, lineHeight:1.5}}>
                    Hasta 15 combos. 1 trade a la vez — el primero que cruce Supertrend toma el trade.
                  </div>
                  {multiCombos.map((combo, ci) => (
                    <div key={ci} className="multi-combo-block">
                      <div className="multi-combo-header">
                        <span style={{fontSize:11, fontWeight:700, color:'var(--accent)', textTransform:'uppercase', letterSpacing:'0.06em'}}>
                          Combo {ci + 1}
                        </span>
                        {multiCombos.length > 1 && (
                          <button className="multi-remove-btn" onClick={() => removeStCombo(ci)}>✕</button>
                        )}
                      </div>
                      <div className="multi-combo-fields">
                        <div className="multi-field">
                          <label>ATR Per.</label>
                          <input type="number" step="1" min="2" value={combo.atrPeriod} onChange={e => updateStCombo(ci, 'atrPeriod', e.target.value)} />
                        </div>
                        <div className="multi-field">
                          <label>Mult.</label>
                          <input type="number" step="0.1" min="0.5" value={combo.atrMultiplier} onChange={e => updateStCombo(ci, 'atrMultiplier', e.target.value)} />
                        </div>
                        <div className="multi-field">
                          <label>TP%</label>
                          <input type="number" step="0.01" min="0.01" value={combo.tpPct} onChange={e => updateStCombo(ci, 'tpPct', e.target.value)} />
                        </div>
                        <div className="multi-field">
                          <label>SL%</label>
                          <input type="number" step="0.01" min="0.01" value={combo.slPct} onChange={e => updateStCombo(ci, 'slPct', e.target.value)} />
                        </div>
                        <div className="multi-field">
                          <label>ATR Vol</label>
                          <input type="number" step="0.1" min="0" value={combo.atrVolFilter ?? 0} onChange={e => updateStCombo(ci, 'atrVolFilter', e.target.value)} />
                        </div>
                        <div className="multi-field">
                          <label>RSI</label>
                          <input type="number" step="5" min="0" max="100" value={combo.rsiThreshold ?? 0} onChange={e => updateStCombo(ci, 'rsiThreshold', e.target.value)} />
                        </div>
                        <div className="multi-field">
                          <label>Body</label>
                          <input type="number" step="0.05" min="0" max="1" value={combo.bodyRatioMin ?? 0} onChange={e => updateStCombo(ci, 'bodyRatioMin', e.target.value)} />
                        </div>
                      </div>
                    </div>
                  ))}
                  {multiCombos.length < 15 && (
                    <button
                      className="run-btn optim-btn"
                      style={{width:'100%', marginTop:4, padding:'8px', fontSize:12}}
                      onClick={addStCombo}
                    >
                      + Agregar combo
                    </button>
                  )}
                </div>
              )}
            </div>

          </div>
          <div className="sidebar-footer">
            {multiMode
              ? <button className="run-btn" onClick={handleMultiStRun} disabled={loading || !dbStatus?.connected}>
                  {loading ? <><span className="spinner" /> Procesando...</> : '▶ Ejecutar Multi-Backtest'}
                </button>
              : optimMode
              ? <>
                  <button className="run-btn optim-btn" onClick={handleOptimize} disabled={!dbStatus?.connected}>
                    🔬 Abrir Análisis Profundo
                  </button>
                  <button className="run-btn optim-btn" style={{marginTop:'0.4rem'}}
                    onClick={() => window.open(window.location.pathname + '?strategy=supertrend&mode=exceloptim', '_blank')}>
                    📊 Análisis Multi-Combo Excel
                  </button>
                </>
              : <button className="run-btn" onClick={handleRun} disabled={loading || !dbStatus?.connected}>
                  {loading ? <><span className="spinner" /> Procesando...</> : '▶ Ejecutar Backtest'}
                </button>
            }
            {error && <div className="error-box">⚠️ {error}</div>}
          </div>
        </aside>

        {/* ── MAIN ── */}
        <main className="main">
          {!result && !loading && (
            <div className="empty-state">
              <div className="empty-icon">📊</div>
              <div className="empty-title">Supertrend</div>
              <div className="empty-sub">Configura los parámetros y ejecuta el backtest para ver los resultados</div>
            </div>
          )}

          {loading && (
            <div className="empty-state">
              <div className="loading-ring" />
              <div className="empty-title">Analizando velas...</div>
              <div className="empty-sub">Calculando Supertrend y señales</div>
            </div>
          )}

          {result && !loading && (
            <>
              <div className="result-header">
                <div className="result-meta">
                  <span>📊 {result.totalCandles.toLocaleString()} velas</span>
                  <span>·</span>
                  <span>{params.dateFrom} → {params.dateTo}</span>
                </div>
                <div className="tabs">
                  <button className={activeTab === 'stats'   ? 'tab active' : 'tab'} onClick={() => setActiveTab('stats')}>Estadísticas</button>
                  <button className={activeTab === 'trades'  ? 'tab active' : 'tab'} onClick={() => setActiveTab('trades')}>Trades ({result.trades.length})</button>
                  <button className={activeTab === 'signals' ? 'tab active' : 'tab'} onClick={() => setActiveTab('signals')}>Señales ({result.signals.length})</button>
                </div>
              </div>

              {activeTab === 'stats' && (
                <>
                  <div className="stats-grid">
                    <StatCard label="Trades cerrados"                      value={stats.totalClosed}    variant="neutral" />
                    <StatCard label="TP ✅"                                 value={stats.totalTp}        variant="win" />
                    <StatCard label="SL ❌"                                 value={stats.totalSl}        variant="loss" />
                    <StatCard label="Win Rate"                              value={`${stats.winRate}%`}  variant={winRate >= 50 ? 'win' : 'loss'} />
                    <StatCard label={`Ganancia acum. x${params.leverage}`} value={`${stats.totalProfitPct}%`} variant="win" />
                    <StatCard label={`Pérdida acum. x${params.leverage}`}  value={`${stats.totalLossPct}%`}  variant="loss" />
                    <StatCard label={`Neto x${params.leverage}`}           value={`${stats.totalNetPct}%`}   variant={netPct >= 0 ? 'win' : 'loss'} />
                    <StatCard label="Máx. Drawdown"                        value={`${stats.maxDrawdownPct}%`} variant="warn" />
                    <StatCard label="Capital simple"    value={`$${parseFloat(stats.simpleCapital).toLocaleString('es-CO',{minimumFractionDigits:2})}`}   variant="neutral" />
                    <StatCard label="Capital compuesto" value={`$${parseFloat(stats.compoundCapital).toLocaleString('es-CO',{minimumFractionDigits:2})}`} variant="accent" />
                    <StatCard label="Mejor método"                         value={stats.bestMethod}     variant="accent" />
                    {result.isMulti && <StatCard label="Combos activos" value={multiCombos.length} variant="neutral" />}
                    {!result.isMulti && <StatCard label={`TP efectivo x${params.leverage}`} value={`${stats.effectiveTpPct}%`} variant="neutral" />}
                    {!result.isMulti && <StatCard label={`SL efectivo x${params.leverage}`} value={`${stats.effectiveSlPct}%`} variant="neutral" />}
                  </div>

                  {result.trades.length > 0 && (() => {
                    const { byYear, byMonth } = computePeriodStats(result.trades, stats.effectiveTpPct, stats.effectiveSlPct)
                    return <>
                      <PeriodTable title="📅 Acumulado por año"  rows={byYear}  />
                      <PeriodTable title="📆 Acumulado por mes"  rows={byMonth} />
                    </>
                  })()}
                </>
              )}

              {activeTab === 'trades' && (
                <div className="table-wrap">
                  {result.trades.length === 0
                    ? <div className="empty-table">No se cerraron trades en este período</div>
                    : (
                      <table className="data-table">
                        <thead>
                          <tr>
                            <th>#</th><th>Lado</th><th>Apertura</th><th>Entrada</th>
                            <th>TP</th><th>SL</th><th>Cierre</th><th>Resultado</th>
                            <th>Capital entrada</th><th>Capital salida</th>
                          </tr>
                        </thead>
                        <tbody>
                          {result.trades.map((t, i) => (
                            <tr key={i} className={t.result === 'TP' ? 'row-win' : 'row-loss'}>
                              <td>{i + 1}</td>
                              <td><span className={`badge badge-${t.side === 'LONG' ? 'tp' : 'sl'}`}>{t.side === 'LONG' ? '▲ LONG' : '▼ SHORT'}</span></td>
                              <td style={{fontFamily:'var(--font-mono)',fontSize:11}}>{new Date(t.time).toLocaleString('es-CO',{timeZone:'UTC'})}</td>
                              <td style={{fontFamily:'var(--font-mono)'}}>${parseFloat(t.price).toLocaleString('en-US')}</td>
                              <td className="tp-cell" style={{fontFamily:'var(--font-mono)'}}>${parseFloat(t.tp).toLocaleString('en-US')}</td>
                              <td className="sl-cell" style={{fontFamily:'var(--font-mono)'}}>${parseFloat(t.sl).toLocaleString('en-US')}</td>
                              <td style={{fontFamily:'var(--font-mono)',fontSize:11}}>{new Date(t.closeTime).toLocaleString('es-CO',{timeZone:'UTC'})}</td>
                              <td><span className={`badge badge-${t.result.toLowerCase()}`}>{t.result === 'TP' ? '✅ TP' : '❌ SL'}</span></td>
                              <td>${parseFloat(t.capitalAtEntry).toLocaleString('es-CO',{minimumFractionDigits:2,maximumFractionDigits:2})}</td>
                              <td className={t.result === 'TP' ? 'tp-cell' : 'sl-cell'}>${parseFloat(t.capitalAtExit).toLocaleString('es-CO',{minimumFractionDigits:2,maximumFractionDigits:2})}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )
                  }
                </div>
              )}

              {activeTab === 'signals' && (
                <div className="table-wrap">
                  {result.signals.length === 0
                    ? <div className="empty-table">No se generaron señales en este período</div>
                    : (
                      <table className="data-table">
                        <thead>
                          <tr>
                            <th>#</th><th>Fecha</th><th>Tipo</th><th>Precio entrada</th><th>Supertrend</th><th>Tendencia</th>
                          </tr>
                        </thead>
                        <tbody>
                          {result.signals.map((s, i) => (
                            <tr key={i}>
                              <td>{i + 1}</td>
                              <td style={{fontFamily:'var(--font-mono)',fontSize:11}}>{new Date(s.time).toLocaleString('es-CO',{timeZone:'UTC'})}</td>
                              <td><span className={`badge badge-${s.type === 'LONG' ? 'tp' : 'sl'}`}>{s.type === 'LONG' ? '▲ LONG' : '▼ SHORT'}</span></td>
                              <td style={{fontFamily:'var(--font-mono)'}}>${parseFloat(s.price).toLocaleString('en-US')}</td>
                              <td style={{fontFamily:'var(--font-mono)',color:'var(--text-muted)'}}>${parseFloat(s.supertrendVal).toLocaleString('en-US')}</td>
                              <td style={{color: s.trend === 1 ? 'var(--green)' : s.trend === -1 ? 'var(--red)' : 'var(--text-muted)'}}>
                                {s.trend === 1 ? 'ALCISTA' : s.trend === -1 ? 'BAJISTA' : '—'}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )
                  }
                </div>
              )}
            </>
          )}
        </main>
      </div>
    </div>
  )
}

function AppMain() {
  const [params, setParams] = useState(DEFAULT_PARAMS)
  const [result, setResult] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [dbStatus, setDbStatus] = useState(null)
  const [activeTab, setActiveTab] = useState('stats')

  // Optimización
  const [optimMode, setOptimMode] = useState(false)
  const [optimRanges, setOptimRanges] = useState(DEFAULT_OPTIM)
  const optimBcRef = useRef(null)

  const [tradeModal, setTradeModal] = useState(null) // { trade, candles }

  // Walk-Forward
  const [wfMode, setWfMode] = useState(false)
  const [wfTrainingDays, setWfTrainingDays] = useState(30)
  const [wfResult, setWfResult] = useState(null)
  const [wfLoading, setWfLoading] = useState(false)
  const [wfProgress, setWfProgress] = useState(null) // { day, totalDays }

  // Multi-combo
  const [multiMode, setMultiMode] = useState(false)
  const [multiCombos, setMultiCombos] = useState(DEFAULT_MULTI_COMBOS)

  const estimatedCombos = useMemo(() => countCombinations(optimRanges), [optimRanges])

  useEffect(() => {
    fetch('/api/status')
      .then(r => r.json())
      .then(d => setDbStatus(d))
      .catch(() => setDbStatus({ connected: false, error: 'No se pudo conectar al servidor' }))
  }, [])

  const set = (key, val) => setParams(p => ({ ...p, [key]: val }))
  const num = (key, val) => set(key, parseFloat(val) || 0)
  const int = (key, val) => set(key, parseInt(val) || 1)

  const setOptimField = (field, key, val) =>
    setOptimRanges(r => ({ ...r, [field]: { ...r[field], [key]: parseFloat(val) || 0 } }))

  async function fetchCandles() {
    const resp = await fetch(`/api/candles?from=${params.dateFrom}&to=${params.dateTo}`)
    if (!resp.ok) throw new Error((await resp.json()).error)
    const { candles, total } = await resp.json()
    if (total === 0) throw new Error('No se encontraron velas en ese rango de fechas.')
    return { candles, total }
  }

  async function handleRun() {
    setLoading(true)
    setError(null)
    setResult(null)
    try {
      const { candles, total } = await fetchCandles()
      const bt = runBacktest(candles, {
        minRangePct: params.minRangePct,
        maxRangePct: params.maxRangePct,
        lookbackCandles: params.lookbackCandles,
        minWickPct: params.minWickPct,
        slPct: params.slPct,
        tpPct: params.tpPct,
        feeSlPct: params.feeSlPct,
        feeTpPct: params.feeTpPct,
        leverage: params.leverage,
        initialCapital: params.initialCapital,
        monthlyContribution: params.monthlyContribution,
        resistances: [params.res1, params.res2, params.res3],
      })
      setResult({ ...bt, totalCandles: total, candles })
      setActiveTab('stats')
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  function handleDownloadDebug() {
    if (!result?.debugLog) return
    const blob = new Blob([JSON.stringify(result.debugLog, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `debug_${params.dateFrom}_${params.dateTo}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  async function handleOptimize() {
    setError(null)
    try {
      const { candles } = await fetchCandles()

      if (optimBcRef.current) optimBcRef.current.close()
      const bc = new BroadcastChannel('btc-optim')
      optimBcRef.current = bc

      bc.onmessage = (e) => {
        if (e.data.type === 'ready') {
          bc.postMessage({ type: 'init', candles, optimRanges, params })
        } else if (e.data.type === 'apply') {
          applyOptimResult(e.data.row)
        }
      }

      window.open(window.location.pathname + '?mode=optim', '_blank')
    } catch (e) {
      setError(e.message)
    }
  }

  async function handleWalkForward() {
    setWfLoading(true)
    setWfResult(null)
    setWfProgress(null)
    setError(null)
    try {
      const { candles, total } = await fetchCandles()

      await new Promise((resolve, reject) => {
        const worker = new Worker(new URL('./walkForwardWorker.js', import.meta.url), { type: 'module' })

        worker.onmessage = (e) => {
          const msg = e.data
          if (msg.type === 'progress') {
            setWfProgress({ day: msg.day, totalDays: msg.totalDays })
          } else if (msg.type === 'done') {
            setWfResult({ ...msg, totalCandles: total })
            setActiveTab('wf')
            worker.terminate()
            resolve()
          } else if (msg.type === 'error') {
            worker.terminate()
            reject(new Error(msg.message))
          }
        }

        worker.onerror = (e) => { worker.terminate(); reject(new Error(e.message)) }

        worker.postMessage({ candles, optimRanges, params, trainingDays: wfTrainingDays })
      })
    } catch (e) {
      setError(e.message)
    } finally {
      setWfLoading(false)
      setWfProgress(null)
    }
  }

  function applyOptimResult(row) {
    setParams(p => ({
      ...p,
      minRangePct: row.minRangePct,
      maxRangePct: row.maxRangePct,
      lookbackCandles: row.lookbackCandles,
      minWickPct: row.minWickPct,
      slPct: row.slPct,
      tpPct: row.tpPct,
    }))
    setOptimMode(false)
  }

  // ── Multi-combo helpers ──
  const addCombo = () => setMultiCombos(cs =>
    cs.length < 15
      ? [...cs, { ...DEFAULT_MULTI_COMBOS[0], label: `Combo ${cs.length + 1}` }]
      : cs
  )
  const removeCombo = (ci) => setMultiCombos(cs => cs.filter((_, i) => i !== ci))
  const updateCombo = (ci, key, raw) => {
    const val = key === 'lookbackCandles' ? parseInt(raw) || 1 : parseFloat(raw) || 0
    setMultiCombos(cs => cs.map((c, i) => i === ci ? { ...c, [key]: val } : c))
  }

  async function handleMultiRun() {
    setLoading(true)
    setError(null)
    setResult(null)
    try {
      const { candles, total } = await fetchCandles()
      const bt = runMultiBacktest(candles, multiCombos, {
        feeSlPct: params.feeSlPct,
        feeTpPct: params.feeTpPct,
        leverage: params.leverage,
        initialCapital: params.initialCapital,
        monthlyContribution: params.monthlyContribution,
        emaMinGapPct: params.emaMinGapPct,
      })
      setResult({ ...bt, totalCandles: total, candles })
      setActiveTab('stats')
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  const estimatedTradingDays = useMemo(() => {
    const from = new Date(params.dateFrom), to = new Date(params.dateTo)
    const total = Math.max(0, Math.floor((to - from) / (1000 * 60 * 60 * 24)))
    return Math.max(0, total - wfTrainingDays)
  }, [params.dateFrom, params.dateTo, wfTrainingDays])
  const estimatedWfCombos = useMemo(() => estimatedCombos * estimatedTradingDays, [estimatedCombos, estimatedTradingDays])

  const isLoading = loading || wfLoading
  const stats = result?.stats
  const netPct = stats ? parseFloat(stats.totalNetPct) : 0
  const winRate = stats ? parseFloat(stats.winRate) : 0

  return (
    <div className="app">
      <header className="header">
        <div className="header-inner">
          <div className="logo">
            <span className="logo-icon">₿</span>
            <div>
              <div className="logo-title">MariaPaz<span style={{color:'var(--accent)'}}>Indicator</span></div>
              <div className="logo-sub">Rango Dinámico · BTCUSDC · 15m</div>
            </div>
          </div>
          <div className={`db-badge ${dbStatus?.connected ? 'connected' : 'disconnected'}`}>
            <span className="db-dot" />
            {dbStatus?.connected
              ? `BD conectada · ${dbStatus.totalCandles?.toLocaleString()} velas`
              : dbStatus?.error ?? 'Conectando...'}
          </div>
        </div>
        <div className="strategy-nav">
          <button className="strategy-tab active">📐 Rango + Resistencias</button>
          <button className="strategy-tab" onClick={() => { window.location.href = '?strategy=sar' }}>📈 SAR</button>
          <button className="strategy-tab" onClick={() => { window.location.href = '?strategy=supertrend' }}>📊 Supertrend</button>
          <button className="strategy-tab" onClick={() => { window.location.href = '?strategy=confluence' }}>🎯 Confluencia</button>
          <button className="strategy-tab" onClick={() => { window.location.href = '?strategy=emapullback' }}>📉 EMA Pullback</button>
          <button className="strategy-tab" onClick={() => { window.location.href = '?strategy=pinbar' }}>🕯️ Pin Bar</button>
          <button className="strategy-tab" onClick={() => { window.location.href = '?strategy=soporte' }}>📗 Rango + Soporte</button>
          <button className="strategy-tab" onClick={() => { window.location.href = '?strategy=ema' }}>📡 EMA Touch</button>
          <button className="strategy-tab" onClick={() => { window.location.href = '?strategy=rangehigh' }}>🏔️ Rango Alto</button>
        </div>
      </header>

      <div className="layout">
        {/* ── PANEL IZQUIERDO: PARÁMETROS ── */}
        <aside className="sidebar">
          <div className="sidebar-scroll">
            <Section title="📅 Rango de fechas">
              <InputGroup label="Desde">
                <input type="date" value={params.dateFrom} onChange={e => set('dateFrom', e.target.value)} />
              </InputGroup>
              <InputGroup label="Hasta">
                <input type="date" value={params.dateTo} onChange={e => set('dateTo', e.target.value)} />
              </InputGroup>
            </Section>

            <Section title="📐 Configuración del Rango">
              <InputGroup label="Mínimo (%)" tooltip="% mínimo de compresión del rango">
                <input type="number" step="0.1" value={params.minRangePct} onChange={e => num('minRangePct', e.target.value)} />
              </InputGroup>
              <InputGroup label="Máximo (%)" tooltip="% máximo de compresión del rango">
                <input type="number" step="0.1" value={params.maxRangePct} onChange={e => num('maxRangePct', e.target.value)} />
              </InputGroup>
              <InputGroup label="Velas lookback" tooltip="Cuántas velas hacia atrás para calcular el rango">
                <input type="number" step="1" min="1" value={params.lookbackCandles} onChange={e => int('lookbackCandles', e.target.value)} />
              </InputGroup>
              <InputGroup label="Mecha mínima (%)" tooltip="% mínimo de mecha superior respecto al rango de la vela">
                <input type="number" step="0.1" value={params.minWickPct} onChange={e => num('minWickPct', e.target.value)} />
              </InputGroup>
            </Section>

            <Section title="🎯 Niveles Manuales (Resistencias)">
              <InputGroup label="Resistencia 1">
                <input type="number" step="1" value={params.res1} onChange={e => num('res1', e.target.value)} />
              </InputGroup>
              <InputGroup label="Resistencia 2">
                <input type="number" step="1" value={params.res2} onChange={e => num('res2', e.target.value)} />
              </InputGroup>
              <InputGroup label="Resistencia 3">
                <input type="number" step="1" value={params.res3} onChange={e => num('res3', e.target.value)} />
              </InputGroup>
            </Section>

            <Section title="⚖️ TP / SL">
              <InputGroup label="SL (%)">
                <input type="number" step="0.01" value={params.slPct} onChange={e => num('slPct', e.target.value)} />
              </InputGroup>
              <InputGroup label="TP (%)">
                <input type="number" step="0.01" value={params.tpPct} onChange={e => num('tpPct', e.target.value)} />
              </InputGroup>
            </Section>

            <Section title="📊 Estadísticas">
              <InputGroup label="Fee SL extra (%)">
                <input type="number" step="0.01" value={params.feeSlPct} onChange={e => num('feeSlPct', e.target.value)} />
              </InputGroup>
              <InputGroup label="Fee TP (%)">
                <input type="number" step="0.01" value={params.feeTpPct} onChange={e => num('feeTpPct', e.target.value)} />
              </InputGroup>
              <InputGroup label="Apalancamiento">
                <input type="number" step="1" min="1" value={params.leverage} onChange={e => num('leverage', e.target.value)} />
              </InputGroup>
              <InputGroup label="Capital inicial ($)">
                <input type="number" step="100" min="1" value={params.initialCapital} onChange={e => num('initialCapital', e.target.value)} />
              </InputGroup>
              <InputGroup label="Aporte mensual ($)" tooltip="Monto que se suma al capital compuesto cada mes. Dejar en 0 para no aplicar.">
                <input type="number" step="50" min="0" value={params.monthlyContribution} onChange={e => num('monthlyContribution', e.target.value)} />
              </InputGroup>
              <InputGroup label="Distancia mínima EMA (%)" tooltip="EMA50 debe estar al menos este % por encima de EMA10 para señal bajista. 0 = sin filtro.">
                <input type="number" step="0.05" min="0" value={params.emaMinGapPct} onChange={e => num('emaMinGapPct', e.target.value)} />
              </InputGroup>
            </Section>

            {/* ── ANÁLISIS PROFUNDO ── */}
            <div className="section optim-section">
              <div className="optim-section-header" onClick={() => { setOptimMode(v => !v); setWfMode(false); setMultiMode(false) }}>
                <span className="section-title" style={{marginBottom:0, borderBottom:'none', paddingBottom:0}}>🔬 Análisis Profundo</span>
                <span className="optim-chevron">{optimMode ? '▲' : '▼'}</span>
              </div>

              {optimMode && (
                <div className="optim-body">
                  <div className="optim-hint">
                    <span>Parámetro</span><span>Min</span><span>Max</span><span>Paso</span>
                  </div>
                  <OptimRow label="Mínimo %"    field="minRangePct"     stepHint="0.1"  ranges={optimRanges} onChange={setOptimField} />
                  <OptimRow label="Máximo %"    field="maxRangePct"     stepHint="0.1"  ranges={optimRanges} onChange={setOptimField} />
                  <OptimRow label="Lookback"    field="lookbackCandles" stepHint="1"    ranges={optimRanges} onChange={setOptimField} />
                  <OptimRow label="Mecha %"     field="minWickPct"      stepHint="1"    ranges={optimRanges} onChange={setOptimField} />
                  <OptimRow label="SL %"        field="slPct"           stepHint="0.01" ranges={optimRanges} onChange={setOptimField} />
                  <OptimRow label="TP %"        field="tpPct"           stepHint="0.01" ranges={optimRanges} onChange={setOptimField} />
                  <div className="optim-count">
                    ~{estimatedCombos.toLocaleString()} combinaciones
                    {estimatedCombos > 50000 && <span className="optim-warn"> · puede tardar</span>}
                  </div>
                </div>
              )}
            </div>

            {/* ── MULTI-COMBINACIONES ── */}
            <div className="section optim-section">
              <div className="optim-section-header" onClick={() => { setMultiMode(v => !v); setOptimMode(false); setWfMode(false) }}>
                <span className="section-title" style={{marginBottom:0, borderBottom:'none', paddingBottom:0}}>🎯 Multi-Combinaciones</span>
                <span className="optim-chevron">{multiMode ? '▲' : '▼'}</span>
              </div>
              {multiMode && (
                <div className="optim-body">
                  <div style={{fontSize:11, color:'var(--text-muted)', marginBottom:8, lineHeight:1.5}}>
                    Hasta 15 combos activos. Solo 1 trade/día — gana el primero que dispare señal.
                  </div>
                  {multiCombos.map((combo, ci) => (
                    <div key={ci} className="multi-combo-block">
                      <div className="multi-combo-header">
                        <span style={{fontSize:11, fontWeight:700, color:'var(--accent)', textTransform:'uppercase', letterSpacing:'0.06em'}}>
                          Combo {ci + 1}
                        </span>
                        {multiCombos.length > 1 && (
                          <button className="multi-remove-btn" onClick={() => removeCombo(ci)}>✕</button>
                        )}
                      </div>
                      <div className="multi-combo-fields">
                        <div className="multi-field">
                          <label>Min%</label>
                          <input type="number" step="0.1" value={combo.minRangePct} onChange={e => updateCombo(ci, 'minRangePct', e.target.value)} />
                        </div>
                        <div className="multi-field">
                          <label>Max%</label>
                          <input type="number" step="0.1" value={combo.maxRangePct} onChange={e => updateCombo(ci, 'maxRangePct', e.target.value)} />
                        </div>
                        <div className="multi-field">
                          <label>LB</label>
                          <input type="number" step="1" min="1" value={combo.lookbackCandles} onChange={e => updateCombo(ci, 'lookbackCandles', e.target.value)} />
                        </div>
                        <div className="multi-field">
                          <label>Mecha%</label>
                          <input type="number" step="0.1" value={combo.minWickPct} onChange={e => updateCombo(ci, 'minWickPct', e.target.value)} />
                        </div>
                        <div className="multi-field">
                          <label>SL%</label>
                          <input type="number" step="0.01" value={combo.slPct} onChange={e => updateCombo(ci, 'slPct', e.target.value)} />
                        </div>
                        <div className="multi-field">
                          <label>TP%</label>
                          <input type="number" step="0.01" value={combo.tpPct} onChange={e => updateCombo(ci, 'tpPct', e.target.value)} />
                        </div>
                      </div>
                    </div>
                  ))}
                  {multiCombos.length < 15 && (
                    <button
                      className="run-btn optim-btn"
                      style={{width:'100%', marginTop:4, padding:'8px', fontSize:12}}
                      onClick={addCombo}
                    >
                      + Agregar combo
                    </button>
                  )}
                </div>
              )}
            </div>

            {/* ── WALK-FORWARD ── */}
            <div className="section optim-section">
              <div className="optim-section-header" onClick={() => { setWfMode(v => !v); setOptimMode(false); setMultiMode(false) }}>
                <span className="section-title" style={{marginBottom:0, borderBottom:'none', paddingBottom:0}}>📈 Walk-Forward</span>
                <span className="optim-chevron">{wfMode ? '▲' : '▼'}</span>
              </div>
              {wfMode && (
                <div className="optim-body">
                  <div className="input-group" style={{marginBottom: 8}}>
                    <label>Días de entrenamiento</label>
                    <input type="number" step="5" min="7" value={wfTrainingDays}
                      onChange={e => setWfTrainingDays(parseInt(e.target.value) || 30)} />
                  </div>
                  <div className="optim-count" style={{textAlign:'left', lineHeight: 1.7}}>
                    Usa la grilla de <strong style={{color:'var(--text-dim)'}}>Análisis Profundo</strong><br/>
                    ~{estimatedCombos.toLocaleString()} combos/día · ~{estimatedTradingDays.toLocaleString()} días<br/>
                    <span className={estimatedWfCombos > 5000000 ? 'optim-warn' : ''}>
                      ~{estimatedWfCombos.toLocaleString()} total
                      {estimatedWfCombos > 5000000 && ' · muy lento, reduce la grilla'}
                    </span>
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="sidebar-footer">
            {multiMode
              ? <button className="run-btn" onClick={handleMultiRun} disabled={isLoading || !dbStatus?.connected}>
                  {loading ? <><span className="spinner" /> Procesando...</> : '▶ Ejecutar Multi-Backtest'}
                </button>
              : wfMode
              ? <button className="run-btn wf-btn" onClick={handleWalkForward} disabled={isLoading || !dbStatus?.connected}>
                  {wfLoading ? <><span className="spinner" /> Analizando...</> : '📈 Ejecutar Walk-Forward'}
                </button>
              : optimMode
              ? <>
                  <button className="run-btn optim-btn" onClick={handleOptimize} disabled={!dbStatus?.connected}>
                    🔬 Abrir Análisis Profundo
                  </button>
                  <button className="run-btn optim-btn" style={{marginTop:'0.4rem'}}
                    onClick={() => window.open(window.location.pathname + '?mode=exceloptim', '_blank')}>
                    📊 Análisis Multi-Combo Excel
                  </button>
                </>
              : <button className="run-btn" onClick={handleRun} disabled={isLoading || !dbStatus?.connected}>
                  {loading ? <><span className="spinner" /> Procesando...</> : '▶ Ejecutar Backtest'}
                </button>
            }
            {error && <div className="error-box">⚠️ {error}</div>}
          </div>
        </aside>

        {/* ── PANEL DERECHO: RESULTADOS ── */}
        <main className="main">
          {!result && !wfResult && !isLoading && (
            <div className="empty-state">
              <div className="empty-icon">₿</div>
              <div className="empty-title">Listo para backtestear</div>
              <div className="empty-sub">Configura los parámetros y ejecuta el backtest para ver los resultados</div>
            </div>
          )}

          {isLoading && (
            <div className="empty-state">
              <div className="loading-ring" />
              <div className="empty-title">
                {wfLoading ? 'Walk-Forward en progreso...' : 'Analizando velas...'}
              </div>
              <div className="empty-sub">
                {wfLoading
                  ? `Optimizando día a día · ${wfTrainingDays} días de entrenamiento`
                  : 'Ejecutando la lógica del indicador sobre tu base de datos'}
              </div>
              {wfProgress && (
                <div className="progress-wrap">
                  <div className="progress-track">
                    <div className="progress-fill wf-fill"
                      style={{ width: `${Math.round(wfProgress.day / wfProgress.totalDays * 100)}%` }} />
                  </div>
                  <div className="progress-label">
                    Día {wfProgress.day.toLocaleString()} / {wfProgress.totalDays.toLocaleString()}
                    {' · '}{Math.round(wfProgress.day / wfProgress.totalDays * 100)}%
                  </div>
                </div>
              )}
            </div>
          )}

          {(result || wfResult) && !isLoading && (
            <>
              <div className="result-header">
                <div className="result-meta">
                  {(result || wfResult) && <><span>📊 {(result || wfResult).totalCandles.toLocaleString()} velas</span><span>·</span></>}
                  <span>{params.dateFrom} → {params.dateTo}</span>
                </div>
                <div className="tabs">
                  {result && <>
                    <button className={activeTab === 'stats'   ? 'tab active' : 'tab'} onClick={() => setActiveTab('stats')}>Estadísticas</button>
                    <button className={activeTab === 'trades'  ? 'tab active' : 'tab'} onClick={() => setActiveTab('trades')}>Trades ({result.trades.length})</button>
                    <button className={activeTab === 'signals' ? 'tab active' : 'tab'} onClick={() => setActiveTab('signals')}>Señales ({result.signals.length})</button>
                    {result.debugLog && <button className="tab" onClick={handleDownloadDebug} title="Descargar log de condiciones por vela">⬇ Debug</button>}
                  </>}
                  {wfResult && (
                    <button className={activeTab === 'wf' ? 'tab active tab-wf' : 'tab tab-wf'} onClick={() => setActiveTab('wf')}>
                      📈 Walk-Forward
                    </button>
                  )}
                </div>
              </div>

              {activeTab === 'stats' && result && (
                <>
                  <div className="stats-grid">
                    <StatCard label="Trades cerrados" value={stats.totalClosed} variant="neutral" />
                    <StatCard label="TP ✅" value={stats.totalTp} variant="win" />
                    <StatCard label="SL ❌" value={stats.totalSl} variant="loss" />
                    <StatCard label="Win Rate" value={`${stats.winRate}%`} variant={winRate >= 50 ? 'win' : 'loss'} />
                    <StatCard label={`Ganancia acum. x${params.leverage}`} value={`${stats.totalProfitPct}%`} variant="win" />
                    <StatCard label={`Pérdida acum. x${params.leverage}`} value={`${stats.totalLossPct}%`} variant="loss" />
                    <StatCard label={`Neto simple x${params.leverage}`} value={`${stats.totalNetPct}%`} variant={netPct >= 0 ? 'win' : 'loss'} />
                    <StatCard label="Máx. Drawdown" value={`${stats.maxDrawdownPct}%`} variant="warn" />
                    <StatCard label="Capital simple" value={`$${parseFloat(stats.simpleCapital).toLocaleString('es-CO', {minimumFractionDigits: 2})}`} variant="neutral" />
                    <StatCard label={params.monthlyContribution > 0 ? 'Capital compuesto (+ aportes)' : 'Capital compuesto'} value={`$${parseFloat(stats.compoundCapital).toLocaleString('es-CO', {minimumFractionDigits: 2})}`} variant="accent" />
                    {params.monthlyContribution > 0 && <StatCard label="Total aportado" value={`$${parseFloat(stats.totalContributed).toLocaleString('es-CO', {minimumFractionDigits: 2})}`} variant="neutral" />}
                    <StatCard label="Mejor método" value={stats.bestMethod} variant="accent" />
                    {!result.isMulti && <StatCard label={`TP efectivo x${params.leverage}`} value={`${stats.effectiveTpPct}%`} variant="neutral" />}
                    {!result.isMulti && <StatCard label={`SL efectivo x${params.leverage}`} value={`${stats.effectiveSlPct}%`} variant="neutral" />}
                    {result.isMulti && <StatCard label="Combos activos" value={multiCombos.length} variant="neutral" />}
                  </div>

                  {result.trades.length > 0 && (() => {
                    const effTp = parseFloat(stats.effectiveTpPct || 0)
                    const effSl = parseFloat(stats.effectiveSlPct || 0)
                    const { byYear, byMonth, byCombo } = computePeriodStats(result.trades, effTp, effSl)
                    return <>
                      {result.isMulti && <PeriodTable title="🎯 Acumulado por combo" rows={byCombo} />}
                      <PeriodTable title="📅 Acumulado por año" rows={byYear} />
                      <PeriodTable title="📆 Acumulado por mes" rows={byMonth} />
                    </>
                  })()}

                  {stats.totalTp > 0 && (
                    <div className="mae-section">
                      <div className="mae-title">📏 MAE — Excursión Adversa Máxima en trades TP</div>
                      <div className="mae-subtitle">Cuánto subió el precio desde la entrada antes de revertir al TP (para calibrar Trailing SL)</div>
                      <div className="stats-grid" style={{marginTop: 12, marginBottom: 16}}>
                        <StatCard label="MAE Promedio" value={`${stats.maeAvgTp}%`} variant="neutral" />
                        <StatCard label="MAE Mediana" value={`${stats.maeMedianTp}%`} variant="neutral" />
                        <StatCard label="MAE Máximo" value={`${stats.maeMaxTp}%`} variant="warn" />
                      </div>
                      <div className="mae-dist">
                        {stats.maeDist.map((b, i) => (
                          <div key={i} className="mae-bucket">
                            <span className="mae-range">
                              {b.to === Infinity ? `> ${b.from}%` : `${b.from}–${b.to}%`}
                            </span>
                            <div className="mae-bar-wrap">
                              <div className="mae-bar" style={{width: stats.totalTp > 0 ? `${b.count / stats.totalTp * 100}%` : '0%'}} />
                            </div>
                            <span className="mae-count">{b.count}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )}

              {activeTab === 'trades' && result && (
                <div className="table-wrap">
                  {result.trades.length === 0
                    ? <div className="empty-table">No se cerraron trades en este período</div>
                    : (
                      <table className="data-table">
                        <thead>
                          <tr>
                            <th>#</th><th></th>
                            {result.isMulti && <th>Combo</th>}
                            <th>Señal</th><th>Entrada</th><th>TP precio</th><th>SL precio</th><th>Cierre</th><th>Resultado</th><th>Capital entrada</th><th>Capital salida</th>
                          </tr>
                        </thead>
                        <tbody>
                          {result.trades.map((t, i) => (
                            <tr key={i} className={t.result === 'TP' ? 'row-win' : 'row-loss'}>
                              <td>{i + 1}</td>
                              <td><button className="eye-btn" onClick={() => setTradeModal({ trade: t, candles: result.candles })} title="Ver gráfico">👁</button></td>
                              {result.isMulti && <td style={{color:'var(--accent)', fontFamily:'var(--font-mono)', fontSize:11}}>{t.comboLabel}</td>}
                              <td>{new Date(t.time).toLocaleString('es-CO', { timeZone: 'UTC' })}</td>
                              <td>${parseFloat(t.price).toLocaleString('en-US')}</td>
                              <td className="tp-cell">${parseFloat(t.tp).toLocaleString('en-US')}</td>
                              <td className="sl-cell">${parseFloat(t.sl).toLocaleString('en-US')}</td>
                              <td>{new Date(t.closeTime).toLocaleString('es-CO', { timeZone: 'UTC' })}</td>
                              <td><span className={`badge badge-${t.result.toLowerCase()}`}>{t.result === 'TP' ? '✅ TP' : '❌ SL'}</span></td>
                              <td>${parseFloat(t.capitalAtEntry).toLocaleString('es-CO', {minimumFractionDigits: 2, maximumFractionDigits: 2})}</td>
                              <td className={t.result === 'TP' ? 'tp-cell' : 'sl-cell'}>${parseFloat(t.capitalAtExit).toLocaleString('es-CO', {minimumFractionDigits: 2, maximumFractionDigits: 2})}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )
                  }
                </div>
              )}

              {activeTab === 'signals' && result && (
                <div className="table-wrap">
                  {result.signals.length === 0
                    ? <div className="empty-table">No se generaron señales en este período</div>
                    : (
                      <table className="data-table">
                        <thead>
                          <tr>
                            <th>#</th>
                            {result.isMulti && <th>Combo</th>}
                            <th>Fecha señal</th><th>Precio entrada</th><th>Rango %</th><th>Mecha sup %</th><th>TP</th><th>SL</th>
                          </tr>
                        </thead>
                        <tbody>
                          {result.signals.map((s, i) => (
                            <tr key={i}>
                              <td>{i + 1}</td>
                              {result.isMulti && <td style={{color:'var(--accent)', fontFamily:'var(--font-mono)', fontSize:11}}>{s.comboLabel}</td>}
                              <td>{new Date(s.time).toLocaleString('es-CO', { timeZone: 'UTC' })}</td>
                              <td>${parseFloat(s.price).toLocaleString('en-US')}</td>
                              <td>{s.rangePct}%</td>
                              <td>{s.upperWickPct}%</td>
                              <td className="tp-cell">${parseFloat(s.tp).toLocaleString('en-US')}</td>
                              <td className="sl-cell">${parseFloat(s.sl).toLocaleString('en-US')}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )
                  }
                </div>
              )}

              {activeTab === 'wf' && wfResult && (() => {
                const ws = wfResult.stats
                const wn = parseFloat(ws.totalNetPct)
                const ww = parseFloat(ws.winRate)
                return (
                  <>
                    <div className="wf-note">
                      Entrenamiento: <strong>{ws.trainingDays} días</strong> · Días operados: <strong>{ws.tradingDays}</strong> · Cada día usó los mejores parámetros de los {ws.trainingDays} días anteriores
                    </div>
                    <div className="stats-grid" style={{marginBottom: 24}}>
                      <StatCard label="Trades cerrados" value={ws.totalClosed} variant="neutral" />
                      <StatCard label="TP ✅" value={ws.totalTp} variant="win" />
                      <StatCard label="SL ❌" value={ws.totalSl} variant="loss" />
                      <StatCard label="Win Rate" value={`${ws.winRate}%`} variant={ww >= 50 ? 'win' : 'loss'} />
                      <StatCard label={`Ganancia acum. x${params.leverage}`} value={`${ws.totalProfitPct}%`} variant="win" />
                      <StatCard label={`Pérdida acum. x${params.leverage}`} value={`${ws.totalLossPct}%`} variant="loss" />
                      <StatCard label={`Neto x${params.leverage}`} value={`${ws.totalNetPct}%`} variant={wn >= 0 ? 'win' : 'loss'} />
                      <StatCard label="Máx. Drawdown" value={`${ws.maxDrawdownPct}%`} variant="warn" />
                      <StatCard label="Capital simple" value={`$${parseFloat(ws.simpleCapital).toLocaleString('es-CO', {minimumFractionDigits: 2})}`} variant="neutral" />
                      <StatCard label={params.monthlyContribution > 0 ? 'Capital compuesto (+ aportes)' : 'Capital compuesto'} value={`$${parseFloat(ws.compoundCapital).toLocaleString('es-CO', {minimumFractionDigits: 2})}`} variant="accent" />
                      {params.monthlyContribution > 0 && <StatCard label="Total aportado" value={`$${parseFloat(ws.totalContributed).toLocaleString('es-CO', {minimumFractionDigits: 2})}`} variant="neutral" />}
                    </div>
                    <div className="table-wrap">
                      <table className="data-table">
                        <thead>
                          <tr>
                            <th>Día</th><th>Min%</th><th>Max%</th><th>LB</th><th>Mecha%</th><th>SL%</th><th>TP%</th>
                            <th>Trades</th><th>TP</th><th>SL</th><th>Net%</th>
                          </tr>
                        </thead>
                        <tbody>
                          {wfResult.dayLog.map((row, i) => (
                            <tr key={i} className={parseFloat(row.netPct) > 0 ? 'row-win' : parseFloat(row.netPct) < 0 ? 'row-loss' : ''}>
                              <td>{row.day}</td>
                              {row.bestParams ? <>
                                <td>{row.bestParams.minRangePct}</td>
                                <td>{row.bestParams.maxRangePct}</td>
                                <td>{row.bestParams.lookbackCandles}</td>
                                <td>{row.bestParams.minWickPct}</td>
                                <td>{row.bestParams.slPct}</td>
                                <td>{row.bestParams.tpPct}</td>
                              </> : <td colSpan={6} style={{color:'var(--text-muted)'}}>Sin combinación válida</td>}
                              <td>{row.totalTrades}</td>
                              <td className={row.tp > 0 ? 'tp-cell' : ''}>{row.tp}</td>
                              <td className={row.sl > 0 ? 'sl-cell' : ''}>{row.sl}</td>
                              <td className={parseFloat(row.netPct) >= 0 ? 'tp-cell' : 'sl-cell'}>{row.netPct}%</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </>
                )
              })()}

            </>
          )}
        </main>
      </div>

      {tradeModal && (
        <TradeModal
          trade={tradeModal.trade}
          candles={tradeModal.candles}
          onClose={() => setTradeModal(null)}
        />
      )}
    </div>
  )
}

function ExcelOptimView() {
  const [combos, setCombos]         = useState([])
  const [fileName, setFileName]     = useState('')
  const [candles, setCandles]       = useState(null)
  const [status, setStatus]         = useState('idle')
  const [progress, setProgress]     = useState(null)
  const [ranking, setRanking]       = useState([])
  const [errorMsg, setErrorMsg]     = useState('')
  const [dateFrom, setDateFrom]     = useState('2022-01-01')
  const [dateTo, setDateTo]         = useState(new Date().toISOString().split('T')[0])
  const [params, setParams]         = useState({ feeSlPct: 0.10, feeTpPct: 0.05, leverage: 10, initialCapital: 1000, emaMinGapPct: 0 })
  const [sortKey, setSortKey]       = useState('_score')
  const [sortDir, setSortDir]       = useState('desc')
  const [showCombos, setShowCombos] = useState(false)
  const [minTrades, setMinTrades]   = useState(0)
  const [maxTrades, setMaxTrades]   = useState(9999)
  const startTimeRef  = useRef(null)
  const workerRef     = useRef(null)
  const fileInputRef  = useRef(null)

  function parseNum(v) {
    if (typeof v === 'number') return v
    if (typeof v === 'string') return parseFloat(v.replace(',', '.'))
    return NaN
  }

  function handleFile(e) {
    const file = e.target.files[0]
    if (!file) return
    setFileName(file.name)
    const reader = new FileReader()
    reader.onload = (ev) => {
      const wb = XLSX.read(ev.target.result, { type: 'array' })
      const ws = wb.Sheets[wb.SheetNames[0]]
      const rows = XLSX.utils.sheet_to_json(ws, { defval: '' })
      const parsed = rows.map(row => ({
        minRangePct:     parseNum(row['Min%']    ?? row['minRangePct']  ?? row['MinRange%']),
        maxRangePct:     parseNum(row['Max%']    ?? row['maxRangePct']  ?? row['MaxRange%']),
        lookbackCandles: Math.round(parseNum(row['LB'] ?? row['lookbackCandles'] ?? row['Lookback'])),
        minWickPct:      parseNum(row['Mecha%']  ?? row['minWickPct']  ?? row['Wick%']),
        slPct:           parseNum(row['SL%']     ?? row['slPct']),
        tpPct:           parseNum(row['TP%']     ?? row['tpPct']),
        _score:          parseNum(row['Score']   ?? row['_score'] ?? 0),
      })).filter(c =>
        !isNaN(c.minRangePct) && !isNaN(c.maxRangePct) &&
        !isNaN(c.lookbackCandles) && !isNaN(c.minWickPct) &&
        !isNaN(c.slPct) && !isNaN(c.tpPct)
      )
      setCombos(parsed)
      setRanking([])
      setStatus('idle')
    }
    reader.readAsArrayBuffer(file)
  }

  async function handleLoadCandles() {
    setStatus('loadingCandles')
    setErrorMsg('')
    try {
      const res = await fetch(`http://localhost:3001/api/candles?from=${dateFrom}&to=${dateTo}`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Error cargando velas')
      setCandles(data.candles)
      setStatus('idle')
    } catch (err) {
      setErrorMsg(err.message)
      setStatus('error')
    }
  }

  function handleRun() {
    if (!candles || combos.length < 3) return
    workerRef.current?.terminate()
    setStatus('running')
    setRanking([])
    setProgress(null)
    startTimeRef.current = Date.now()

    const worker = new Worker(new URL('./excelMultiWorker.js', import.meta.url), { type: 'module' })
    workerRef.current = worker
    worker.onmessage = (ev) => {
      const m = ev.data
      if (m.type === 'progress') {
        const elapsed = Date.now() - startTimeRef.current
        let eta = null
        if (m.done >= 50 && elapsed >= 500) eta = Math.round((m.total - m.done) / (m.done / elapsed))
        setProgress({ done: m.done, total: m.total, eta })
        if (m.topResults?.length > 0) setRanking(m.topResults)
      } else if (m.type === 'done') {
        setStatus('done')
        setProgress(p => p ? { ...p, done: p.total } : null)
        if (m.results?.length > 0) setRanking(m.results)
        worker.terminate()
      } else if (m.type === 'error') {
        setErrorMsg(m.message)
        setStatus('error')
        worker.terminate()
      }
    }
    worker.onerror = (ev) => { setErrorMsg(ev.message); setStatus('error'); worker.terminate() }
    worker.postMessage({ combos, candles, params, groupSizes: [3,4,5,6,7,8,9,10,11,12,13,14,15], samplesPerSize: 5000 })
  }

  function handleSort(key) {
    if (sortKey === key) setSortDir(d => d === 'desc' ? 'asc' : 'desc')
    else { setSortKey(key); setSortDir('desc') }
  }

  const sortedRanking = useMemo(() => {
    if (!ranking.length) return []
    return [...ranking]
      .filter(r => {
        const tc = parseInt(r.totalClosed)
        return tc >= minTrades && tc <= maxTrades
      })
      .sort((a, b) => {
        const av = parseFloat(a[sortKey] ?? 0)
        const bv = parseFloat(b[sortKey] ?? 0)
        return sortDir === 'desc' ? bv - av : av - bv
      })
  }, [ranking, sortKey, sortDir, minTrades, maxTrades])

  function fmtEta(ms) {
    if (!ms) return ''
    const s = Math.round(ms / 1000)
    return s < 60 ? `~${s}s` : `~${Math.floor(s/60)}m ${s%60}s`
  }

  function SortTh({ col, label }) {
    const active = sortKey === col
    return (
      <th onClick={() => handleSort(col)}
        style={{cursor:'pointer', userSelect:'none', color: active ? 'var(--accent)' : undefined, whiteSpace:'nowrap'}}>
        {label}{' '}{active
          ? (sortDir === 'desc' ? '▼' : '▲')
          : <span style={{opacity:0.25}}>▼</span>}
      </th>
    )
  }

  function comboLabel(c) {
    return `Min${c.minRangePct} Max${c.maxRangePct} LB${c.lookbackCandles} W${c.minWickPct} SL${c.slPct} TP${c.tpPct}`
  }

  const pct = progress ? Math.round(progress.done / progress.total * 100) : 0
  const isRunning       = status === 'running'
  const isLoadingCandles = status === 'loadingCandles'
  const canRun = candles && combos.length >= 3 && !isRunning && !isLoadingCandles

  const inputStyle = { width:'100%', background:'var(--bg)', border:'1px solid var(--border)', borderRadius:'var(--radius)', color:'var(--text)', padding:'7px 10px', fontFamily:'var(--font-mono)', fontSize:13 }

  return (
    <div className="optim-page">

      {/* ── Header ── */}
      <header className="optim-page-header">
        <div className="logo">
          <span className="logo-icon">₿</span>
          <div>
            <div className="logo-title">MariaPaz<span style={{color:'var(--accent)'}}>Indicator</span></div>
            <div className="logo-sub">📊 Análisis Multi-Combo · Desde Excel</div>
          </div>
        </div>
        <div className="optim-page-status">
          {status === 'idle' && combos.length === 0 && 'Carga un archivo Excel para comenzar'}
          {status === 'idle' && combos.length > 0 && !candles && `${combos.length} combos cargados · Carga velas para continuar`}
          {status === 'idle' && combos.length > 0 && candles && `${combos.length} combos · ${candles.length.toLocaleString()} velas · Listo`}
          {isLoadingCandles && 'Cargando velas desde BD...'}
          {isRunning && progress && (
            <span>
              {progress.done.toLocaleString()} / {progress.total.toLocaleString()} · {pct}%
              {progress.eta != null && ` · faltan ${fmtEta(progress.eta)}`}
              {' · '}{ranking.length} grupos
            </span>
          )}
          {status === 'done' && <span style={{color:'var(--green)'}}>✅ Completado · {ranking.length} grupos</span>}
          {status === 'error' && <span style={{color:'var(--red)'}}>⚠️ {errorMsg}</span>}
        </div>
      </header>

      {/* ── Barra de progreso ── */}
      {(isRunning || status === 'done') && progress && (
        <div className="optim-page-progress">
          <div className="progress-track" style={{borderRadius:0, height:3}}>
            <div className="progress-fill" style={{width:`${pct}%`, transition:'width 0.5s ease'}}/>
          </div>
        </div>
      )}

      <div className="optim-page-body">

        {/* ── Panel de configuración ── */}
        <div style={{background:'var(--bg-2)', border:'1px solid var(--border)', borderRadius:'var(--radius-lg)', padding:'20px 24px', marginBottom:20}}>
          <div style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap:24}}>

            {/* Columna izquierda: archivo + fechas + botón cargar */}
            <div style={{display:'flex', flexDirection:'column', gap:14}}>
              <div>
                <div className="optim-label" style={{marginBottom:6}}>Archivo Excel</div>
                <input ref={fileInputRef} type="file" accept=".xlsx,.xls" onChange={handleFile} style={{display:'none'}}/>
                <div style={{display:'flex', alignItems:'center', gap:10}}>
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    style={{...inputStyle, width:'auto', padding:'7px 14px', cursor:'pointer', background:'var(--bg-3)', fontFamily:'var(--font-ui)', fontWeight:600, fontSize:13, border:'1px solid var(--border-light)'}}>
                    📂 Seleccionar archivo
                  </button>
                  {fileName
                    ? <div style={{fontSize:12, fontFamily:'var(--font-mono)', lineHeight:1.4}}>
                        <div style={{color:'var(--green)'}}>✓ {fileName}</div>
                        <div style={{color:'var(--text-muted)'}}>{combos.length} combos válidos</div>
                      </div>
                    : <span style={{fontSize:12, color:'var(--text-muted)', fontFamily:'var(--font-mono)'}}>Sin archivo seleccionado</span>
                  }
                </div>
              </div>
              <div style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap:10}}>
                <div>
                  <div className="optim-label" style={{marginBottom:4}}>Desde</div>
                  <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} style={inputStyle}/>
                </div>
                <div>
                  <div className="optim-label" style={{marginBottom:4}}>Hasta</div>
                  <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} style={inputStyle}/>
                </div>
              </div>
              <button className="run-btn" style={{padding:'9px'}} onClick={handleLoadCandles} disabled={isLoadingCandles || isRunning}>
                {isLoadingCandles ? <><span className="spinner"/> Cargando velas...</> : '📥 Cargar velas desde BD'}
              </button>
            </div>

            {/* Columna derecha: params + botón ejecutar */}
            <div style={{display:'flex', flexDirection:'column', gap:14}}>
              <div style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap:10}}>
                {[['Fee SL%','feeSlPct',0.01],['Fee TP%','feeTpPct',0.01],['Apalancamiento','leverage',1],['Capital inicial $','initialCapital',100],['Dist. EMA mín %','emaMinGapPct',0.01]].map(([label, key, step]) => (
                  <div key={key}>
                    <div className="optim-label" style={{marginBottom:4}}>{label}</div>
                    <input type="number" step={step} value={params[key]}
                      onChange={e => setParams(p => ({...p, [key]: parseFloat(e.target.value)}))}
                      style={inputStyle}/>
                  </div>
                ))}
              </div>
              <div style={{marginTop:'auto'}}>
                {status === 'error' && (
                  <div style={{marginBottom:8, padding:'8px 12px', background:'var(--red-dim)', border:'1px solid rgba(239,68,68,0.3)', borderRadius:'var(--radius)', fontSize:12, color:'var(--red)', fontFamily:'var(--font-mono)'}}>
                    ⚠️ {errorMsg}
                  </div>
                )}
                <button className="run-btn optim-btn" style={{width:'100%', padding:11}} onClick={handleRun} disabled={!canRun}>
                  {isRunning
                    ? <><span className="spinner"/> Analizando grupos de 3–15 combos...</>
                    : `🎲 Buscar mejores combinaciones (${combos.length} combos)`}
                </button>
                <div style={{fontSize:11, color:'var(--text-muted)', textAlign:'center', marginTop:6, fontFamily:'var(--font-mono)'}}>
                  Grupos de 3 al 15 combos · 5 000 muestras por tamaño · drawdown ≤ 50%
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* ── Vista previa de combos ── */}
        {combos.length > 0 && (
          <div style={{marginBottom:16}}>
            <button onClick={() => setShowCombos(v => !v)}
              style={{background:'none', border:'none', color:'var(--text-muted)', fontSize:12, fontFamily:'var(--font-mono)', cursor:'pointer', padding:'4px 0', display:'flex', alignItems:'center', gap:6}}>
              {showCombos ? '▼' : '▶'} Ver combos cargados ({combos.length})
            </button>
            {showCombos && (
              <div className="table-wrap" style={{marginTop:8}}>
                <table className="data-table">
                  <thead>
                    <tr><th>#</th><th>Min%</th><th>Max%</th><th>LB</th><th>Mecha%</th><th>SL%</th><th>TP%</th><th>Score</th></tr>
                  </thead>
                  <tbody>
                    {combos.map((c, i) => (
                      <tr key={i}>
                        <td style={{color:'var(--text-muted)'}}>{i+1}</td>
                        <td>{c.minRangePct}</td><td>{c.maxRangePct}</td>
                        <td>{c.lookbackCandles}</td><td>{c.minWickPct}</td>
                        <td>{c.slPct}</td><td>{c.tpPct}</td>
                        <td style={{color:'var(--accent)', fontWeight:600}}>{c._score.toFixed(1)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* ── Tabla de resultados ── */}
        {ranking.length > 0 && (
          <>
            <div className="optim-rank-meta" style={{display:'flex', alignItems:'center', justifyContent:'space-between', flexWrap:'wrap', gap:10}}>
              <span>{sortedRanking.length} / {ranking.length} grupos · Score = Neto% ÷ Drawdown% · drawdown ≤ 50%{isRunning && ' · actualizando en vivo...'}</span>
              <div style={{display:'flex', alignItems:'center', gap:8, fontSize:12, fontFamily:'var(--font-mono)'}}>
                <span style={{color:'var(--text-muted)'}}>Trades:</span>
                <input type="number" min={0} value={minTrades} onChange={e => setMinTrades(Math.max(0, parseInt(e.target.value) || 0))}
                  style={{width:60, background:'var(--bg)', border:'1px solid var(--border)', borderRadius:'var(--radius)', color:'var(--text)', padding:'3px 7px', fontFamily:'var(--font-mono)', fontSize:12, textAlign:'center'}}
                  title="Mínimo de trades"/>
                <span style={{color:'var(--text-muted)'}}>–</span>
                <input type="number" min={0} value={maxTrades} onChange={e => setMaxTrades(Math.max(0, parseInt(e.target.value) || 9999))}
                  style={{width:60, background:'var(--bg)', border:'1px solid var(--border)', borderRadius:'var(--radius)', color:'var(--text)', padding:'3px 7px', fontFamily:'var(--font-mono)', fontSize:12, textAlign:'center'}}
                  title="Máximo de trades"/>
              </div>
            </div>
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <SortTh col="_score"          label="Score"/>
                    <SortTh col="size"            label="Combos"/>
                    <th>Parámetros</th>
                    <SortTh col="totalClosed"     label="Trades"/>
                    <SortTh col="winRate"         label="Win%"/>
                    <SortTh col="totalNetPct"     label="Neto%"/>
                    <SortTh col="maxDrawdownPct"  label="Drawdown%"/>
                    <SortTh col="compoundCapital" label="Capital $"/>
                  </tr>
                </thead>
                <tbody>
                  {sortedRanking.map((r, i) => {
                    const net = parseFloat(r.totalNetPct)
                    const dd  = parseFloat(r.maxDrawdownPct)
                    const sizeColors = { 3:['var(--blue-dim)','var(--blue)'], 4:['var(--green-dim)','var(--green)'], 5:['var(--accent-dim)','var(--accent)'], 6:['var(--orange-dim)','var(--orange)'], 7:['var(--red-dim)','var(--red)'] }
                    const [bgC, fgC] = sizeColors[r.size] ?? ['var(--bg-3)','var(--text)']
                    return (
                      <tr key={i} className="row-win">
                        <td style={{color:'var(--text-muted)'}}>{i+1}</td>
                        <td style={{color:'var(--accent)', fontWeight:700}}>{r._score.toFixed(2)}</td>
                        <td style={{textAlign:'center'}}>
                          <span style={{padding:'2px 10px', borderRadius:20, fontSize:11, fontWeight:600, background:bgC, color:fgC}}>{r.size}</span>
                        </td>
                        <td style={{fontSize:10, lineHeight:1.8}}>
                          {r.combos.map((c, ci) => (
                            <div key={ci} style={{whiteSpace:'nowrap'}}>
                              <span style={{color:'var(--text-muted)', marginRight:5}}>#{c.idx+1}</span>
                              <span style={{color:'var(--text-dim)'}}>{comboLabel(c)}</span>
                            </div>
                          ))}
                        </td>
                        <td>{r.totalClosed}</td>
                        <td>{r.winRate}%</td>
                        <td className={net >= 0 ? 'tp-cell' : 'sl-cell'}>{r.totalNetPct}%</td>
                        <td className={dd > 30 ? 'sl-cell' : ''}>{r.maxDrawdownPct}%</td>
                        <td style={{fontWeight:600}}>
                          ${parseFloat(r.compoundCapital).toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2})}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}

      </div>
    </div>
  )
}

function SarView() {
  const [params, setParams]   = useState(DEFAULT_SAR_PARAMS)
  const [result, setResult]   = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError]     = useState(null)
  const [dbStatus, setDbStatus] = useState(null)
  const [activeTab, setActiveTab] = useState('stats')

  // Optimización
  const [optimMode, setOptimMode] = useState(false)
  const [optimRanges, setOptimRanges] = useState(DEFAULT_SAR_OPTIM)
  const optimBcRef = useRef(null)

  const estimatedCombos = useMemo(() => countSARCombinations(optimRanges), [optimRanges])

  useEffect(() => {
    fetch('/api/status')
      .then(r => r.json())
      .then(d => setDbStatus(d))
      .catch(() => setDbStatus({ connected: false, error: 'No se pudo conectar al servidor' }))
  }, [])

  const set = (key, val) => setParams(p => ({ ...p, [key]: val }))
  const num = (key, val) => set(key, parseFloat(val) || 0)
  const int = (key, val) => set(key, parseInt(val)   || 1)

  const setOptimField = (field, key, val) =>
    setOptimRanges(r => ({ ...r, [field]: { ...r[field], [key]: parseFloat(val) || 0 } }))

  function applyOptimResult(row) {
    setParams(p => ({
      ...p,
      sarStart: row.sarStart,
      sarInc:   row.sarInc,
      sarMax:   row.sarMax,
      pivotLr:  row.pivotLr,
      tpPct:    row.tpPct,
      slPct:    row.slPct,
    }))
  }

  async function handleRun() {
    setLoading(true); setError(null); setResult(null)
    try {
      const resp = await fetch(`/api/candles?from=${params.dateFrom}&to=${params.dateTo}`)
      if (!resp.ok) throw new Error((await resp.json()).error)
      const { candles, total } = await resp.json()
      if (total === 0) throw new Error('No se encontraron velas en ese rango de fechas.')
      const bt = runSARBacktest(candles, params)
      if (!bt) throw new Error('No se pudieron calcular resultados.')
      setResult(bt)
      setActiveTab('stats')
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  async function handleOptimize() {
    setError(null)
    try {
      const resp = await fetch(`/api/candles?from=${params.dateFrom}&to=${params.dateTo}`)
      if (!resp.ok) throw new Error((await resp.json()).error)
      const { candles, total } = await resp.json()
      if (total === 0) throw new Error('No se encontraron velas en ese rango de fechas.')

      if (optimBcRef.current) optimBcRef.current.close()
      const bc = new BroadcastChannel('btc-sar-optim')
      optimBcRef.current = bc

      bc.onmessage = (e) => {
        if (e.data.type === 'ready') {
          bc.postMessage({ type: 'init', candles, optimRanges, params })
        } else if (e.data.type === 'apply') {
          applyOptimResult(e.data.row)
        }
      }

      window.open(window.location.pathname + '?strategy=sar&mode=optim', '_blank')
    } catch (e) {
      setError(e.message)
    }
  }

  const stats   = result?.stats
  const winRate = stats ? parseFloat(stats.winRate)      : 0
  const netPct  = stats ? parseFloat(stats.totalNetPct)  : 0

  return (
    <div className="app">
      <header className="header">
        <div className="header-inner">
          <div className="logo">
            <span className="logo-icon">₿</span>
            <div>
              <div className="logo-title">MariaPaz<span style={{color:'var(--accent)'}}>Indicator</span></div>
              <div className="logo-sub">SAR Riesgo Medio-Alto · BTCUSDC · 15m</div>
            </div>
          </div>
          <div className={`db-badge ${dbStatus?.connected ? 'connected' : 'disconnected'}`}>
            <span className="db-dot" />
            {dbStatus?.connected
              ? `BD conectada · ${dbStatus.totalCandles?.toLocaleString()} velas`
              : dbStatus?.error ?? 'Conectando...'}
          </div>
        </div>
        <div className="strategy-nav">
          <button className="strategy-tab" onClick={() => { window.location.href = '/' }}>📐 Rango + Resistencias</button>
          <button className="strategy-tab active">📈 SAR</button>
          <button className="strategy-tab" onClick={() => { window.location.href = '?strategy=supertrend' }}>📊 Supertrend</button>
          <button className="strategy-tab" onClick={() => { window.location.href = '?strategy=confluence' }}>🎯 Confluencia</button>
          <button className="strategy-tab" onClick={() => { window.location.href = '?strategy=emapullback' }}>📉 EMA Pullback</button>
          <button className="strategy-tab" onClick={() => { window.location.href = '?strategy=pinbar' }}>🕯️ Pin Bar</button>
          <button className="strategy-tab" onClick={() => { window.location.href = '?strategy=soporte' }}>📗 Rango + Soporte</button>
          <button className="strategy-tab" onClick={() => { window.location.href = '?strategy=ema' }}>📡 EMA Touch</button>
          <button className="strategy-tab" onClick={() => { window.location.href = '?strategy=rangehigh' }}>🏔️ Rango Alto</button>
        </div>
      </header>

      <div className="layout">
        {/* ── SIDEBAR ── */}
        <aside className="sidebar">
          <div className="sidebar-scroll">

            <Section title="📅 Rango de fechas">
              <InputGroup label="Desde">
                <input type="date" value={params.dateFrom} onChange={e => set('dateFrom', e.target.value)} />
              </InputGroup>
              <InputGroup label="Hasta">
                <input type="date" value={params.dateTo}   onChange={e => set('dateTo',   e.target.value)} />
              </InputGroup>
            </Section>

            <Section title="📈 Parabolic SAR">
              <InputGroup label="Start"     tooltip="Factor de aceleración inicial">
                <input type="number" value={params.sarStart} step="0.001" min="0.001" onChange={e => num('sarStart', e.target.value)} />
              </InputGroup>
              <InputGroup label="Increment" tooltip="Incremento del AF por cada nuevo EP">
                <input type="number" value={params.sarInc}   step="0.001" min="0.001" onChange={e => num('sarInc',   e.target.value)} />
              </InputGroup>
              <InputGroup label="Max"       tooltip="Factor de aceleración máximo">
                <input type="number" value={params.sarMax}   step="0.01"  min="0.01"  onChange={e => num('sarMax',   e.target.value)} />
              </InputGroup>
            </Section>

            <Section title="📊 Estructura (HH/HL)">
              <InputGroup label="Barras pivote (izq/der)" tooltip="Barras a cada lado para confirmar un pivote">
                <input type="number" value={params.pivotLr} step="1" min="1" max="10" onChange={e => int('pivotLr', e.target.value)} />
              </InputGroup>
            </Section>

            <Section title="💰 TP / SL">
              <InputGroup label="TP (%)">
                <input type="number" value={params.tpPct}    step="0.01" min="0.01" onChange={e => num('tpPct',    e.target.value)} />
              </InputGroup>
              <InputGroup label="SL (%)">
                <input type="number" value={params.slPct}    step="0.01" min="0.01" onChange={e => num('slPct',    e.target.value)} />
              </InputGroup>
              <InputGroup label="Fee extra SL (%)">
                <input type="number" value={params.feeSlPct} step="0.01" min="0"    onChange={e => num('feeSlPct', e.target.value)} />
              </InputGroup>
              <InputGroup label="Fee descontado TP (%)">
                <input type="number" value={params.feeTpPct} step="0.01" min="0"    onChange={e => num('feeTpPct', e.target.value)} />
              </InputGroup>
              <InputGroup label="Apalancamiento">
                <input type="number" value={params.leverage}       step="1"   min="1" onChange={e => num('leverage',       e.target.value)} />
              </InputGroup>
              <InputGroup label="Capital inicial ($)">
                <input type="number" value={params.initialCapital} step="100" min="1" onChange={e => num('initialCapital', e.target.value)} />
              </InputGroup>
            </Section>

            <Section title="🔘 Filtros">
              <InputGroup label="Filtro estructura HH/HL">
                <label className="toggle">
                  <input type="checkbox" checked={params.useTrendFilter} onChange={e => set('useTrendFilter', e.target.checked)} />
                  <span className="toggle-track"><span className="toggle-thumb" /></span>
                </label>
              </InputGroup>
              <InputGroup label="Excluir domingos">
                <label className="toggle">
                  <input type="checkbox" checked={params.skipSundays} onChange={e => set('skipSundays', e.target.checked)} />
                  <span className="toggle-track"><span className="toggle-thumb" /></span>
                </label>
              </InputGroup>
            </Section>

            <Section title="🔬 Análisis Profundo">
              <InputGroup label="Activar optimización">
                <label className="toggle">
                  <input type="checkbox" checked={optimMode} onChange={e => setOptimMode(e.target.checked)} />
                  <span className="toggle-track"><span className="toggle-thumb" /></span>
                </label>
              </InputGroup>
              {optimMode && (
                <>
                  <div className="optim-hint">Min · Max · Paso</div>
                  <OptimRow label="TP (%)"    field="tpPct"    stepHint="0.1"  ranges={optimRanges} onChange={setOptimField} />
                  <OptimRow label="SL (%)"    field="slPct"    stepHint="0.1"  ranges={optimRanges} onChange={setOptimField} />
                  <OptimRow label="SAR Start" field="sarStart" stepHint="0.01" ranges={optimRanges} onChange={setOptimField} />
                  <OptimRow label="SAR Inc"   field="sarInc"   stepHint="0.01" ranges={optimRanges} onChange={setOptimField} />
                  <OptimRow label="SAR Max"   field="sarMax"   stepHint="0.1"  ranges={optimRanges} onChange={setOptimField} />
                  <OptimRow label="Pivot LR"  field="pivotLr"  stepHint="1"    ranges={optimRanges} onChange={setOptimField} />
                  <div className="optim-combos">{estimatedCombos.toLocaleString()} combinaciones</div>
                </>
              )}
            </Section>

          </div>
          <div className="sidebar-footer">
            {optimMode
              ? <button className="run-btn optim-btn" onClick={handleOptimize} disabled={!dbStatus?.connected}>
                  🔬 Abrir Análisis Profundo
                </button>
              : <button className="run-btn" onClick={handleRun} disabled={loading || !dbStatus?.connected}>
                  {loading ? <><span className="spinner" /> Procesando...</> : '▶ Ejecutar Backtest SAR'}
                </button>
            }
            {error && <div className="error-box">⚠️ {error}</div>}
          </div>
        </aside>

        {/* ── MAIN ── */}
        <main className="main">
          {!result && !loading && (
            <div className="empty-state">
              <div className="empty-icon">📈</div>
              <div className="empty-title">SAR — Riesgo Medio-Alto</div>
              <div className="empty-sub">Configura los parámetros y ejecuta el backtest para ver los resultados</div>
            </div>
          )}

          {loading && (
            <div className="empty-state">
              <div className="loading-ring" />
              <div className="empty-title">Analizando velas...</div>
              <div className="empty-sub">Calculando SAR y estructura de mercado</div>
            </div>
          )}

          {result && !loading && (
            <>
              <div className="result-header">
                <div className="result-meta">
                  <span>📊 {result.totalCandles.toLocaleString()} velas</span>
                  <span>·</span>
                  <span>{params.dateFrom} → {params.dateTo}</span>
                </div>
                <div className="tabs">
                  <button className={activeTab === 'stats'   ? 'tab active' : 'tab'} onClick={() => setActiveTab('stats')}>Estadísticas</button>
                  <button className={activeTab === 'trades'  ? 'tab active' : 'tab'} onClick={() => setActiveTab('trades')}>Trades ({result.trades.length})</button>
                  <button className={activeTab === 'signals' ? 'tab active' : 'tab'} onClick={() => setActiveTab('signals')}>Señales ({result.signals.length})</button>
                </div>
              </div>

              {activeTab === 'stats' && (
                <>
                  <div className="stats-grid">
                    <StatCard label="Trades cerrados"                      value={stats.totalClosed}    variant="neutral" />
                    <StatCard label="TP ✅"                                 value={stats.totalTp}        variant="win" />
                    <StatCard label="SL ❌"                                 value={stats.totalSl}        variant="loss" />
                    <StatCard label="Win Rate"                              value={`${stats.winRate}%`}  variant={winRate >= 50 ? 'win' : 'loss'} />
                    <StatCard label={`Ganancia acum. x${params.leverage}`}  value={`${stats.totalProfitPct}%`} variant="win" />
                    <StatCard label={`Pérdida acum. x${params.leverage}`}   value={`${stats.totalLossPct}%`}  variant="loss" />
                    <StatCard label={`Neto simple x${params.leverage}`}     value={`${stats.totalNetPct}%`}   variant={netPct >= 0 ? 'win' : 'loss'} />
                    <StatCard label="Máx. Drawdown"                         value={`${stats.maxDrawdownPct}%`} variant="warn" />
                    <StatCard label="Capital simple"      value={`$${parseFloat(stats.simpleCapital).toLocaleString('es-CO',{minimumFractionDigits:2})}`}   variant="neutral" />
                    <StatCard label="Capital compuesto"   value={`$${parseFloat(stats.compoundCapital).toLocaleString('es-CO',{minimumFractionDigits:2})}`} variant="accent" />
                    <StatCard label="Mejor método"                          value={stats.bestMethod}    variant="accent" />
                    <StatCard label={`TP efectivo x${params.leverage}`}     value={`${stats.effectiveTpPct}%`} variant="neutral" />
                    <StatCard label={`SL efectivo x${params.leverage}`}     value={`${stats.effectiveSlPct}%`} variant="neutral" />
                  </div>

                  {result.trades.length > 0 && (() => {
                    const { byYear, byMonth } = computePeriodStats(result.trades, stats.effectiveTpPct, stats.effectiveSlPct)
                    return <>
                      <PeriodTable title="📅 Acumulado por año"  rows={byYear}  />
                      <PeriodTable title="📆 Acumulado por mes"  rows={byMonth} />
                    </>
                  })()}
                </>
              )}

              {activeTab === 'trades' && (
                <div className="table-wrap">
                  {result.trades.length === 0
                    ? <div className="empty-table">No se cerraron trades en este período</div>
                    : (
                      <table className="data-table">
                        <thead>
                          <tr>
                            <th>#</th><th>Lado</th><th>Apertura</th><th>Entrada</th>
                            <th>TP</th><th>SL</th><th>Cierre</th><th>Resultado</th>
                            <th>Capital entrada</th><th>Capital salida</th>
                          </tr>
                        </thead>
                        <tbody>
                          {result.trades.map((t, i) => (
                            <tr key={i} className={t.result === 'TP' ? 'row-win' : 'row-loss'}>
                              <td>{i + 1}</td>
                              <td><span className={`badge badge-${t.side === 'LONG' ? 'tp' : 'sl'}`}>{t.side === 'LONG' ? '▲ LONG' : '▼ SHORT'}</span></td>
                              <td style={{fontFamily:'var(--font-mono)',fontSize:11}}>{new Date(t.time).toLocaleString('es-CO',{timeZone:'UTC'})}</td>
                              <td style={{fontFamily:'var(--font-mono)'}}>${parseFloat(t.price).toLocaleString('en-US')}</td>
                              <td className="tp-cell" style={{fontFamily:'var(--font-mono)'}}>${parseFloat(t.tp).toLocaleString('en-US')}</td>
                              <td className="sl-cell" style={{fontFamily:'var(--font-mono)'}}>${parseFloat(t.sl).toLocaleString('en-US')}</td>
                              <td style={{fontFamily:'var(--font-mono)',fontSize:11}}>{new Date(t.closeTime).toLocaleString('es-CO',{timeZone:'UTC'})}</td>
                              <td><span className={`badge badge-${t.result.toLowerCase()}`}>{t.result === 'TP' ? '✅ TP' : '❌ SL'}</span></td>
                              <td>${parseFloat(t.capitalAtEntry).toLocaleString('es-CO',{minimumFractionDigits:2,maximumFractionDigits:2})}</td>
                              <td className={t.result === 'TP' ? 'tp-cell' : 'sl-cell'}>${parseFloat(t.capitalAtExit).toLocaleString('es-CO',{minimumFractionDigits:2,maximumFractionDigits:2})}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )
                  }
                </div>
              )}

              {activeTab === 'signals' && (
                <div className="table-wrap">
                  {result.signals.length === 0
                    ? <div className="empty-table">No se generaron señales en este período</div>
                    : (
                      <table className="data-table">
                        <thead>
                          <tr>
                            <th>#</th><th>Fecha</th><th>Tipo</th><th>Precio entrada</th><th>SAR</th><th>Tendencia</th>
                          </tr>
                        </thead>
                        <tbody>
                          {result.signals.map((s, i) => (
                            <tr key={i} className={s.type === 'LONG' ? 'row-win' : 'row-loss'}>
                              <td>{i + 1}</td>
                              <td style={{fontFamily:'var(--font-mono)',fontSize:11}}>{new Date(s.time).toLocaleString('es-CO',{timeZone:'UTC'})}</td>
                              <td><span className={`badge badge-${s.type === 'LONG' ? 'tp' : 'sl'}`}>{s.type === 'LONG' ? '▲ LONG' : '▼ SHORT'}</span></td>
                              <td style={{fontFamily:'var(--font-mono)'}}>${parseFloat(s.price).toLocaleString('en-US')}</td>
                              <td style={{fontFamily:'var(--font-mono)',color:'var(--text-muted)'}}>{parseFloat(s.sarVal).toFixed(2)}</td>
                              <td>{s.trend === 1 ? '🟢 Alcista' : s.trend === -1 ? '🔴 Bajista' : '⚪ Lateral'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )
                  }
                </div>
              )}
            </>
          )}
        </main>
      </div>
    </div>
  )
}

// =============================================================================
// PinBarOptimView — Análisis profundo Pin Bar (abre en pestaña nueva)
// =============================================================================
function PinBarOptimView() {
  const [status, setStatus]     = useState('waiting')
  const [progress, setProgress] = useState(null)
  const [ranking, setRanking]   = useState([])
  const [errorMsg, setErrorMsg] = useState('')
  const startTimeRef = useRef(null)
  const bcRef = useRef(null)

  useEffect(() => {
    const bc = new BroadcastChannel('btc-pinbar-optim')
    bcRef.current = bc
    const sendReady = () => bc.postMessage({ type: 'ready' })
    sendReady()
    const retryTimer = setTimeout(sendReady, 1500)

    bc.onmessage = (e) => {
      const msg = e.data
      if (msg.type === 'init') {
        clearTimeout(retryTimer)
        const { candles, optimRanges, params } = msg
        setStatus('running')
        startTimeRef.current = Date.now()

        const worker = new Worker(new URL('./pinBarOptimWorker.js', import.meta.url), { type: 'module' })
        worker.onmessage = (ev) => {
          const m = ev.data
          if (m.type === 'progress') {
            const elapsed = Date.now() - startTimeRef.current
            let eta = null
            if (m.done >= 1 && elapsed >= 300) eta = Math.round((m.total - m.done) / (m.done / elapsed))
            setProgress({ done: m.done, total: m.total, eta })
            if (m.topResults?.length > 0) setRanking(m.topResults)
          } else if (m.type === 'done') {
            setStatus('done')
            setProgress(p => p ? { ...p, done: p.total } : null)
            if (m.results?.length > 0) setRanking(m.results)
            worker.terminate()
          } else if (m.type === 'error') {
            setErrorMsg(m.message); setStatus('error'); worker.terminate()
          }
        }
        worker.onerror = (ev) => { setErrorMsg(ev.message); setStatus('error'); worker.terminate() }
        worker.postMessage({ candles, optimRanges, params })
      }
    }
    return () => { clearTimeout(retryTimer); bc.close() }
  }, [])

  function applyParams(row) { bcRef.current?.postMessage({ type: 'apply', row }) }

  const pct = progress ? Math.round(progress.done / progress.total * 100) : 0

  return (
    <div className="optim-page">
      <header className="optim-page-header">
        <div className="logo">
          <span className="logo-icon">₿</span>
          <div>
            <div className="logo-title">MariaPaz<span style={{color:'var(--accent)'}}>Indicator</span></div>
            <div className="logo-sub">🔬 Pin Bar · Análisis Profundo · Ranking en vivo</div>
          </div>
        </div>
        <div className="optim-page-status">
          {status === 'waiting' && 'Esperando datos de la pestaña Pin Bar...'}
          {status === 'running' && progress && (
            <span>
              {progress.done.toLocaleString()} / {progress.total.toLocaleString()} · {pct}%
              {progress.eta != null && ` · faltan ${formatEta(progress.eta)}`}
              {' · '}{ranking.length} en ranking
            </span>
          )}
          {status === 'done' && <span style={{color:'var(--green)'}}>✅ Completado · {ranking.length} en ranking</span>}
          {status === 'error' && <span style={{color:'var(--red)'}}>⚠️ {errorMsg}</span>}
        </div>
      </header>

      {progress && (
        <div className="optim-page-progress">
          <div className="progress-track" style={{borderRadius:0, height:3}}>
            <div className="progress-fill" style={{width:`${pct}%`, transition:'width 0.5s ease'}} />
          </div>
        </div>
      )}

      <div className="optim-page-body">
        {status === 'waiting' && (
          <div className="optim-page-waiting">
            <div className="loading-ring" />
            <div>Esperando datos del análisis profundo Pin Bar...</div>
            <div style={{fontSize:12}}>Haz clic en "🔬 Abrir Análisis Profundo" en la pestaña Pin Bar</div>
          </div>
        )}

        {ranking.length > 0 && (
          <>
            <div className="optim-rank-meta">
              Ranking por Score = Neto% ÷ Drawdown% · filtro: neto &gt; 0% · mín. 5 trades · top 400
              {status === 'running' && ' · actualizando en vivo...'}
            </div>
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>#</th><th>Score</th>
                    <th>Cuerpo máx%</th><th>Mecha mín%</th>
                    <th>TP%</th><th>SL%</th>
                    <th>Trades</th><th>Win%</th><th>Neto%</th><th>Drawdown%</th>
                    <th>Aplicar</th>
                  </tr>
                </thead>
                <tbody>
                  {ranking.map((r, i) => (
                    <tr key={i} className="row-win">
                      <td>{i + 1}</td>
                      <td style={{color:'var(--accent)', fontWeight:600}}>{parseFloat(r._score).toFixed(2)}</td>
                      <td>{r.maxBodyPct}%</td>
                      <td>{r.minWickPct}%</td>
                      <td>{r.tpPct}</td>
                      <td>{r.slPct}</td>
                      <td>{r.totalClosed}</td>
                      <td>{r.winRate}%</td>
                      <td className="tp-cell">{r.totalNetPct}%</td>
                      <td className={parseFloat(r.maxDrawdownPct) > 30 ? 'sl-cell' : ''}>{r.maxDrawdownPct}%</td>
                      <td><button className="apply-btn" onClick={() => applyParams(r)} title="Aplicar en pestaña Pin Bar">▶</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// =============================================================================
// PinBarView — Vista principal de la estrategia Pin Bar
// =============================================================================
function PinBarView() {
  const [params, setParams]     = useState(DEFAULT_PINBAR_PARAMS)
  const [loading, setLoading]   = useState(false)
  const [error, setError]       = useState(null)
  const [result, setResult]     = useState(null)
  const [dbStatus, setDbStatus] = useState(null)
  const [activeTab, setActiveTab] = useState('stats')
  const [optimMode, setOptimMode] = useState(false)
  const [optimRanges, setOptimRanges] = useState(DEFAULT_PINBAR_OPTIM)
  const optimBcRef = useRef(null)

  const estimatedCombos = useMemo(() => countPinBarCombinations(optimRanges), [optimRanges])

  useEffect(() => {
    fetch('/api/status')
      .then(r => r.json())
      .then(d => setDbStatus(d))
      .catch(() => setDbStatus({ connected: false, error: 'No se pudo conectar' }))
  }, [])

  const set   = (key, val) => setParams(p => ({ ...p, [key]: val }))
  const num   = (key, val) => set(key, parseFloat(val) || 0)
  const int   = (key, val) => set(key, parseInt(val)   || 0)
  const setOF = (field, key, val) =>
    setOptimRanges(r => ({ ...r, [field]: { ...r[field], [key]: parseFloat(val) || 0 } }))

  function applyOptimResult(row) {
    setParams(p => ({
      ...p,
      maxBodyPct: parseFloat(row.maxBodyPct),
      minWickPct: parseFloat(row.minWickPct),
      tpPct:      parseFloat(row.tpPct),
      slPct:      parseFloat(row.slPct),
    }))
  }

  useEffect(() => {
    const bc = new BroadcastChannel('btc-pinbar-optim')
    optimBcRef.current = bc
    bc.onmessage = (e) => {
      if (e.data.type === 'ready') {
        bc.postMessage({ type: 'init', candles: [], optimRanges, params })
      } else if (e.data.type === 'apply') {
        applyOptimResult(e.data.row)
      }
    }
    return () => bc.close()
  }, [])

  async function handleRun() {
    setLoading(true); setError(null); setResult(null)
    try {
      const url = `/api/candles?from=${params.dateFrom}&to=${params.dateTo}`
      const resp = await fetch(url)
      if (!resp.ok) throw new Error((await resp.json()).error)
      const { candles, total } = await resp.json()
      if (!total) throw new Error('Sin datos')
      const res = runPinBarBacktest(candles, params)
      if (!res) throw new Error('Datos insuficientes')
      setResult(res)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  async function handleOptimize() {
    const url = `/api/candles?from=${params.dateFrom}&to=${params.dateTo}`
    const { candles } = await fetch(url).then(r => r.json())
    const win = window.open('?strategy=pinbar&mode=optim', '_blank')
    const bc = optimBcRef.current
    const sendInit = () => bc.postMessage({ type: 'init', candles, optimRanges, params })
    const tryReady = (ev) => { if (ev.data.type === 'ready') { sendInit(); bc.removeEventListener('message', tryReady) } }
    bc.addEventListener('message', tryReady)
    if (win) setTimeout(sendInit, 800)
  }

  const stats   = result?.stats ?? {}
  const winRate = parseFloat(stats.winRate    ?? 0)
  const netPct  = parseFloat(stats.totalNetPct ?? 0)

  return (
    <div className="app">
      <header className="header">
        <div className="header-top">
          <div className="logo">
            <span className="logo-icon">₿</span>
            <div>
              <div className="logo-title">MariaPaz<span style={{color:'var(--accent)'}}>Indicator</span></div>
              <div className="logo-sub">Pin Bar · BTCUSDC · 15m</div>
            </div>
          </div>
          <div className={`db-badge ${dbStatus?.connected ? 'connected' : 'disconnected'}`}>
            <span className="db-dot" />
            {dbStatus?.connected
              ? `BD conectada · ${dbStatus.totalCandles?.toLocaleString()} velas`
              : dbStatus?.error ?? 'Conectando...'}
          </div>
        </div>
        <div className="strategy-nav">
          <button className="strategy-tab" onClick={() => { window.location.href = '/' }}>📐 Rango + Resistencias</button>
          <button className="strategy-tab" onClick={() => { window.location.href = '?strategy=sar' }}>📈 SAR</button>
          <button className="strategy-tab" onClick={() => { window.location.href = '?strategy=supertrend' }}>📊 Supertrend</button>
          <button className="strategy-tab" onClick={() => { window.location.href = '?strategy=confluence' }}>🎯 Confluencia</button>
          <button className="strategy-tab" onClick={() => { window.location.href = '?strategy=emapullback' }}>📉 EMA Pullback</button>
          <button className="strategy-tab active">🕯️ Pin Bar</button>
          <button className="strategy-tab" onClick={() => { window.location.href = '?strategy=soporte' }}>📗 Rango + Soporte</button>
          <button className="strategy-tab" onClick={() => { window.location.href = '?strategy=ema' }}>📡 EMA Touch</button>
          <button className="strategy-tab" onClick={() => { window.location.href = '?strategy=rangehigh' }}>🏔️ Rango Alto</button>
        </div>
      </header>

      <div className="layout">
        <aside className="sidebar">
          <div className="sidebar-scroll">

            <Section title="📅 Rango de fechas">
              <InputGroup label="Desde">
                <input type="date" value={params.dateFrom} onChange={e => set('dateFrom', e.target.value)} />
              </InputGroup>
              <InputGroup label="Hasta">
                <input type="date" value={params.dateTo}   onChange={e => set('dateTo',   e.target.value)} />
              </InputGroup>
            </Section>

            <Section title="🕯️ Forma de vela">
              <InputGroup label="Cuerpo máx. (% precio)" tooltip="Cuerpo (|close-open|) ≤ este % del precio BTC. Ej: 0.5 = cuerpo de máx. $500 con BTC a $100k">
                <input type="number" value={params.maxBodyPct} step="0.1" min="0.1" max="10" onChange={e => num('maxBodyPct', e.target.value)} />
              </InputGroup>
              <InputGroup label="Mecha mín. (% del cuerpo)" tooltip="Mecha inferior (LONG) o superior (SHORT) ≥ este % del cuerpo. Ej: 100 = mecha al menos tan grande como el cuerpo">
                <input type="number" value={params.minWickPct} step="10" min="10" onChange={e => num('minWickPct', e.target.value)} />
              </InputGroup>
            </Section>

            <Section title="💰 TP / SL">
              <InputGroup label="TP (%)">
                <input type="number" value={params.tpPct}     step="0.1"  min="0.1" onChange={e => num('tpPct',     e.target.value)} />
              </InputGroup>
              <InputGroup label="SL (%)">
                <input type="number" value={params.slPct}     step="0.1"  min="0.1" onChange={e => num('slPct',     e.target.value)} />
              </InputGroup>
              <InputGroup label="Fee extra SL (%)">
                <input type="number" value={params.feeSlPct}  step="0.01" min="0"   onChange={e => num('feeSlPct',  e.target.value)} />
              </InputGroup>
              <InputGroup label="Fee descontado TP (%)">
                <input type="number" value={params.feeTpPct}  step="0.01" min="0"   onChange={e => num('feeTpPct',  e.target.value)} />
              </InputGroup>
              <InputGroup label="Apalancamiento">
                <input type="number" value={params.leverage}  step="1"    min="1"   onChange={e => num('leverage',  e.target.value)} />
              </InputGroup>
            </Section>

            <Section title="💵 Capital">
              <InputGroup label="Capital inicial ($)">
                <input type="number" value={params.initialCapital}      step="100" min="1" onChange={e => num('initialCapital',      e.target.value)} />
              </InputGroup>
              <InputGroup label="Aporte mensual ($)" tooltip="Se suma al capital al inicio de cada mes">
                <input type="number" value={params.monthlyContribution} step="100" min="0" onChange={e => num('monthlyContribution', e.target.value)} />
              </InputGroup>
            </Section>

            <Section title="🔘 Dirección">
              <InputGroup label="Dirección">
                <select value={params.tradeDirection} onChange={e => set('tradeDirection', e.target.value)}
                  style={{background:'var(--surface)',color:'var(--text)',border:'1px solid var(--border)',borderRadius:'var(--radius)',padding:'4px 8px',fontSize:12}}>
                  <option value="both">LONG + SHORT</option>
                  <option value="long">Solo LONG</option>
                  <option value="short">Solo SHORT</option>
                </select>
              </InputGroup>
            </Section>

            <Section title="🔬 Análisis Profundo">
              <InputGroup label="Activar optimización">
                <label className="toggle">
                  <input type="checkbox" checked={optimMode} onChange={e => setOptimMode(e.target.checked)} />
                  <span className="toggle-track"><span className="toggle-thumb" /></span>
                </label>
              </InputGroup>
              {optimMode && (
                <>
                  <div className="optim-hint">Min · Max · Paso</div>
                  <OptimRow label="Cuerpo máx% precio" field="maxBodyPct" stepHint="0.2" ranges={optimRanges} onChange={setOF} />
                  <OptimRow label="Mecha mín% cuerpo" field="minWickPct" stepHint="50"  ranges={optimRanges} onChange={setOF} />
                  <OptimRow label="TP (%)"       field="tpPct"      stepHint="0.5" ranges={optimRanges} onChange={setOF} />
                  <OptimRow label="SL (%)"       field="slPct"      stepHint="0.3" ranges={optimRanges} onChange={setOF} />
                  <div className="optim-combos">{estimatedCombos.toLocaleString()} combinaciones</div>
                </>
              )}
            </Section>

          </div>
          <div className="sidebar-footer">
            {optimMode
              ? <button className="run-btn optim-btn" onClick={handleOptimize} disabled={!dbStatus?.connected}>
                  🔬 Abrir Análisis Profundo
                </button>
              : <button className="run-btn" onClick={handleRun} disabled={loading || !dbStatus?.connected}>
                  {loading ? <><span className="spinner" /> Procesando...</> : '▶ Ejecutar Backtest'}
                </button>
            }
            {error && <div className="error-box">⚠️ {error}</div>}
          </div>
        </aside>

        <main className="main">
          {!result && !loading && (
            <div className="empty-state">
              <div className="empty-icon">🕯️</div>
              <div className="empty-title">Pin Bar</div>
              <div className="empty-sub">Configura el % de cuerpo y mecha, y ejecuta el backtest</div>
            </div>
          )}

          {loading && (
            <div className="empty-state">
              <div className="loading-ring" />
              <div className="empty-title">Analizando velas...</div>
              <div className="empty-sub">Buscando velas de rechazo</div>
            </div>
          )}

          {result && !loading && (
            <>
              <div className="result-header">
                <div className="result-meta">
                  <span>📊 {result.totalCandles.toLocaleString()} velas</span>
                  <span>·</span>
                  <span>{params.dateFrom} → {params.dateTo}</span>
                </div>
                <div className="tabs">
                  <button className={activeTab === 'stats'   ? 'tab active' : 'tab'} onClick={() => setActiveTab('stats')}>Estadísticas</button>
                  <button className={activeTab === 'trades'  ? 'tab active' : 'tab'} onClick={() => setActiveTab('trades')}>Trades ({result.trades.length})</button>
                  <button className={activeTab === 'signals' ? 'tab active' : 'tab'} onClick={() => setActiveTab('signals')}>Señales ({result.signals.length})</button>
                </div>
              </div>

              {activeTab === 'stats' && (
                <>
                  <div className="stats-grid">
                    <StatCard label="Trades cerrados"                      value={stats.totalClosed}    variant="neutral" />
                    <StatCard label="TP ✅"                                 value={stats.totalTp}        variant="win" />
                    <StatCard label="SL ❌"                                 value={stats.totalSl}        variant="loss" />
                    <StatCard label="Win Rate"                              value={`${stats.winRate}%`}  variant={winRate >= 50 ? 'win' : 'loss'} />
                    <StatCard label={`Ganancia acum. x${params.leverage}`} value={`${stats.totalProfitPct}%`} variant="win" />
                    <StatCard label={`Pérdida acum. x${params.leverage}`}  value={`${stats.totalLossPct}%`}  variant="loss" />
                    <StatCard label={`Neto x${params.leverage}`}           value={`${stats.totalNetPct}%`}   variant={netPct >= 0 ? 'win' : 'loss'} />
                    <StatCard label="Máx. Drawdown"                        value={`${stats.maxDrawdownPct}%`} variant="warn" />
                    <StatCard label="Capital simple"    value={`$${parseFloat(stats.simpleCapital).toLocaleString('es-CO',{minimumFractionDigits:2})}`}   variant="neutral" />
                    <StatCard label="Capital compuesto" value={`$${parseFloat(stats.compoundCapital).toLocaleString('es-CO',{minimumFractionDigits:2})}`} variant="accent" />
                    <StatCard label="Mejor método"                         value={stats.bestMethod}     variant="accent" />
                    <StatCard label={`TP efectivo x${params.leverage}`}    value={`${stats.effectiveTpPct}%`} variant="neutral" />
                    <StatCard label={`SL efectivo x${params.leverage}`}    value={`${stats.effectiveSlPct}%`} variant="neutral" />
                  </div>

                  {result.trades.length > 0 && (() => {
                    const { byYear, byMonth } = computePeriodStats(result.trades, stats.effectiveTpPct, stats.effectiveSlPct)
                    return <>
                      <PeriodTable title="📅 Acumulado por año"  rows={byYear}  />
                      <PeriodTable title="📆 Acumulado por mes"  rows={byMonth} />
                    </>
                  })()}
                </>
              )}

              {activeTab === 'trades' && (
                <div className="table-wrap">
                  {result.trades.length === 0
                    ? <div className="empty-table">No se cerraron trades en este período</div>
                    : (
                      <table className="data-table">
                        <thead>
                          <tr>
                            <th>#</th><th>Lado</th><th>Apertura</th><th>Entrada</th>
                            <th>TP</th><th>SL</th><th>Cierre</th><th>Resultado</th>
                            <th>Capital entrada</th><th>Capital salida</th>
                          </tr>
                        </thead>
                        <tbody>
                          {result.trades.map((t, i) => (
                            <tr key={i} className={t.result === 'TP' ? 'row-win' : 'row-loss'}>
                              <td>{i + 1}</td>
                              <td><span className={`badge badge-${t.side === 'LONG' ? 'tp' : 'sl'}`}>{t.side === 'LONG' ? '▲ LONG' : '▼ SHORT'}</span></td>
                              <td style={{fontFamily:'var(--font-mono)',fontSize:11}}>{new Date(t.time).toLocaleString('es-CO',{timeZone:'UTC'})}</td>
                              <td style={{fontFamily:'var(--font-mono)'}}>${parseFloat(t.price).toLocaleString('en-US')}</td>
                              <td className="tp-cell" style={{fontFamily:'var(--font-mono)'}}>${parseFloat(t.tp).toLocaleString('en-US')}</td>
                              <td className="sl-cell" style={{fontFamily:'var(--font-mono)'}}>${parseFloat(t.sl).toLocaleString('en-US')}</td>
                              <td style={{fontFamily:'var(--font-mono)',fontSize:11}}>{new Date(t.closeTime).toLocaleString('es-CO',{timeZone:'UTC'})}</td>
                              <td><span className={`badge badge-${t.result.toLowerCase()}`}>{t.result === 'TP' ? '✅ TP' : '❌ SL'}</span></td>
                              <td>${parseFloat(t.capitalAtEntry).toLocaleString('es-CO',{minimumFractionDigits:2,maximumFractionDigits:2})}</td>
                              <td className={t.result === 'TP' ? 'tp-cell' : 'sl-cell'}>${parseFloat(t.capitalAtExit).toLocaleString('es-CO',{minimumFractionDigits:2,maximumFractionDigits:2})}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )
                  }
                </div>
              )}

              {activeTab === 'signals' && (
                <div className="table-wrap">
                  {result.signals.length === 0
                    ? <div className="empty-table">No se generaron señales en este período</div>
                    : (
                      <table className="data-table">
                        <thead>
                          <tr>
                            <th>#</th><th>Fecha</th><th>Tipo</th><th>Precio</th><th>Cuerpo%</th><th>Mecha%</th>
                          </tr>
                        </thead>
                        <tbody>
                          {result.signals.map((s, i) => (
                            <tr key={i}>
                              <td>{i + 1}</td>
                              <td style={{fontFamily:'var(--font-mono)',fontSize:11}}>{new Date(s.time).toLocaleString('es-CO',{timeZone:'UTC'})}</td>
                              <td><span className={`badge badge-${s.type === 'LONG' ? 'tp' : 'sl'}`}>{s.type === 'LONG' ? '▲ LONG' : '▼ SHORT'}</span></td>
                              <td style={{fontFamily:'var(--font-mono)'}}>${parseFloat(s.price).toLocaleString('en-US')}</td>
                              <td style={{color:'var(--text-muted)'}}>{s.bodyPct}%</td>
                              <td style={{color: s.type === 'LONG' ? 'var(--green)' : 'var(--red)'}}>{s.wickPct}%</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )
                  }
                </div>
              )}
            </>
          )}
        </main>
      </div>
    </div>
  )
}

// =============================================================================
// EmaPullbackOptimView — Análisis profundo EMA Pullback (abre en pestaña nueva)
// =============================================================================
function EmaPullbackOptimView() {
  const [status, setStatus]     = useState('waiting')
  const [progress, setProgress] = useState(null)
  const [ranking, setRanking]   = useState([])
  const [errorMsg, setErrorMsg] = useState('')
  const startTimeRef = useRef(null)
  const bcRef = useRef(null)

  useEffect(() => {
    const bc = new BroadcastChannel('btc-emapullback-optim')
    bcRef.current = bc
    const sendReady = () => bc.postMessage({ type: 'ready' })
    sendReady()
    const retryTimer = setTimeout(sendReady, 1500)

    bc.onmessage = (e) => {
      const msg = e.data
      if (msg.type === 'init') {
        clearTimeout(retryTimer)
        const { candles, optimRanges, params } = msg
        setStatus('running')
        startTimeRef.current = Date.now()

        const worker = new Worker(new URL('./emaPullbackOptimWorker.js', import.meta.url), { type: 'module' })
        worker.onmessage = (ev) => {
          const m = ev.data
          if (m.type === 'progress') {
            const elapsed = Date.now() - startTimeRef.current
            let eta = null
            if (m.done >= 1 && elapsed >= 300) eta = Math.round((m.total - m.done) / (m.done / elapsed))
            setProgress({ done: m.done, total: m.total, eta })
            if (m.topResults?.length > 0) setRanking(m.topResults)
          } else if (m.type === 'done') {
            setStatus('done')
            setProgress(p => p ? { ...p, done: p.total } : null)
            if (m.results?.length > 0) setRanking(m.results)
            worker.terminate()
          } else if (m.type === 'error') {
            setErrorMsg(m.message); setStatus('error'); worker.terminate()
          }
        }
        worker.onerror = (ev) => { setErrorMsg(ev.message); setStatus('error'); worker.terminate() }
        worker.postMessage({ candles, optimRanges, params })
      }
    }
    return () => { clearTimeout(retryTimer); bc.close() }
  }, [])

  function applyParams(row) { bcRef.current?.postMessage({ type: 'apply', row }) }

  const pct = progress ? Math.round(progress.done / progress.total * 100) : 0

  return (
    <div className="optim-page">
      <header className="optim-page-header">
        <div className="logo">
          <span className="logo-icon">₿</span>
          <div>
            <div className="logo-title">MariaPaz<span style={{color:'var(--accent)'}}>Indicator</span></div>
            <div className="logo-sub">🔬 EMA Pullback · Análisis Profundo · Ranking en vivo</div>
          </div>
        </div>
        <div className="optim-page-status">
          {status === 'waiting' && 'Esperando datos de la pestaña EMA Pullback...'}
          {status === 'running' && progress && (
            <span>
              {progress.done.toLocaleString()} / {progress.total.toLocaleString()} · {pct}%
              {progress.eta != null && ` · faltan ${formatEta(progress.eta)}`}
              {' · '}{ranking.length} en ranking
            </span>
          )}
          {status === 'done' && <span style={{color:'var(--green)'}}>✅ Completado · {ranking.length} en ranking</span>}
          {status === 'error' && <span style={{color:'var(--red)'}}>⚠️ {errorMsg}</span>}
        </div>
      </header>

      {progress && (
        <div className="optim-page-progress">
          <div className="progress-track" style={{borderRadius:0, height:3}}>
            <div className="progress-fill" style={{width:`${pct}%`, transition:'width 0.5s ease'}} />
          </div>
        </div>
      )}

      <div className="optim-page-body">
        {status === 'waiting' && (
          <div className="optim-page-waiting">
            <div className="loading-ring" />
            <div>Esperando datos del análisis profundo EMA Pullback...</div>
            <div style={{fontSize:12}}>Haz clic en "🔬 Abrir Análisis Profundo" en la pestaña EMA Pullback</div>
          </div>
        )}

        {ranking.length > 0 && (
          <>
            <div className="optim-rank-meta">
              Ranking por Score = Neto% ÷ Drawdown% · filtro: neto &gt; 0% · mín. 5 trades · top 400
              {status === 'running' && ' · actualizando en vivo...'}
            </div>
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>#</th><th>Score</th>
                    <th>EMA rápida</th><th>RSI min</th><th>RSI max</th>
                    <th>TP%</th><th>SL%</th>
                    <th>Trades</th><th>Win%</th><th>Neto%</th><th>Drawdown%</th>
                    <th>Aplicar</th>
                  </tr>
                </thead>
                <tbody>
                  {ranking.map((r, i) => (
                    <tr key={i} className="row-win">
                      <td>{i + 1}</td>
                      <td style={{color:'var(--accent)', fontWeight:600}}>{parseFloat(r._score).toFixed(2)}</td>
                      <td>{r.emaFast}</td>
                      <td>{r.rsiMin}</td>
                      <td>{r.rsiMax}</td>
                      <td>{r.tpPct}</td>
                      <td>{r.slPct}</td>
                      <td>{r.totalClosed}</td>
                      <td>{r.winRate}%</td>
                      <td className="tp-cell">{r.totalNetPct}%</td>
                      <td className={parseFloat(r.maxDrawdownPct) > 30 ? 'sl-cell' : ''}>{r.maxDrawdownPct}%</td>
                      <td><button className="apply-btn" onClick={() => applyParams(r)} title="Aplicar en pestaña EMA Pullback">▶</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// =============================================================================
// EmaPullbackView — Vista principal de la estrategia EMA Pullback
// =============================================================================
function EmaPullbackView() {
  const [params, setParams]   = useState(DEFAULT_EMA_PULLBACK_PARAMS)
  const [loading, setLoading] = useState(false)
  const [error, setError]     = useState(null)
  const [result, setResult]   = useState(null)
  const [dbStatus, setDbStatus] = useState(null)
  const [activeTab, setActiveTab] = useState('stats')
  const [optimMode, setOptimMode] = useState(false)
  const [optimRanges, setOptimRanges] = useState(DEFAULT_EMA_PULLBACK_OPTIM)
  const optimBcRef = useRef(null)

  const estimatedCombos = useMemo(() => countEmaPullbackCombinations(optimRanges), [optimRanges])

  useEffect(() => {
    fetch('/api/status')
      .then(r => r.json())
      .then(d => setDbStatus(d))
      .catch(() => setDbStatus({ connected: false, error: 'No se pudo conectar' }))
  }, [])

  const set   = (key, val) => setParams(p => ({ ...p, [key]: val }))
  const num   = (key, val) => set(key, parseFloat(val) || 0)
  const int   = (key, val) => set(key, parseInt(val)   || 1)
  const setOF = (field, key, val) =>
    setOptimRanges(r => ({ ...r, [field]: { ...r[field], [key]: parseFloat(val) || 0 } }))

  function applyOptimResult(row) {
    setParams(p => ({
      ...p,
      emaFast: row.emaFast,
      rsiMin:  parseFloat(row.rsiMin),
      rsiMax:  parseFloat(row.rsiMax),
      tpPct:   parseFloat(row.tpPct),
      slPct:   parseFloat(row.slPct),
    }))
  }

  // BroadcastChannel: escucha apply desde OptimView
  useEffect(() => {
    const bc = new BroadcastChannel('btc-emapullback-optim')
    optimBcRef.current = bc
    bc.onmessage = (e) => {
      if (e.data.type === 'ready') {
        bc.postMessage({ type: 'init', candles: [], optimRanges, params })
      } else if (e.data.type === 'apply') {
        applyOptimResult(e.data.row)
      }
    }
    return () => bc.close()
  }, [])

  async function handleRun() {
    setLoading(true); setError(null); setResult(null)
    try {
      const url = `/api/candles?from=${params.dateFrom}&to=${params.dateTo}`
      const resp = await fetch(url)
      if (!resp.ok) throw new Error((await resp.json()).error)
      const { candles, total } = await resp.json()
      if (!total) throw new Error('Sin datos')
      const res = runEmaPullbackBacktest(candles, params)
      if (!res) throw new Error('Datos insuficientes')
      setResult(res)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  async function handleOptimize() {
    const url = `/api/candles?from=${params.dateFrom}&to=${params.dateTo}`
    const { candles } = await fetch(url).then(r => r.json())
    const win = window.open('?strategy=emapullback&mode=optim', '_blank')
    const bc = optimBcRef.current
    const sendInit = () => bc.postMessage({ type: 'init', candles, optimRanges, params })
    const tryReady = (ev) => { if (ev.data.type === 'ready') { sendInit(); bc.removeEventListener('message', tryReady) } }
    bc.addEventListener('message', tryReady)
    if (win) setTimeout(sendInit, 800)
  }

  const stats    = result?.stats ?? {}
  const winRate  = parseFloat(stats.winRate  ?? 0)
  const netPct   = parseFloat(stats.totalNetPct ?? 0)

  return (
    <div className="app">
      <header className="header">
        <div className="header-top">
          <div className="logo">
            <span className="logo-icon">₿</span>
            <div>
              <div className="logo-title">MariaPaz<span style={{color:'var(--accent)'}}>Indicator</span></div>
              <div className="logo-sub">EMA Pullback · BTCUSDC · 15m</div>
            </div>
          </div>
          <div className={`db-badge ${dbStatus?.connected ? 'connected' : 'disconnected'}`}>
            <span className="db-dot" />
            {dbStatus?.connected
              ? `BD conectada · ${dbStatus.totalCandles?.toLocaleString()} velas`
              : dbStatus?.error ?? 'Conectando...'}
          </div>
        </div>
        <div className="strategy-nav">
          <button className="strategy-tab" onClick={() => { window.location.href = '/' }}>📐 Rango + Resistencias</button>
          <button className="strategy-tab" onClick={() => { window.location.href = '?strategy=sar' }}>📈 SAR</button>
          <button className="strategy-tab" onClick={() => { window.location.href = '?strategy=supertrend' }}>📊 Supertrend</button>
          <button className="strategy-tab" onClick={() => { window.location.href = '?strategy=confluence' }}>🎯 Confluencia</button>
          <button className="strategy-tab active">📉 EMA Pullback</button>
          <button className="strategy-tab" onClick={() => { window.location.href = '?strategy=pinbar' }}>🕯️ Pin Bar</button>
          <button className="strategy-tab" onClick={() => { window.location.href = '?strategy=soporte' }}>📗 Rango + Soporte</button>
          <button className="strategy-tab" onClick={() => { window.location.href = '?strategy=ema' }}>📡 EMA Touch</button>
          <button className="strategy-tab" onClick={() => { window.location.href = '?strategy=rangehigh' }}>🏔️ Rango Alto</button>
        </div>
      </header>

      <div className="layout">
        <aside className="sidebar">
          <div className="sidebar-scroll">

            <Section title="📅 Rango de fechas">
              <InputGroup label="Desde">
                <input type="date" value={params.dateFrom} onChange={e => set('dateFrom', e.target.value)} />
              </InputGroup>
              <InputGroup label="Hasta">
                <input type="date" value={params.dateTo}   onChange={e => set('dateTo',   e.target.value)} />
              </InputGroup>
            </Section>

            <Section title="📈 EMAs">
              <InputGroup label="EMA rápida" tooltip="Período EMA de referencia para el pullback">
                <input type="number" value={params.emaFast} step="1" min="5"  onChange={e => int('emaFast', e.target.value)} />
              </InputGroup>
              <InputGroup label="EMA lenta" tooltip="Período EMA lenta — define la tendencia macro">
                <input type="number" value={params.emaSlow} step="1" min="10" onChange={e => int('emaSlow', e.target.value)} />
              </InputGroup>
            </Section>

            <Section title="📊 RSI">
              <InputGroup label="Período RSI">
                <input type="number" value={params.rsiPeriod} step="1" min="2" onChange={e => int('rsiPeriod', e.target.value)} />
              </InputGroup>
              <InputGroup label="RSI mínimo" tooltip="RSI debe estar por encima de este valor (no sobrevendido extremo)">
                <input type="number" value={params.rsiMin} step="1" min="1" max="49" onChange={e => int('rsiMin', e.target.value)} />
              </InputGroup>
              <InputGroup label="RSI máximo" tooltip="RSI debe estar por debajo de este valor (no sobrecomprado extremo)">
                <input type="number" value={params.rsiMax} step="1" min="51" max="99" onChange={e => int('rsiMax', e.target.value)} />
              </InputGroup>
            </Section>

            <Section title="📦 Volumen">
              <InputGroup label="Período Vol MA">
                <input type="number" value={params.volMAPeriod} step="1" min="2" onChange={e => int('volMAPeriod', e.target.value)} />
              </InputGroup>
              <InputGroup label="Multiplicador Vol">
                <input type="number" value={params.volMultiplier} step="0.1" min="1" onChange={e => num('volMultiplier', e.target.value)} />
              </InputGroup>
              <InputGroup label="Filtro de volumen">
                <label className="toggle">
                  <input type="checkbox" checked={params.useVolumeFilter} onChange={e => set('useVolumeFilter', e.target.checked)} />
                  <span className="toggle-track"><span className="toggle-thumb" /></span>
                </label>
              </InputGroup>
            </Section>

            <Section title="💰 TP / SL">
              <InputGroup label="TP (%)">
                <input type="number" value={params.tpPct}          step="0.1"  min="0.1" onChange={e => num('tpPct',          e.target.value)} />
              </InputGroup>
              <InputGroup label="SL (%)">
                <input type="number" value={params.slPct}          step="0.1"  min="0.1" onChange={e => num('slPct',          e.target.value)} />
              </InputGroup>
              <InputGroup label="Fee extra SL (%)">
                <input type="number" value={params.feeSlPct}       step="0.01" min="0"   onChange={e => num('feeSlPct',       e.target.value)} />
              </InputGroup>
              <InputGroup label="Fee descontado TP (%)">
                <input type="number" value={params.feeTpPct}       step="0.01" min="0"   onChange={e => num('feeTpPct',       e.target.value)} />
              </InputGroup>
              <InputGroup label="Apalancamiento">
                <input type="number" value={params.leverage}       step="1"    min="1"   onChange={e => num('leverage',       e.target.value)} />
              </InputGroup>
              <InputGroup label="Capital inicial ($)">
                <input type="number" value={params.initialCapital} step="100"  min="1"   onChange={e => num('initialCapital', e.target.value)} />
              </InputGroup>
            </Section>

            <Section title="🔘 Dirección">
              <InputGroup label="Dirección">
                <select value={params.tradeDirection} onChange={e => set('tradeDirection', e.target.value)}
                  style={{background:'var(--surface)',color:'var(--text)',border:'1px solid var(--border)',borderRadius:'var(--radius)',padding:'4px 8px',fontSize:12}}>
                  <option value="both">LONG + SHORT</option>
                  <option value="long">Solo LONG</option>
                  <option value="short">Solo SHORT</option>
                </select>
              </InputGroup>
            </Section>

            <Section title="🔬 Análisis Profundo">
              <InputGroup label="Activar optimización">
                <label className="toggle">
                  <input type="checkbox" checked={optimMode} onChange={e => setOptimMode(e.target.checked)} />
                  <span className="toggle-track"><span className="toggle-thumb" /></span>
                </label>
              </InputGroup>
              {optimMode && (
                <>
                  <div className="optim-hint">Min · Max · Paso</div>
                  <OptimRow label="EMA rápida" field="emaFast" stepHint="4"   ranges={optimRanges} onChange={setOF} />
                  <OptimRow label="RSI mín"    field="rsiMin"  stepHint="5"   ranges={optimRanges} onChange={setOF} />
                  <OptimRow label="TP (%)"     field="tpPct"   stepHint="0.5" ranges={optimRanges} onChange={setOF} />
                  <OptimRow label="SL (%)"     field="slPct"   stepHint="0.3" ranges={optimRanges} onChange={setOF} />
                  <div className="optim-combos">{estimatedCombos.toLocaleString()} combinaciones</div>
                </>
              )}
            </Section>

          </div>
          <div className="sidebar-footer">
            {optimMode
              ? <button className="run-btn optim-btn" onClick={handleOptimize} disabled={!dbStatus?.connected}>
                  🔬 Abrir Análisis Profundo
                </button>
              : <button className="run-btn" onClick={handleRun} disabled={loading || !dbStatus?.connected}>
                  {loading ? <><span className="spinner" /> Procesando...</> : '▶ Ejecutar Backtest'}
                </button>
            }
            {error && <div className="error-box">⚠️ {error}</div>}
          </div>
        </aside>

        <main className="main">
          {!result && !loading && (
            <div className="empty-state">
              <div className="empty-icon">📉</div>
              <div className="empty-title">EMA Pullback</div>
              <div className="empty-sub">Configura los parámetros y ejecuta el backtest para ver los resultados</div>
            </div>
          )}

          {loading && (
            <div className="empty-state">
              <div className="loading-ring" />
              <div className="empty-title">Analizando velas...</div>
              <div className="empty-sub">Calculando señales EMA Pullback</div>
            </div>
          )}

          {result && !loading && (
            <>
              <div className="result-header">
                <div className="result-meta">
                  <span>📊 {result.totalCandles.toLocaleString()} velas</span>
                  <span>·</span>
                  <span>{params.dateFrom} → {params.dateTo}</span>
                </div>
                <div className="tabs">
                  <button className={activeTab === 'stats'   ? 'tab active' : 'tab'} onClick={() => setActiveTab('stats')}>Estadísticas</button>
                  <button className={activeTab === 'trades'  ? 'tab active' : 'tab'} onClick={() => setActiveTab('trades')}>Trades ({result.trades.length})</button>
                  <button className={activeTab === 'signals' ? 'tab active' : 'tab'} onClick={() => setActiveTab('signals')}>Señales ({result.signals.length})</button>
                </div>
              </div>

              {activeTab === 'stats' && (
                <>
                  <div className="stats-grid">
                    <StatCard label="Trades cerrados"                      value={stats.totalClosed}    variant="neutral" />
                    <StatCard label="TP ✅"                                 value={stats.totalTp}        variant="win" />
                    <StatCard label="SL ❌"                                 value={stats.totalSl}        variant="loss" />
                    <StatCard label="Win Rate"                              value={`${stats.winRate}%`}  variant={winRate >= 50 ? 'win' : 'loss'} />
                    <StatCard label={`Ganancia acum. x${params.leverage}`} value={`${stats.totalProfitPct}%`} variant="win" />
                    <StatCard label={`Pérdida acum. x${params.leverage}`}  value={`${stats.totalLossPct}%`}  variant="loss" />
                    <StatCard label={`Neto x${params.leverage}`}           value={`${stats.totalNetPct}%`}   variant={netPct >= 0 ? 'win' : 'loss'} />
                    <StatCard label="Máx. Drawdown"                        value={`${stats.maxDrawdownPct}%`} variant="warn" />
                    <StatCard label="Capital simple"    value={`$${parseFloat(stats.simpleCapital).toLocaleString('es-CO',{minimumFractionDigits:2})}`}   variant="neutral" />
                    <StatCard label="Capital compuesto" value={`$${parseFloat(stats.compoundCapital).toLocaleString('es-CO',{minimumFractionDigits:2})}`} variant="accent" />
                    <StatCard label="Mejor método"                         value={stats.bestMethod}     variant="accent" />
                    <StatCard label={`TP efectivo x${params.leverage}`}    value={`${stats.effectiveTpPct}%`} variant="neutral" />
                    <StatCard label={`SL efectivo x${params.leverage}`}    value={`${stats.effectiveSlPct}%`} variant="neutral" />
                  </div>

                  {result.trades.length > 0 && (() => {
                    const { byYear, byMonth } = computePeriodStats(result.trades, stats.effectiveTpPct, stats.effectiveSlPct)
                    return <>
                      <PeriodTable title="📅 Acumulado por año"  rows={byYear}  />
                      <PeriodTable title="📆 Acumulado por mes"  rows={byMonth} />
                    </>
                  })()}
                </>
              )}

              {activeTab === 'trades' && (
                <div className="table-wrap">
                  {result.trades.length === 0
                    ? <div className="empty-table">No se cerraron trades en este período</div>
                    : (
                      <table className="data-table">
                        <thead>
                          <tr>
                            <th>#</th><th>Lado</th><th>Apertura</th><th>Entrada</th>
                            <th>TP</th><th>SL</th><th>Cierre</th><th>Resultado</th>
                            <th>Capital entrada</th><th>Capital salida</th>
                          </tr>
                        </thead>
                        <tbody>
                          {result.trades.map((t, i) => (
                            <tr key={i} className={t.result === 'TP' ? 'row-win' : 'row-loss'}>
                              <td>{i + 1}</td>
                              <td><span className={`badge badge-${t.side === 'LONG' ? 'tp' : 'sl'}`}>{t.side === 'LONG' ? '▲ LONG' : '▼ SHORT'}</span></td>
                              <td style={{fontFamily:'var(--font-mono)',fontSize:11}}>{new Date(t.time).toLocaleString('es-CO',{timeZone:'UTC'})}</td>
                              <td style={{fontFamily:'var(--font-mono)'}}>${parseFloat(t.price).toLocaleString('en-US')}</td>
                              <td className="tp-cell" style={{fontFamily:'var(--font-mono)'}}>${parseFloat(t.tp).toLocaleString('en-US')}</td>
                              <td className="sl-cell" style={{fontFamily:'var(--font-mono)'}}>${parseFloat(t.sl).toLocaleString('en-US')}</td>
                              <td style={{fontFamily:'var(--font-mono)',fontSize:11}}>{new Date(t.closeTime).toLocaleString('es-CO',{timeZone:'UTC'})}</td>
                              <td><span className={`badge badge-${t.result.toLowerCase()}`}>{t.result === 'TP' ? '✅ TP' : '❌ SL'}</span></td>
                              <td>${parseFloat(t.capitalAtEntry).toLocaleString('es-CO',{minimumFractionDigits:2,maximumFractionDigits:2})}</td>
                              <td className={t.result === 'TP' ? 'tp-cell' : 'sl-cell'}>${parseFloat(t.capitalAtExit).toLocaleString('es-CO',{minimumFractionDigits:2,maximumFractionDigits:2})}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )
                  }
                </div>
              )}

              {activeTab === 'signals' && (
                <div className="table-wrap">
                  {result.signals.length === 0
                    ? <div className="empty-table">No se generaron señales en este período</div>
                    : (
                      <table className="data-table">
                        <thead>
                          <tr>
                            <th>#</th><th>Fecha</th><th>Tipo</th><th>Precio</th><th>RSI</th><th>EMA rápida</th><th>EMA lenta</th>
                          </tr>
                        </thead>
                        <tbody>
                          {result.signals.map((s, i) => (
                            <tr key={i}>
                              <td>{i + 1}</td>
                              <td style={{fontFamily:'var(--font-mono)',fontSize:11}}>{new Date(s.time).toLocaleString('es-CO',{timeZone:'UTC'})}</td>
                              <td><span className={`badge badge-${s.type === 'LONG' ? 'tp' : 'sl'}`}>{s.type === 'LONG' ? '▲ LONG' : '▼ SHORT'}</span></td>
                              <td style={{fontFamily:'var(--font-mono)'}}>${parseFloat(s.price).toLocaleString('en-US')}</td>
                              <td style={{color:'var(--text-muted)'}}>{s.rsi}</td>
                              <td style={{fontFamily:'var(--font-mono)',color:'var(--text-muted)',fontSize:11}}>{s.emaFast}</td>
                              <td style={{fontFamily:'var(--font-mono)',color:'var(--text-muted)',fontSize:11}}>{s.emaSlow}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )
                  }
                </div>
              )}
            </>
          )}
        </main>
      </div>
    </div>
  )
}

// =============================================================================
// ConfluenceOptimView — Análisis profundo Confluencia (abre en pestaña nueva)
// =============================================================================
function ConfluenceOptimView() {
  const [status, setStatus]   = useState('waiting')
  const [progress, setProgress] = useState(null)
  const [ranking, setRanking] = useState([])
  const [errorMsg, setErrorMsg] = useState('')
  const startTimeRef = useRef(null)
  const bcRef = useRef(null)

  useEffect(() => {
    const bc = new BroadcastChannel('btc-confluence-optim')
    bcRef.current = bc
    const sendReady = () => bc.postMessage({ type: 'ready' })
    sendReady()
    const retryTimer = setTimeout(sendReady, 1500)

    bc.onmessage = (e) => {
      const msg = e.data
      if (msg.type === 'init') {
        clearTimeout(retryTimer)
        const { candles, optimRanges, params } = msg
        setStatus('running')
        startTimeRef.current = Date.now()

        const worker = new Worker(new URL('./confluenceOptimWorker.js', import.meta.url), { type: 'module' })
        worker.onmessage = (ev) => {
          const m = ev.data
          if (m.type === 'progress') {
            const elapsed = Date.now() - startTimeRef.current
            let eta = null
            if (m.done >= 1 && elapsed >= 300) eta = Math.round((m.total - m.done) / (m.done / elapsed))
            setProgress({ done: m.done, total: m.total, eta })
            if (m.topResults?.length > 0) setRanking(m.topResults)
          } else if (m.type === 'done') {
            setStatus('done')
            setProgress(p => p ? { ...p, done: p.total } : null)
            if (m.results?.length > 0) setRanking(m.results)
            worker.terminate()
          } else if (m.type === 'error') {
            setErrorMsg(m.message); setStatus('error'); worker.terminate()
          }
        }
        worker.onerror = (ev) => { setErrorMsg(ev.message); setStatus('error'); worker.terminate() }
        worker.postMessage({ candles, optimRanges, params })
      }
    }
    return () => { clearTimeout(retryTimer); bc.close() }
  }, [])

  function applyParams(row) { bcRef.current?.postMessage({ type: 'apply', row }) }

  const pct = progress ? Math.round(progress.done / progress.total * 100) : 0

  return (
    <div className="optim-page">
      <header className="optim-page-header">
        <div className="logo">
          <span className="logo-icon">₿</span>
          <div>
            <div className="logo-title">MariaPaz<span style={{color:'var(--accent)'}}>Indicator</span></div>
            <div className="logo-sub">🔬 Confluencia · Análisis Profundo · Ranking en vivo</div>
          </div>
        </div>
        <div className="optim-page-status">
          {status === 'waiting' && 'Esperando datos de la pestaña Confluencia...'}
          {status === 'running' && progress && (
            <span>
              {progress.done.toLocaleString()} / {progress.total.toLocaleString()} · {pct}%
              {progress.eta != null && ` · faltan ${formatEta(progress.eta)}`}
              {' · '}{ranking.length} en ranking
            </span>
          )}
          {status === 'done' && <span style={{color:'var(--green)'}}>✅ Completado · {ranking.length} en ranking</span>}
          {status === 'error' && <span style={{color:'var(--red)'}}>⚠️ {errorMsg}</span>}
        </div>
      </header>

      {progress && (
        <div className="optim-page-progress">
          <div className="progress-track" style={{borderRadius:0, height:3}}>
            <div className="progress-fill" style={{width:`${pct}%`, transition:'width 0.5s ease'}} />
          </div>
        </div>
      )}

      <div className="optim-page-body">
        {status === 'waiting' && (
          <div className="optim-page-waiting">
            <div className="loading-ring" />
            <div>Esperando datos del análisis profundo Confluencia...</div>
            <div style={{fontSize:12}}>Haz clic en "🔬 Abrir Análisis Profundo" en la pestaña Confluencia</div>
          </div>
        )}

        {ranking.length > 0 && (
          <>
            <div className="optim-rank-meta">
              Ranking por Score = Neto% ÷ Drawdown% · filtro: neto &gt; 0% · mín. 5 trades · top 100
              {status === 'running' && ' · actualizando en vivo...'}
            </div>
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>#</th><th>Score</th>
                    <th>TP%</th><th>SL%</th><th>Conf.</th><th>RSI OB</th><th>RSI OS</th>
                    <th>Trades</th><th>Win%</th><th>Neto%</th><th>Drawdown%</th>
                    <th>Aplicar</th>
                  </tr>
                </thead>
                <tbody>
                  {ranking.map((r, i) => (
                    <tr key={i} className="row-win">
                      <td>{i + 1}</td>
                      <td style={{color:'var(--accent)', fontWeight:600}}>{parseFloat(r._score).toFixed(2)}</td>
                      <td>{r.tpPct}</td>
                      <td>{r.slPct}</td>
                      <td>{r.confluencesRequired}</td>
                      <td>{r.rsiOverbought}</td>
                      <td>{r.rsiOversold}</td>
                      <td>{r.totalClosed}</td>
                      <td>{r.winRate}%</td>
                      <td className="tp-cell">{r.totalNetPct}%</td>
                      <td className={parseFloat(r.maxDrawdownPct) > 30 ? 'sl-cell' : ''}>{r.maxDrawdownPct}%</td>
                      <td><button className="apply-btn" onClick={() => applyParams(r)} title="Aplicar en pestaña Confluencia">▶</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// =============================================================================
// ConfluenceView — Vista principal de la estrategia Confluencia
// =============================================================================
function ConfluenceView() {
  const [params, setParams]   = useState(DEFAULT_CONFLUENCE_PARAMS)
  const [loading, setLoading] = useState(false)
  const [error, setError]     = useState(null)
  const [result, setResult]   = useState(null)
  const [dbStatus, setDbStatus] = useState(null)
  const [activeTab, setActiveTab] = useState('stats')
  const [optimMode, setOptimMode] = useState(false)
  const [optimRanges, setOptimRanges] = useState(DEFAULT_CONFLUENCE_OPTIM)
  const optimBcRef = useRef(null)

  const estimatedCombos = useMemo(() => countConfluenceCombinations(optimRanges), [optimRanges])

  useEffect(() => {
    fetch('/api/status')
      .then(r => r.json())
      .then(d => setDbStatus(d))
      .catch(() => setDbStatus({ connected: false, error: 'No se pudo conectar' }))
  }, [])

  const set    = (key, val) => setParams(p => ({ ...p, [key]: val }))
  const num    = (key, val) => set(key, parseFloat(val) || 0)
  const int    = (key, val) => set(key, parseInt(val)   || 1)
  const setOF  = (field, key, val) =>
    setOptimRanges(r => ({ ...r, [field]: { ...r[field], [key]: parseFloat(val) || 0 } }))

  function applyOptimResult(row) {
    setParams(p => ({
      ...p,
      tpPct:               parseFloat(row.tpPct),
      slPct:               parseFloat(row.slPct),
      confluencesRequired: row.confluencesRequired,
      rsiOverbought:       row.rsiOverbought,
      rsiOversold:         row.rsiOversold,
    }))
  }

  async function handleRun() {
    setLoading(true); setError(null); setResult(null)
    try {
      const resp = await fetch(`/api/candles?from=${params.dateFrom}&to=${params.dateTo}`)
      if (!resp.ok) throw new Error((await resp.json()).error)
      const { candles, total } = await resp.json()
      if (total === 0) throw new Error('No se encontraron velas en ese rango de fechas.')
      const bt = runConfluenceBacktest(candles, params)
      if (!bt) throw new Error('No se pudieron calcular resultados (datos insuficientes).')
      setResult(bt)
      setActiveTab('stats')
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  async function handleOptimize() {
    setError(null)
    try {
      const resp = await fetch(`/api/candles?from=${params.dateFrom}&to=${params.dateTo}`)
      if (!resp.ok) throw new Error((await resp.json()).error)
      const { candles, total } = await resp.json()
      if (total === 0) throw new Error('No se encontraron velas en ese rango de fechas.')

      if (optimBcRef.current) optimBcRef.current.close()
      const bc = new BroadcastChannel('btc-confluence-optim')
      optimBcRef.current = bc
      bc.onmessage = (e) => {
        if (e.data.type === 'ready') bc.postMessage({ type: 'init', candles, optimRanges, params })
        else if (e.data.type === 'apply') applyOptimResult(e.data.row)
      }
      window.open(window.location.pathname + '?strategy=confluence&mode=optim', '_blank')
    } catch (e) {
      setError(e.message)
    }
  }

  const stats   = result?.stats
  const winRate = stats ? parseFloat(stats.winRate)     : 0
  const netPct  = stats ? parseFloat(stats.totalNetPct) : 0

  return (
    <div className="app">
      <header className="header">
        <div className="header-inner">
          <div className="logo">
            <span className="logo-icon">₿</span>
            <div>
              <div className="logo-title">MariaPaz<span style={{color:'var(--accent)'}}>Indicator</span></div>
              <div className="logo-sub">Confluencia · BTCUSDC · 15m</div>
            </div>
          </div>
          <div className={`db-badge ${dbStatus?.connected ? 'connected' : 'disconnected'}`}>
            <span className="db-dot" />
            {dbStatus?.connected
              ? `BD conectada · ${dbStatus.totalCandles?.toLocaleString()} velas`
              : dbStatus?.error ?? 'Conectando...'}
          </div>
        </div>
        <div className="strategy-nav">
          <button className="strategy-tab" onClick={() => { window.location.href = '/' }}>📐 Rango + Resistencias</button>
          <button className="strategy-tab" onClick={() => { window.location.href = '?strategy=sar' }}>📈 SAR</button>
          <button className="strategy-tab" onClick={() => { window.location.href = '?strategy=supertrend' }}>📊 Supertrend</button>
          <button className="strategy-tab active">🎯 Confluencia</button>
          <button className="strategy-tab" onClick={() => { window.location.href = '?strategy=emapullback' }}>📉 EMA Pullback</button>
          <button className="strategy-tab" onClick={() => { window.location.href = '?strategy=pinbar' }}>🕯️ Pin Bar</button>
          <button className="strategy-tab" onClick={() => { window.location.href = '?strategy=soporte' }}>📗 Rango + Soporte</button>
          <button className="strategy-tab" onClick={() => { window.location.href = '?strategy=ema' }}>📡 EMA Touch</button>
          <button className="strategy-tab" onClick={() => { window.location.href = '?strategy=rangehigh' }}>🏔️ Rango Alto</button>
        </div>
      </header>

      <div className="layout">
        {/* ── SIDEBAR ── */}
        <aside className="sidebar">
          <div className="sidebar-scroll">

            <Section title="📅 Rango de fechas">
              <InputGroup label="Desde">
                <input type="date" value={params.dateFrom} onChange={e => set('dateFrom', e.target.value)} />
              </InputGroup>
              <InputGroup label="Hasta">
                <input type="date" value={params.dateTo}   onChange={e => set('dateTo',   e.target.value)} />
              </InputGroup>
            </Section>

            <Section title="📈 EMA (Tendencia)">
              <InputGroup label="EMA rápida" tooltip="Período EMA rápida — identifica tendencia corta">
                <input type="number" value={params.emaFast} step="1" min="5"  onChange={e => int('emaFast', e.target.value)} />
              </InputGroup>
              <InputGroup label="EMA lenta" tooltip="Período EMA lenta — identifica tendencia macro">
                <input type="number" value={params.emaSlow} step="1" min="10" onChange={e => int('emaSlow', e.target.value)} />
              </InputGroup>
            </Section>

            <Section title="📊 RSI (Sobrecompra/Venta)">
              <InputGroup label="RSI período">
                <input type="number" value={params.rsiPeriod}     step="1" min="2" onChange={e => int('rsiPeriod',     e.target.value)} />
              </InputGroup>
              <InputGroup label="Sobrecomprado (short)" tooltip="RSI por encima → señal short">
                <input type="number" value={params.rsiOverbought} step="1" min="50" max="90" onChange={e => int('rsiOverbought', e.target.value)} />
              </InputGroup>
              <InputGroup label="Sobrevendido (long)" tooltip="RSI por debajo → señal long">
                <input type="number" value={params.rsiOversold}   step="1" min="10" max="50" onChange={e => int('rsiOversold',   e.target.value)} />
              </InputGroup>
            </Section>

            <Section title="⚡ MACD (Momentum)">
              <InputGroup label="MACD rápido">
                <input type="number" value={params.macdFast}         step="1" min="2"  onChange={e => int('macdFast',         e.target.value)} />
              </InputGroup>
              <InputGroup label="MACD lento">
                <input type="number" value={params.macdSlow}         step="1" min="5"  onChange={e => int('macdSlow',         e.target.value)} />
              </InputGroup>
              <InputGroup label="MACD señal">
                <input type="number" value={params.macdSignalPeriod} step="1" min="2"  onChange={e => int('macdSignalPeriod', e.target.value)} />
              </InputGroup>
            </Section>

            <Section title="🎯 Bollinger Bands (Volatilidad)">
              <InputGroup label="BB período">
                <input type="number" value={params.bbPeriod} step="1"   min="5"   onChange={e => int('bbPeriod', e.target.value)} />
              </InputGroup>
              <InputGroup label="BB desviaciones" tooltip="Multiplicador de la desviación estándar">
                <input type="number" value={params.bbStdDev} step="0.1" min="0.5" onChange={e => num('bbStdDev', e.target.value)} />
              </InputGroup>
            </Section>

            <Section title="📦 Volumen (Confirmación)">
              <InputGroup label="Volumen MA período">
                <input type="number" value={params.volMAPeriod}   step="1"   min="5"   onChange={e => int('volMAPeriod',   e.target.value)} />
              </InputGroup>
              <InputGroup label="Volumen mínimo (xMA)" tooltip="Vol actual debe ser X veces el promedio">
                <input type="number" value={params.volMultiplier} step="0.1" min="0.5" onChange={e => num('volMultiplier', e.target.value)} />
              </InputGroup>
            </Section>

            <Section title="🔀 Confluencias">
              <InputGroup label="Mín. indicadores requeridos" tooltip="Cuántos de los 5 indicadores deben coincidir para abrir trade (2–5)">
                <input type="number" value={params.confluencesRequired} step="1" min="2" max="5" onChange={e => int('confluencesRequired', e.target.value)} />
              </InputGroup>
              <InputGroup label="Dirección">
                <select value={params.tradeDirection} onChange={e => set('tradeDirection', e.target.value)}
                  style={{background:'var(--surface)',color:'var(--text)',border:'1px solid var(--border)',borderRadius:'var(--radius)',padding:'4px 8px',fontSize:12}}>
                  <option value="both">LONG + SHORT</option>
                  <option value="long">Solo LONG</option>
                  <option value="short">Solo SHORT</option>
                </select>
              </InputGroup>
            </Section>

            <Section title="💰 TP / SL y Capital">
              <InputGroup label="TP (%)">
                <input type="number" value={params.tpPct}          step="0.1"  min="0.1" onChange={e => num('tpPct',          e.target.value)} />
              </InputGroup>
              <InputGroup label="SL (%)">
                <input type="number" value={params.slPct}          step="0.1"  min="0.1" onChange={e => num('slPct',          e.target.value)} />
              </InputGroup>
              <InputGroup label="Fee extra SL (%)">
                <input type="number" value={params.feeSlPct}       step="0.01" min="0"   onChange={e => num('feeSlPct',       e.target.value)} />
              </InputGroup>
              <InputGroup label="Fee descontado TP (%)">
                <input type="number" value={params.feeTpPct}       step="0.01" min="0"   onChange={e => num('feeTpPct',       e.target.value)} />
              </InputGroup>
              <InputGroup label="Apalancamiento">
                <input type="number" value={params.leverage}       step="1"    min="1"   onChange={e => num('leverage',       e.target.value)} />
              </InputGroup>
              <InputGroup label="Capital inicial ($)">
                <input type="number" value={params.initialCapital} step="100"  min="1"   onChange={e => num('initialCapital', e.target.value)} />
              </InputGroup>
            </Section>

            <Section title="🔬 Análisis Profundo">
              <InputGroup label="Activar optimización">
                <label className="toggle">
                  <input type="checkbox" checked={optimMode} onChange={e => setOptimMode(e.target.checked)} />
                  <span className="toggle-track"><span className="toggle-thumb" /></span>
                </label>
              </InputGroup>
              {optimMode && (
                <>
                  <div className="optim-hint">Min · Max · Paso</div>
                  <OptimRow label="TP (%)"        field="tpPct"               stepHint="1"   ranges={optimRanges} onChange={setOF} />
                  <OptimRow label="SL (%)"        field="slPct"               stepHint="0.5" ranges={optimRanges} onChange={setOF} />
                  <OptimRow label="Confluencias"  field="confluencesRequired" stepHint="1"   ranges={optimRanges} onChange={setOF} />
                  <OptimRow label="RSI OB"        field="rsiOverbought"       stepHint="5"   ranges={optimRanges} onChange={setOF} />
                  <div className="optim-combos">{estimatedCombos.toLocaleString()} combinaciones</div>
                </>
              )}
            </Section>

          </div>
          <div className="sidebar-footer">
            {optimMode
              ? <button className="run-btn optim-btn" onClick={handleOptimize} disabled={!dbStatus?.connected}>
                  🔬 Abrir Análisis Profundo
                </button>
              : <button className="run-btn" onClick={handleRun} disabled={loading || !dbStatus?.connected}>
                  {loading ? <><span className="spinner" /> Procesando...</> : '▶ Ejecutar Backtest'}
                </button>
            }
            {error && <div className="error-box">⚠️ {error}</div>}
          </div>
        </aside>

        {/* ── MAIN ── */}
        <main className="main">
          {!result && !loading && (
            <div className="empty-state">
              <div className="empty-icon">🎯</div>
              <div className="empty-title">Confluencia</div>
              <div className="empty-sub">
                Señal cuando al menos <strong>{params.confluencesRequired} de 5</strong> indicadores coinciden:
                EMA · RSI · MACD · Volumen · Bollinger Bands
              </div>
            </div>
          )}

          {loading && (
            <div className="empty-state">
              <div className="loading-ring" />
              <div className="empty-title">Analizando velas...</div>
              <div className="empty-sub">Calculando EMA · RSI · MACD · BB · Volumen</div>
            </div>
          )}

          {result && !loading && (
            <>
              <div className="result-header">
                <div className="result-meta">
                  <span>📊 {result.totalCandles.toLocaleString()} velas</span>
                  <span>·</span>
                  <span>{params.dateFrom} → {params.dateTo}</span>
                </div>
                <div className="tabs">
                  <button className={activeTab === 'stats'   ? 'tab active' : 'tab'} onClick={() => setActiveTab('stats')}>Estadísticas</button>
                  <button className={activeTab === 'trades'  ? 'tab active' : 'tab'} onClick={() => setActiveTab('trades')}>Trades ({result.trades.length})</button>
                  <button className={activeTab === 'signals' ? 'tab active' : 'tab'} onClick={() => setActiveTab('signals')}>Señales ({result.signals.length})</button>
                </div>
              </div>

              {activeTab === 'stats' && (
                <>
                  <div className="stats-grid">
                    <StatCard label="Trades cerrados"                      value={stats.totalClosed}    variant="neutral" />
                    <StatCard label="TP ✅"                                 value={stats.totalTp}        variant="win" />
                    <StatCard label="SL ❌"                                 value={stats.totalSl}        variant="loss" />
                    <StatCard label="Win Rate"                              value={`${stats.winRate}%`}  variant={winRate >= 50 ? 'win' : 'loss'} />
                    <StatCard label={`Ganancia acum. x${params.leverage}`} value={`${stats.totalProfitPct}%`} variant="win" />
                    <StatCard label={`Pérdida acum. x${params.leverage}`}  value={`${stats.totalLossPct}%`}  variant="loss" />
                    <StatCard label={`Neto x${params.leverage}`}           value={`${stats.totalNetPct}%`}   variant={netPct >= 0 ? 'win' : 'loss'} />
                    <StatCard label="Máx. Drawdown"                        value={`${stats.maxDrawdownPct}%`} variant="warn" />
                    <StatCard label="Capital simple"    value={`$${parseFloat(stats.simpleCapital).toLocaleString('es-CO',{minimumFractionDigits:2})}`}   variant="neutral" />
                    <StatCard label="Capital compuesto" value={`$${parseFloat(stats.compoundCapital).toLocaleString('es-CO',{minimumFractionDigits:2})}`} variant="accent" />
                    <StatCard label="Mejor método"                         value={stats.bestMethod}     variant="accent" />
                    <StatCard label={`TP efectivo x${params.leverage}`}    value={`${stats.effectiveTpPct}%`} variant="neutral" />
                    <StatCard label={`SL efectivo x${params.leverage}`}    value={`${stats.effectiveSlPct}%`} variant="neutral" />
                  </div>

                  {result.trades.length > 0 && (() => {
                    const { byYear, byMonth } = computePeriodStats(result.trades, stats.effectiveTpPct, stats.effectiveSlPct)
                    return <>
                      <PeriodTable title="📅 Acumulado por año"  rows={byYear}  />
                      <PeriodTable title="📆 Acumulado por mes"  rows={byMonth} />
                    </>
                  })()}
                </>
              )}

              {activeTab === 'trades' && (
                <div className="table-wrap">
                  {result.trades.length === 0
                    ? <div className="empty-table">No se cerraron trades en este período</div>
                    : (
                      <table className="data-table">
                        <thead>
                          <tr>
                            <th>#</th><th>Lado</th><th>Apertura</th><th>Entrada</th>
                            <th>TP</th><th>SL</th><th>Cierre</th><th>Resultado</th>
                            <th>Capital entrada</th><th>Capital salida</th>
                          </tr>
                        </thead>
                        <tbody>
                          {result.trades.map((t, i) => (
                            <tr key={i} className={t.result === 'TP' ? 'row-win' : 'row-loss'}>
                              <td>{i + 1}</td>
                              <td><span className={`badge badge-${t.side === 'LONG' ? 'tp' : 'sl'}`}>{t.side === 'LONG' ? '▲ LONG' : '▼ SHORT'}</span></td>
                              <td style={{fontFamily:'var(--font-mono)',fontSize:11}}>{new Date(t.time).toLocaleString('es-CO',{timeZone:'UTC'})}</td>
                              <td style={{fontFamily:'var(--font-mono)'}}>${parseFloat(t.price).toLocaleString('en-US')}</td>
                              <td className="tp-cell" style={{fontFamily:'var(--font-mono)'}}>${parseFloat(t.tp).toLocaleString('en-US')}</td>
                              <td className="sl-cell" style={{fontFamily:'var(--font-mono)'}}>${parseFloat(t.sl).toLocaleString('en-US')}</td>
                              <td style={{fontFamily:'var(--font-mono)',fontSize:11}}>{new Date(t.closeTime).toLocaleString('es-CO',{timeZone:'UTC'})}</td>
                              <td><span className={`badge badge-${t.result.toLowerCase()}`}>{t.result === 'TP' ? '✅ TP' : '❌ SL'}</span></td>
                              <td>${parseFloat(t.capitalAtEntry).toLocaleString('es-CO',{minimumFractionDigits:2,maximumFractionDigits:2})}</td>
                              <td className={t.result === 'TP' ? 'tp-cell' : 'sl-cell'}>${parseFloat(t.capitalAtExit).toLocaleString('es-CO',{minimumFractionDigits:2,maximumFractionDigits:2})}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )
                  }
                </div>
              )}

              {activeTab === 'signals' && (
                <div className="table-wrap">
                  {result.signals.length === 0
                    ? <div className="empty-table">No se generaron señales en este período</div>
                    : (
                      <table className="data-table">
                        <thead>
                          <tr>
                            <th>#</th><th>Fecha</th><th>Tipo</th><th>Precio</th><th>Confluencias</th>
                          </tr>
                        </thead>
                        <tbody>
                          {result.signals.map((s, i) => (
                            <tr key={i}>
                              <td>{i + 1}</td>
                              <td style={{fontFamily:'var(--font-mono)',fontSize:11}}>{new Date(s.time).toLocaleString('es-CO',{timeZone:'UTC'})}</td>
                              <td><span className={`badge badge-${s.type === 'LONG' ? 'tp' : 'sl'}`}>{s.type === 'LONG' ? '▲ LONG' : '▼ SHORT'}</span></td>
                              <td style={{fontFamily:'var(--font-mono)'}}>${parseFloat(s.price).toLocaleString('en-US')}</td>
                              <td style={{fontFamily:'var(--font-mono)',color:'var(--accent)'}}>{s.confluences} / 5</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )
                  }
                </div>
              )}
            </>
          )}
        </main>
      </div>
    </div>
  )
}

// =============================================================================
// SoporteExcelOptimView — Multi-Combo Excel para Rango + Soporte (LONG)
// =============================================================================
function SoporteExcelOptimView() {
  const [combos, setCombos]         = useState([])
  const [fileName, setFileName]     = useState('')
  const [candles, setCandles]       = useState(null)
  const [status, setStatus]         = useState('idle')
  const [progress, setProgress]     = useState(null)
  const [ranking, setRanking]       = useState([])
  const [errorMsg, setErrorMsg]     = useState('')
  const [dateFrom, setDateFrom]     = useState('2022-01-01')
  const [dateTo, setDateTo]         = useState(new Date().toISOString().split('T')[0])
  const [params, setParams]         = useState({ feeSlPct: 0.10, feeTpPct: 0.05, leverage: 10, initialCapital: 1000, emaMinGapPct: 0 })
  const [sortKey, setSortKey]       = useState('_score')
  const [sortDir, setSortDir]       = useState('desc')
  const [showCombos, setShowCombos] = useState(false)
  const [minTrades, setMinTrades]   = useState(0)
  const [maxTrades, setMaxTrades]   = useState(9999)
  const startTimeRef  = useRef(null)
  const workerRef     = useRef(null)
  const fileInputRef  = useRef(null)

  function parseNum(v) {
    if (typeof v === 'number') return v
    if (typeof v === 'string') return parseFloat(v.replace(',', '.'))
    return NaN
  }

  function handleFile(e) {
    const file = e.target.files[0]
    if (!file) return
    setFileName(file.name)
    const reader = new FileReader()
    reader.onload = (ev) => {
      const wb = XLSX.read(ev.target.result, { type: 'array' })
      const ws = wb.Sheets[wb.SheetNames[0]]
      const rows = XLSX.utils.sheet_to_json(ws, { defval: '' })
      const parsed = rows.map(row => ({
        minRangePct:     parseNum(row['Min%']    ?? row['minRangePct']  ?? row['MinRange%']),
        maxRangePct:     parseNum(row['Max%']    ?? row['maxRangePct']  ?? row['MaxRange%']),
        lookbackCandles: Math.round(parseNum(row['LB'] ?? row['lookbackCandles'] ?? row['Lookback'])),
        minWickPct:      parseNum(row['Mecha%']  ?? row['minWickPct']  ?? row['Wick%']),
        slPct:           parseNum(row['SL%']     ?? row['slPct']),
        tpPct:           parseNum(row['TP%']     ?? row['tpPct']),
        _score:          parseNum(row['Score']   ?? row['_score'] ?? 0),
      })).filter(c =>
        !isNaN(c.minRangePct) && !isNaN(c.maxRangePct) &&
        !isNaN(c.lookbackCandles) && !isNaN(c.minWickPct) &&
        !isNaN(c.slPct) && !isNaN(c.tpPct)
      )
      setCombos(parsed)
      setRanking([])
      setStatus('idle')
    }
    reader.readAsArrayBuffer(file)
  }

  async function handleLoadCandles() {
    setStatus('loadingCandles')
    setErrorMsg('')
    try {
      const res = await fetch(`http://localhost:3001/api/candles?from=${dateFrom}&to=${dateTo}`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Error cargando velas')
      setCandles(data.candles)
      setStatus('idle')
    } catch (err) {
      setErrorMsg(err.message)
      setStatus('error')
    }
  }

  function handleRun() {
    if (!candles || combos.length < 3) return
    workerRef.current?.terminate()
    setStatus('running')
    setRanking([])
    setProgress(null)
    startTimeRef.current = Date.now()

    const worker = new Worker(new URL('./soporteExcelMultiWorker.js', import.meta.url), { type: 'module' })
    workerRef.current = worker
    worker.onmessage = (ev) => {
      const m = ev.data
      if (m.type === 'progress') {
        const elapsed = Date.now() - startTimeRef.current
        let eta = null
        if (m.done >= 50 && elapsed >= 500) eta = Math.round((m.total - m.done) / (m.done / elapsed))
        setProgress({ done: m.done, total: m.total, eta })
        if (m.topResults?.length > 0) setRanking(m.topResults)
      } else if (m.type === 'done') {
        setStatus('done')
        setProgress(p => p ? { ...p, done: p.total } : null)
        if (m.results?.length > 0) setRanking(m.results)
        worker.terminate()
      } else if (m.type === 'error') {
        setErrorMsg(m.message)
        setStatus('error')
        worker.terminate()
      }
    }
    worker.onerror = (ev) => { setErrorMsg(ev.message); setStatus('error'); worker.terminate() }
    worker.postMessage({ combos, candles, params, groupSizes: [3,4,5,6,7,8,9,10,11,12,13,14,15], samplesPerSize: 5000 })
  }

  function handleSort(key) {
    if (sortKey === key) setSortDir(d => d === 'desc' ? 'asc' : 'desc')
    else { setSortKey(key); setSortDir('desc') }
  }

  const sortedRanking = useMemo(() => {
    if (!ranking.length) return []
    return [...ranking]
      .filter(r => {
        const tc = parseInt(r.totalClosed)
        return tc >= minTrades && tc <= maxTrades
      })
      .sort((a, b) => {
        const av = parseFloat(a[sortKey] ?? 0)
        const bv = parseFloat(b[sortKey] ?? 0)
        return sortDir === 'desc' ? bv - av : av - bv
      })
  }, [ranking, sortKey, sortDir, minTrades, maxTrades])

  function fmtEta(ms) {
    if (!ms) return ''
    const s = Math.round(ms / 1000)
    return s < 60 ? `~${s}s` : `~${Math.floor(s/60)}m ${s%60}s`
  }

  function SortTh({ col, label }) {
    const active = sortKey === col
    return (
      <th onClick={() => handleSort(col)}
        style={{cursor:'pointer', userSelect:'none', color: active ? 'var(--accent)' : undefined, whiteSpace:'nowrap'}}>
        {label}{' '}{active
          ? (sortDir === 'desc' ? '▼' : '▲')
          : <span style={{opacity:0.25}}>▼</span>}
      </th>
    )
  }

  function comboLabel(c) {
    return `Min${c.minRangePct} Max${c.maxRangePct} LB${c.lookbackCandles} W${c.minWickPct} SL${c.slPct} TP${c.tpPct}`
  }

  const pct = progress ? Math.round(progress.done / progress.total * 100) : 0
  const isRunning        = status === 'running'
  const isLoadingCandles = status === 'loadingCandles'
  const canRun = candles && combos.length >= 3 && !isRunning && !isLoadingCandles

  const inputStyle = { width:'100%', background:'var(--bg)', border:'1px solid var(--border)', borderRadius:'var(--radius)', color:'var(--text)', padding:'7px 10px', fontFamily:'var(--font-mono)', fontSize:13 }

  return (
    <div className="optim-page">

      <header className="optim-page-header">
        <div className="logo">
          <span className="logo-icon">₿</span>
          <div>
            <div className="logo-title">MariaPaz<span style={{color:'var(--accent)'}}>Indicator</span></div>
            <div className="logo-sub">📗 Multi-Combo Soporte · LONG · Desde Excel</div>
          </div>
        </div>
        <div className="optim-page-status">
          {status === 'idle' && combos.length === 0 && 'Carga un archivo Excel para comenzar'}
          {status === 'idle' && combos.length > 0 && !candles && `${combos.length} combos cargados · Carga velas para continuar`}
          {status === 'idle' && combos.length > 0 && candles && `${combos.length} combos · ${candles.length.toLocaleString()} velas · Listo`}
          {isLoadingCandles && 'Cargando velas desde BD...'}
          {isRunning && progress && (
            <span>
              {progress.done.toLocaleString()} / {progress.total.toLocaleString()} · {pct}%
              {progress.eta != null && ` · faltan ${fmtEta(progress.eta)}`}
              {' · '}{ranking.length} grupos
            </span>
          )}
          {status === 'done' && <span style={{color:'var(--green)'}}>✅ Completado · {ranking.length} grupos</span>}
          {status === 'error' && <span style={{color:'var(--red)'}}>⚠️ {errorMsg}</span>}
        </div>
      </header>

      {(isRunning || status === 'done') && progress && (
        <div className="optim-page-progress">
          <div className="progress-track" style={{borderRadius:0, height:3}}>
            <div className="progress-fill" style={{width:`${pct}%`, transition:'width 0.5s ease'}}/>
          </div>
        </div>
      )}

      <div className="optim-page-body">

        <div style={{background:'var(--bg-2)', border:'1px solid var(--border)', borderRadius:'var(--radius-lg)', padding:'20px 24px', marginBottom:20}}>
          <div style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap:24}}>

            <div style={{display:'flex', flexDirection:'column', gap:14}}>
              <div>
                <div className="optim-label" style={{marginBottom:6}}>Archivo Excel (ranking Análisis Profundo Soporte)</div>
                <input ref={fileInputRef} type="file" accept=".xlsx,.xls" onChange={handleFile} style={{display:'none'}}/>
                <div style={{display:'flex', alignItems:'center', gap:10}}>
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    style={{...inputStyle, width:'auto', padding:'7px 14px', cursor:'pointer', background:'var(--bg-3)', fontFamily:'var(--font-ui)', fontWeight:600, fontSize:13, border:'1px solid var(--border-light)'}}>
                    📂 Seleccionar archivo
                  </button>
                  {fileName
                    ? <div style={{fontSize:12, fontFamily:'var(--font-mono)', lineHeight:1.4}}>
                        <div style={{color:'var(--green)'}}>✓ {fileName}</div>
                        <div style={{color:'var(--text-muted)'}}>{combos.length} combos válidos</div>
                      </div>
                    : <span style={{fontSize:12, color:'var(--text-muted)', fontFamily:'var(--font-mono)'}}>Sin archivo seleccionado</span>
                  }
                </div>
              </div>
              <div style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap:10}}>
                <div>
                  <div className="optim-label" style={{marginBottom:4}}>Desde</div>
                  <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} style={inputStyle}/>
                </div>
                <div>
                  <div className="optim-label" style={{marginBottom:4}}>Hasta</div>
                  <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} style={inputStyle}/>
                </div>
              </div>
              <button className="run-btn" style={{padding:'9px'}} onClick={handleLoadCandles} disabled={isLoadingCandles || isRunning}>
                {isLoadingCandles ? <><span className="spinner"/> Cargando velas...</> : '📥 Cargar velas desde BD'}
              </button>
            </div>

            <div style={{display:'flex', flexDirection:'column', gap:14}}>
              <div style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap:10}}>
                {[['Fee SL%','feeSlPct',0.01],['Fee TP%','feeTpPct',0.01],['Apalancamiento','leverage',1],['Capital inicial $','initialCapital',100],['Dist. EMA mín %','emaMinGapPct',0.01]].map(([label, key, step]) => (
                  <div key={key}>
                    <div className="optim-label" style={{marginBottom:4}}>{label}</div>
                    <input type="number" step={step} value={params[key]}
                      onChange={e => setParams(p => ({...p, [key]: parseFloat(e.target.value)}))}
                      style={inputStyle}/>
                  </div>
                ))}
              </div>
              <div style={{marginTop:'auto'}}>
                {status === 'error' && (
                  <div style={{marginBottom:8, padding:'8px 12px', background:'var(--red-dim)', border:'1px solid rgba(239,68,68,0.3)', borderRadius:'var(--radius)', fontSize:12, color:'var(--red)', fontFamily:'var(--font-mono)'}}>
                    ⚠️ {errorMsg}
                  </div>
                )}
                <button className="run-btn optim-btn" style={{width:'100%', padding:11}} onClick={handleRun} disabled={!canRun}>
                  {isRunning
                    ? <><span className="spinner"/> Analizando grupos de 3–15 combos LONG...</>
                    : `🎲 Buscar mejores combinaciones (${combos.length} combos)`}
                </button>
                <div style={{fontSize:11, color:'var(--text-muted)', textAlign:'center', marginTop:6, fontFamily:'var(--font-mono)'}}>
                  Grupos de 3 al 15 combos · 5 000 muestras por tamaño · drawdown ≤ 50%
                </div>
              </div>
            </div>
          </div>
        </div>

        {combos.length > 0 && (
          <div style={{marginBottom:16}}>
            <button onClick={() => setShowCombos(v => !v)}
              style={{background:'none', border:'none', color:'var(--text-muted)', fontSize:12, fontFamily:'var(--font-mono)', cursor:'pointer', padding:'4px 0', display:'flex', alignItems:'center', gap:6}}>
              {showCombos ? '▼' : '▶'} Ver combos cargados ({combos.length})
            </button>
            {showCombos && (
              <div className="table-wrap" style={{marginTop:8}}>
                <table className="data-table">
                  <thead>
                    <tr><th>#</th><th>Min%</th><th>Max%</th><th>LB</th><th>Mecha%</th><th>SL%</th><th>TP%</th><th>Score</th></tr>
                  </thead>
                  <tbody>
                    {combos.map((c, i) => (
                      <tr key={i}>
                        <td style={{color:'var(--text-muted)'}}>{i+1}</td>
                        <td>{c.minRangePct}</td><td>{c.maxRangePct}</td>
                        <td>{c.lookbackCandles}</td><td>{c.minWickPct}</td>
                        <td>{c.slPct}</td><td>{c.tpPct}</td>
                        <td style={{color:'var(--accent)', fontWeight:600}}>{c._score.toFixed(1)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {ranking.length > 0 && (
          <>
            <div className="optim-rank-meta" style={{display:'flex', alignItems:'center', justifyContent:'space-between', flexWrap:'wrap', gap:10}}>
              <span>{sortedRanking.length} / {ranking.length} grupos · Score = Neto% ÷ Drawdown% · drawdown ≤ 50%{isRunning && ' · actualizando en vivo...'}</span>
              <div style={{display:'flex', alignItems:'center', gap:8, fontSize:12, fontFamily:'var(--font-mono)'}}>
                <span style={{color:'var(--text-muted)'}}>Trades:</span>
                <input type="number" min={0} value={minTrades} onChange={e => setMinTrades(Math.max(0, parseInt(e.target.value) || 0))}
                  style={{width:60, background:'var(--bg)', border:'1px solid var(--border)', borderRadius:'var(--radius)', color:'var(--text)', padding:'3px 7px', fontFamily:'var(--font-mono)', fontSize:12, textAlign:'center'}}
                  title="Mínimo de trades"/>
                <span style={{color:'var(--text-muted)'}}>–</span>
                <input type="number" min={0} value={maxTrades} onChange={e => setMaxTrades(Math.max(0, parseInt(e.target.value) || 9999))}
                  style={{width:60, background:'var(--bg)', border:'1px solid var(--border)', borderRadius:'var(--radius)', color:'var(--text)', padding:'3px 7px', fontFamily:'var(--font-mono)', fontSize:12, textAlign:'center'}}
                  title="Máximo de trades"/>
              </div>
            </div>
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <SortTh col="_score"          label="Score"/>
                    <SortTh col="size"            label="Combos"/>
                    <th>Parámetros</th>
                    <SortTh col="totalClosed"     label="Trades"/>
                    <SortTh col="winRate"         label="Win%"/>
                    <SortTh col="totalNetPct"     label="Neto%"/>
                    <SortTh col="maxDrawdownPct"  label="Drawdown%"/>
                    <SortTh col="compoundCapital" label="Capital $"/>
                  </tr>
                </thead>
                <tbody>
                  {sortedRanking.map((r, i) => {
                    const net = parseFloat(r.totalNetPct)
                    const dd  = parseFloat(r.maxDrawdownPct)
                    const sizeColors = { 3:['var(--blue-dim)','var(--blue)'], 4:['var(--green-dim)','var(--green)'], 5:['var(--accent-dim)','var(--accent)'], 6:['var(--orange-dim)','var(--orange)'], 7:['var(--red-dim)','var(--red)'] }
                    const [bgC, fgC] = sizeColors[r.size] ?? ['var(--bg-3)','var(--text)']
                    return (
                      <tr key={i} className="row-win">
                        <td style={{color:'var(--text-muted)'}}>{i+1}</td>
                        <td style={{color:'var(--accent)', fontWeight:700}}>{r._score.toFixed(2)}</td>
                        <td style={{textAlign:'center'}}>
                          <span style={{padding:'2px 10px', borderRadius:20, fontSize:11, fontWeight:600, background:bgC, color:fgC}}>{r.size}</span>
                        </td>
                        <td style={{fontSize:10, lineHeight:1.8}}>
                          {r.combos.map((c, ci) => (
                            <div key={ci} style={{whiteSpace:'nowrap'}}>
                              <span style={{color:'var(--text-muted)', marginRight:5}}>#{c.idx+1}</span>
                              <span style={{color:'var(--text-dim)'}}>{comboLabel(c)}</span>
                            </div>
                          ))}
                        </td>
                        <td>{r.totalClosed}</td>
                        <td>{r.winRate}%</td>
                        <td className={net >= 0 ? 'tp-cell' : 'sl-cell'}>{r.totalNetPct}%</td>
                        <td className={dd > 30 ? 'sl-cell' : ''}>{r.maxDrawdownPct}%</td>
                        <td style={{fontWeight:600}}>
                          ${parseFloat(r.compoundCapital).toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2})}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}

      </div>
    </div>
  )
}

// =============================================================================
// SoporteOptimView — Análisis profundo Rango + Soporte (pestaña nueva)
// =============================================================================
function SoporteOptimView() {
  const [status, setStatus]     = useState('waiting')
  const [progress, setProgress] = useState(null)
  const [ranking, setRanking]   = useState([])
  const [errorMsg, setErrorMsg] = useState('')
  const startTimeRef = useRef(null)
  const bcRef        = useRef(null)

  useEffect(() => {
    const bc = new BroadcastChannel('btc-soporte-optim')
    bcRef.current = bc

    const sendReady = () => bc.postMessage({ type: 'ready' })
    sendReady()
    const retryTimer = setTimeout(sendReady, 1500)

    bc.onmessage = (e) => {
      const msg = e.data
      if (msg.type === 'init') {
        clearTimeout(retryTimer)
        const { candles, optimRanges, params } = msg
        setStatus('running')
        startTimeRef.current = Date.now()

        const allLb = optRangeValues(
          optimRanges.lookbackCandles.min,
          optimRanges.lookbackCandles.max,
          optimRanges.lookbackCandles.step
        ).map(v => Math.round(v))
        const chunks = chunkArray(allLb, Math.min(navigator.hardwareConcurrency || 4, allLb.length))
        const numWorkers = chunks.length

        const wpDone    = new Array(numWorkers).fill(0)
        const wpTotal   = new Array(numWorkers).fill(0)
        const wpResults = new Array(numWorkers).fill(null)
        let doneCount = 0
        const workersArr = []

        chunks.forEach((subset, wi) => {
          const w = new Worker(new URL('./soporteOptimWorker.js', import.meta.url), { type: 'module' })
          w.onmessage = (ev) => {
            const m = ev.data
            if (m.type === 'progress') {
              wpDone[wi] = m.done
              wpTotal[wi] = m.total
              if (m.topResults?.length) wpResults[wi] = m.topResults
              const totalDone = wpDone.reduce((s, v) => s + v, 0)
              const totalAll  = wpTotal.reduce((s, v) => s + v, 0)
              const elapsed = Date.now() - startTimeRef.current
              const eta = (totalDone >= 100 && elapsed >= 500)
                ? Math.round((totalAll - totalDone) / (totalDone / elapsed)) : null
              setProgress({ done: totalDone, total: totalAll, eta })
              const merged = mergeWorkerRankings(wpResults)
              if (merged.length) setRanking(merged)
            } else if (m.type === 'done') {
              wpDone[wi] = wpTotal[wi]
              wpResults[wi] = m.results ?? []
              doneCount++
              w.terminate()
              if (doneCount === numWorkers) {
                setStatus('done')
                setProgress(p => p ? { ...p, done: p.total } : null)
                setRanking(mergeWorkerRankings(wpResults))
              }
            } else if (m.type === 'error') {
              setErrorMsg(m.message); setStatus('error')
              workersArr.forEach(wk => wk.terminate())
            }
          }
          w.onerror = (ev) => {
            setErrorMsg(ev.message); setStatus('error')
            workersArr.forEach(wk => wk.terminate())
          }
          w.postMessage({ candles, optimRanges, params, lookbackSubset: subset })
          workersArr.push(w)
        })
      }
    }

    return () => { clearTimeout(retryTimer); bc.close() }
  }, [])

  function applyParams(row) { bcRef.current?.postMessage({ type: 'apply', row }) }

  function handleExportExcel() {
    const rows = ranking.map((r, i) => ({
      '#':         i + 1,
      'Score':     parseFloat(r._score?.toFixed(4)),
      'Min%':      r.minRangePct,
      'Max%':      r.maxRangePct,
      'LB':        r.lookbackCandles,
      'Mecha%':    r.minWickPct,
      'SL%':       r.slPct,
      'TP%':       r.tpPct,
      'Trades':    r.totalClosed,
      'Win%':      r.winRate,
      'Neto%':     r.totalNetPct,
      'Drawdown%': r.maxDrawdownPct,
      'Capital':   parseFloat(r.compoundCapital),
    }))
    const ws = XLSX.utils.json_to_sheet(rows)
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Análisis Profundo Soporte')
    XLSX.writeFile(wb, 'analisis_profundo_soporte.xlsx')
  }

  const pct = progress ? Math.round(progress.done / progress.total * 100) : 0

  return (
    <div className="optim-page">
      <header className="optim-page-header">
        <div className="logo">
          <span className="logo-icon">₿</span>
          <div>
            <div className="logo-title">MariaPaz<span style={{color:'var(--accent)'}}>Indicator</span></div>
            <div className="logo-sub">🔬 Rango + Soporte · Análisis Profundo · Ranking en vivo</div>
          </div>
        </div>
        <div className="optim-page-status">
          {status === 'waiting' && 'Esperando datos de la pestaña Rango + Soporte...'}
          {status === 'running' && progress && (
            <span>
              {progress.done.toLocaleString()} / {progress.total.toLocaleString()} · {pct}%
              {progress.eta != null && ` · faltan ${formatEta(progress.eta)}`}
              {' · '}{ranking.length} en ranking
            </span>
          )}
          {status === 'done' && <span style={{color:'var(--green)'}}>✅ Completado · {ranking.length} en ranking</span>}
          {status === 'error' && <span style={{color:'var(--red)'}}>⚠️ {errorMsg}</span>}
        </div>
      </header>

      {progress && (
        <div className="optim-page-progress">
          <div className="progress-track" style={{borderRadius:0, height:3}}>
            <div className="progress-fill" style={{width:`${pct}%`, transition:'width 0.5s ease'}} />
          </div>
        </div>
      )}

      <div className="optim-page-body">
        {status === 'waiting' && (
          <div className="optim-page-waiting">
            <div className="loading-ring" />
            <div>Esperando datos del análisis profundo...</div>
            <div style={{fontSize:12}}>Haz clic en "🔬 Abrir Análisis Profundo" en la pestaña Rango + Soporte</div>
          </div>
        )}

        {status === 'done' && ranking.length >= 2 && (
          <button
            className="run-btn optim-btn"
            style={{width:'100%', marginBottom:8, background:'var(--green)', color:'#000'}}
            onClick={handleExportExcel}
          >
            📥 Exportar ranking a Excel (para Multi-Combo Soporte)
          </button>
        )}

        {ranking.length > 0 && (
          <>
            <div className="optim-rank-meta">
              Ranking por Score = Neto% ÷ Drawdown% · filtro: drawdown ≤ 30% · top por rango
              {status === 'running' && ' · actualizando en vivo...'}
            </div>
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Score</th>
                    <th>Min%</th><th>Max%</th><th>LB</th><th>Mecha%</th><th>SL%</th><th>TP%</th>
                    <th>Trades</th><th>Win%</th><th>Neto%</th><th>Drawdown%</th><th>Capital $</th>
                    <th>Aplicar</th>
                  </tr>
                </thead>
                <tbody>
                  {ranking.map((r, i) => (
                    <tr key={i} className="row-win">
                      <td>{i + 1}</td>
                      <td style={{color:'var(--accent)', fontWeight:600}}>{r._score?.toFixed(2)}</td>
                      <td>{r.minRangePct}</td>
                      <td>{r.maxRangePct}</td>
                      <td>{r.lookbackCandles}</td>
                      <td>{r.minWickPct}</td>
                      <td>{r.slPct}</td>
                      <td>{r.tpPct}</td>
                      <td>{r.totalClosed}</td>
                      <td>{r.winRate}%</td>
                      <td className="tp-cell">{r.totalNetPct}%</td>
                      <td className={parseFloat(r.maxDrawdownPct) > 30 ? 'sl-cell' : ''}>{r.maxDrawdownPct}%</td>
                      <td>${parseFloat(r.compoundCapital).toLocaleString('es-CO', {minimumFractionDigits:2})}</td>
                      <td><button className="apply-btn" onClick={() => applyParams(r)} title="Aplicar en pestaña Rango + Soporte">▶</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// =============================================================================
// SoporteView — Vista principal Rango + Soporte
// =============================================================================
function SoporteView() {
  const [params, setParams]       = useState(DEFAULT_SOPORTE_PARAMS)
  const [result, setResult]       = useState(null)
  const [loading, setLoading]     = useState(false)
  const [error, setError]         = useState(null)
  const [dbStatus, setDbStatus]   = useState(null)
  const [activeTab, setActiveTab] = useState('stats')
  const [optimMode, setOptimMode] = useState(false)
  const [optimRanges, setOptimRanges] = useState(DEFAULT_SOPORTE_OPTIM)
  const optimBcRef = useRef(null)
  const [multiMode, setMultiMode] = useState(false)
  const [multiCombos, setMultiCombos] = useState(DEFAULT_SOPORTE_MULTI_COMBOS)

  const estimatedCombos = useMemo(() => countSoporteCombinations(optimRanges), [optimRanges])

  useEffect(() => {
    fetch('/api/status')
      .then(r => r.json())
      .then(d => setDbStatus(d))
      .catch(() => setDbStatus({ connected: false, error: 'No se pudo conectar al servidor' }))
  }, [])

  const set = (key, val) => setParams(p => ({ ...p, [key]: val }))
  const num = (key, val) => set(key, parseFloat(val) || 0)
  const int = (key, val) => set(key, parseInt(val) || 1)

  const setOptimField = (field, key, val) =>
    setOptimRanges(r => ({ ...r, [field]: { ...r[field], [key]: parseFloat(val) || 0 } }))

  function applyOptimResult(row) {
    setParams(p => ({
      ...p,
      minRangePct:     row.minRangePct,
      maxRangePct:     row.maxRangePct,
      lookbackCandles: row.lookbackCandles,
      minWickPct:      row.minWickPct,
      slPct:           row.slPct,
      tpPct:           row.tpPct,
    }))
  }

  useEffect(() => {
    const bc = new BroadcastChannel('btc-soporte-optim')
    optimBcRef.current = bc
    bc.onmessage = (e) => {
      if (e.data.type === 'ready') {
        bc.postMessage({ type: 'init', candles: [], optimRanges, params })
      } else if (e.data.type === 'apply') {
        applyOptimResult(e.data.row)
      }
    }
    return () => bc.close()
  }, [])

  async function handleRun() {
    setLoading(true); setError(null); setResult(null)
    try {
      const resp = await fetch(`/api/candles?from=${params.dateFrom}&to=${params.dateTo}`)
      if (!resp.ok) throw new Error((await resp.json()).error)
      const { candles, total } = await resp.json()
      if (!total) throw new Error('No se encontraron velas en ese rango de fechas.')
      const bt = runSoporteBacktest(candles, params)
      if (!bt) throw new Error('No se pudieron calcular resultados.')
      setResult({ ...bt, totalCandles: total })
      setActiveTab('stats')
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  function handleDownloadDebug() {
    if (!result?.debugLog) return
    const blob = new Blob([JSON.stringify(result.debugLog, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = `debug_soporte_${params.dateFrom}_${params.dateTo}.json`; a.click()
    URL.revokeObjectURL(url)
  }

  const addSoporteCombo = () => setMultiCombos(cs =>
    cs.length < 15
      ? [...cs, { ...DEFAULT_SOPORTE_MULTI_COMBOS[0], label: `Combo ${cs.length + 1}` }]
      : cs
  )
  const removeSoporteCombo = (ci) => setMultiCombos(cs => cs.filter((_, i) => i !== ci))
  const updateSoporteCombo = (ci, key, raw) => {
    const val = key === 'lookbackCandles' ? parseInt(raw) || 1 : parseFloat(raw) || 0
    setMultiCombos(cs => cs.map((c, i) => i === ci ? { ...c, [key]: val } : c))
  }

  async function handleMultiSoporteRun() {
    setLoading(true); setError(null); setResult(null)
    try {
      const resp = await fetch(`/api/candles?from=${params.dateFrom}&to=${params.dateTo}`)
      if (!resp.ok) throw new Error((await resp.json()).error)
      const { candles, total } = await resp.json()
      if (!total) throw new Error('No se encontraron velas en ese rango de fechas.')
      const bt = runMultiSoporteBacktest(candles, multiCombos, {
        feeSlPct: params.feeSlPct,
        feeTpPct: params.feeTpPct,
        leverage: params.leverage,
        initialCapital: params.initialCapital,
        monthlyContribution: params.monthlyContribution,
        emaMinGapPct: params.emaMinGapPct,
      })
      setResult({ ...bt, totalCandles: total })
      setActiveTab('stats')
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  async function handleOptimize() {
    setError(null)
    try {
      const resp = await fetch(`/api/candles?from=${params.dateFrom}&to=${params.dateTo}`)
      if (!resp.ok) throw new Error((await resp.json()).error)
      const { candles, total } = await resp.json()
      if (!total) throw new Error('No se encontraron velas en ese rango de fechas.')

      if (optimBcRef.current) optimBcRef.current.close()
      const bc = new BroadcastChannel('btc-soporte-optim')
      optimBcRef.current = bc

      bc.onmessage = (e) => {
        if (e.data.type === 'ready') {
          bc.postMessage({ type: 'init', candles, optimRanges, params })
        } else if (e.data.type === 'apply') {
          applyOptimResult(e.data.row)
        }
      }

      window.open(window.location.pathname + '?strategy=soporte&mode=optim', '_blank')
    } catch (e) {
      setError(e.message)
    }
  }

  const stats   = result?.stats ?? {}
  const winRate = parseFloat(stats.winRate     ?? 0)
  const netPct  = parseFloat(stats.totalNetPct ?? 0)

  return (
    <div className="app">
      <header className="header">
        <div className="header-inner">
          <div className="logo">
            <span className="logo-icon">₿</span>
            <div>
              <div className="logo-title">MariaPaz<span style={{color:'var(--accent)'}}>Indicator</span></div>
              <div className="logo-sub">Rango + Soporte · BTCUSDC · 15m</div>
            </div>
          </div>
          <div className={`db-badge ${dbStatus?.connected ? 'connected' : 'disconnected'}`}>
            <span className="db-dot" />
            {dbStatus?.connected
              ? `BD conectada · ${dbStatus.totalCandles?.toLocaleString()} velas`
              : dbStatus?.error ?? 'Conectando...'}
          </div>
        </div>
        <div className="strategy-nav">
          <button className="strategy-tab" onClick={() => { window.location.href = '/' }}>📐 Rango + Resistencias</button>
          <button className="strategy-tab" onClick={() => { window.location.href = '?strategy=sar' }}>📈 SAR</button>
          <button className="strategy-tab" onClick={() => { window.location.href = '?strategy=supertrend' }}>📊 Supertrend</button>
          <button className="strategy-tab" onClick={() => { window.location.href = '?strategy=confluence' }}>🎯 Confluencia</button>
          <button className="strategy-tab" onClick={() => { window.location.href = '?strategy=emapullback' }}>📉 EMA Pullback</button>
          <button className="strategy-tab" onClick={() => { window.location.href = '?strategy=pinbar' }}>🕯️ Pin Bar</button>
          <button className="strategy-tab active">📗 Rango + Soporte</button>
          <button className="strategy-tab" onClick={() => { window.location.href = '?strategy=ema' }}>📡 EMA Touch</button>
          <button className="strategy-tab" onClick={() => { window.location.href = '?strategy=rangehigh' }}>🏔️ Rango Alto</button>
        </div>
      </header>

      <div className="layout">
        <aside className="sidebar">
          <div className="sidebar-scroll">

            <Section title="📅 Rango de fechas">
              <InputGroup label="Desde">
                <input type="date" value={params.dateFrom} onChange={e => set('dateFrom', e.target.value)} />
              </InputGroup>
              <InputGroup label="Hasta">
                <input type="date" value={params.dateTo}   onChange={e => set('dateTo',   e.target.value)} />
              </InputGroup>
            </Section>

            <Section title="📐 Configuración del Rango">
              <InputGroup label="Mínimo (%)" tooltip="% mínimo de compresión del rango">
                <input type="number" step="0.1" value={params.minRangePct} onChange={e => num('minRangePct', e.target.value)} />
              </InputGroup>
              <InputGroup label="Máximo (%)" tooltip="% máximo de compresión del rango">
                <input type="number" step="0.1" value={params.maxRangePct} onChange={e => num('maxRangePct', e.target.value)} />
              </InputGroup>
              <InputGroup label="Velas lookback" tooltip="Cuántas velas hacia atrás para calcular el rango">
                <input type="number" step="1" min="1" value={params.lookbackCandles} onChange={e => int('lookbackCandles', e.target.value)} />
              </InputGroup>
              <InputGroup label="Mecha mínima (%)" tooltip="% mínimo de mecha inferior respecto al rango de la vela">
                <input type="number" step="0.1" value={params.minWickPct} onChange={e => num('minWickPct', e.target.value)} />
              </InputGroup>
            </Section>

            <Section title="⚖️ TP / SL">
              <InputGroup label="SL (%)">
                <input type="number" step="0.01" value={params.slPct} onChange={e => num('slPct', e.target.value)} />
              </InputGroup>
              <InputGroup label="TP (%)">
                <input type="number" step="0.01" value={params.tpPct} onChange={e => num('tpPct', e.target.value)} />
              </InputGroup>
            </Section>

            <Section title="📊 Estadísticas">
              <InputGroup label="Fee SL extra (%)">
                <input type="number" step="0.01" value={params.feeSlPct} onChange={e => num('feeSlPct', e.target.value)} />
              </InputGroup>
              <InputGroup label="Fee TP (%)">
                <input type="number" step="0.01" value={params.feeTpPct} onChange={e => num('feeTpPct', e.target.value)} />
              </InputGroup>
              <InputGroup label="Apalancamiento">
                <input type="number" step="1" min="1" value={params.leverage} onChange={e => num('leverage', e.target.value)} />
              </InputGroup>
              <InputGroup label="Capital inicial ($)">
                <input type="number" step="100" min="1" value={params.initialCapital} onChange={e => num('initialCapital', e.target.value)} />
              </InputGroup>
              <InputGroup label="Aporte mensual ($)" tooltip="Monto que se suma al capital compuesto cada mes. 0 para no aplicar.">
                <input type="number" step="50" min="0" value={params.monthlyContribution} onChange={e => num('monthlyContribution', e.target.value)} />
              </InputGroup>
              <InputGroup label="Distancia mínima EMA (%)" tooltip="EMA10 debe estar al menos este % por encima de EMA50 para señal alcista. 0 = sin filtro.">
                <input type="number" step="0.05" min="0" value={params.emaMinGapPct} onChange={e => num('emaMinGapPct', e.target.value)} />
              </InputGroup>
            </Section>

            <div className="section optim-section">
              <div className="optim-section-header" onClick={() => { setMultiMode(v => !v); setOptimMode(false) }}>
                <span className="section-title" style={{marginBottom:0, borderBottom:'none', paddingBottom:0}}>🎯 Multi-Combinaciones</span>
                <span className="optim-chevron">{multiMode ? '▲' : '▼'}</span>
              </div>
              {multiMode && (
                <div className="optim-body">
                  <div style={{fontSize:11, color:'var(--text-muted)', marginBottom:8, lineHeight:1.5}}>
                    Hasta 15 combos activos. Solo 1 trade/día — gana el primero que dispare señal.
                  </div>
                  {multiCombos.map((combo, ci) => (
                    <div key={ci} className="multi-combo-block">
                      <div className="multi-combo-header">
                        <span style={{fontSize:11, fontWeight:700, color:'var(--accent)', textTransform:'uppercase', letterSpacing:'0.06em'}}>
                          Combo {ci + 1}
                        </span>
                        {multiCombos.length > 1 && (
                          <button className="multi-remove-btn" onClick={() => removeSoporteCombo(ci)}>✕</button>
                        )}
                      </div>
                      <div className="multi-combo-fields">
                        <div className="multi-field">
                          <label>Min%</label>
                          <input type="number" step="0.1" value={combo.minRangePct} onChange={e => updateSoporteCombo(ci, 'minRangePct', e.target.value)} />
                        </div>
                        <div className="multi-field">
                          <label>Max%</label>
                          <input type="number" step="0.1" value={combo.maxRangePct} onChange={e => updateSoporteCombo(ci, 'maxRangePct', e.target.value)} />
                        </div>
                        <div className="multi-field">
                          <label>LB</label>
                          <input type="number" step="1" min="1" value={combo.lookbackCandles} onChange={e => updateSoporteCombo(ci, 'lookbackCandles', e.target.value)} />
                        </div>
                        <div className="multi-field">
                          <label>Mecha%</label>
                          <input type="number" step="0.1" value={combo.minWickPct} onChange={e => updateSoporteCombo(ci, 'minWickPct', e.target.value)} />
                        </div>
                        <div className="multi-field">
                          <label>SL%</label>
                          <input type="number" step="0.01" value={combo.slPct} onChange={e => updateSoporteCombo(ci, 'slPct', e.target.value)} />
                        </div>
                        <div className="multi-field">
                          <label>TP%</label>
                          <input type="number" step="0.01" value={combo.tpPct} onChange={e => updateSoporteCombo(ci, 'tpPct', e.target.value)} />
                        </div>
                      </div>
                    </div>
                  ))}
                  {multiCombos.length < 15 && (
                    <button
                      className="run-btn optim-btn"
                      style={{width:'100%', marginTop:4, padding:'8px', fontSize:12}}
                      onClick={addSoporteCombo}
                    >
                      + Agregar combo
                    </button>
                  )}
                </div>
              )}
            </div>

            <div className="section optim-section">
              <div className="optim-section-header" onClick={() => { setOptimMode(v => !v); setMultiMode(false) }}>
                <span className="section-title" style={{marginBottom:0, borderBottom:'none', paddingBottom:0}}>🔬 Análisis Profundo</span>
                <span className="optim-chevron">{optimMode ? '▲' : '▼'}</span>
              </div>
              {optimMode && (
                <div className="optim-body">
                  <div className="optim-hint">
                    <span>Parámetro</span><span>Min</span><span>Max</span><span>Paso</span>
                  </div>
                  <OptimRow label="Mínimo %"    field="minRangePct"     stepHint="0.1"  ranges={optimRanges} onChange={setOptimField} />
                  <OptimRow label="Máximo %"    field="maxRangePct"     stepHint="0.1"  ranges={optimRanges} onChange={setOptimField} />
                  <OptimRow label="Lookback"    field="lookbackCandles" stepHint="1"    ranges={optimRanges} onChange={setOptimField} />
                  <OptimRow label="Mecha %"     field="minWickPct"      stepHint="1"    ranges={optimRanges} onChange={setOptimField} />
                  <OptimRow label="SL %"        field="slPct"           stepHint="0.01" ranges={optimRanges} onChange={setOptimField} />
                  <OptimRow label="TP %"        field="tpPct"           stepHint="0.01" ranges={optimRanges} onChange={setOptimField} />
                  <div className="optim-count">
                    ~{estimatedCombos.toLocaleString()} combinaciones
                    {estimatedCombos > 50000 && <span className="optim-warn"> · puede tardar</span>}
                  </div>
                </div>
              )}
            </div>

          </div>
          <div className="sidebar-footer">
            {multiMode
              ? <button className="run-btn" onClick={handleMultiSoporteRun} disabled={loading || !dbStatus?.connected}>
                  {loading ? <><span className="spinner" /> Procesando...</> : '▶ Ejecutar Multi-Backtest'}
                </button>
              : optimMode
              ? <>
                  <button className="run-btn optim-btn" onClick={handleOptimize} disabled={!dbStatus?.connected}>
                    🔬 Abrir Análisis Profundo
                  </button>
                  <button className="run-btn optim-btn" style={{marginTop:'0.4rem'}}
                    onClick={() => window.open(window.location.pathname + '?strategy=soporte&mode=exceloptim', '_blank')}>
                    📊 Análisis Multi-Combo Excel
                  </button>
                </>
              : <button className="run-btn" onClick={handleRun} disabled={loading || !dbStatus?.connected}>
                  {loading ? <><span className="spinner" /> Procesando...</> : '▶ Ejecutar Backtest Soporte'}
                </button>
            }
            {result?.debugLog && (
              <button className="run-btn" style={{marginTop:6, background:'var(--surface-2)'}} onClick={handleDownloadDebug}>
                ⬇ Debug JSON
              </button>
            )}
            {error && <div className="error-box">⚠️ {error}</div>}
          </div>
        </aside>

        <main className="main">
          {!result && !loading && (
            <div className="empty-state">
              <div className="empty-icon">📗</div>
              <div className="empty-title">Rango + Soporte</div>
              <div className="empty-sub">LONG en el mínimo del rango con mecha inferior + tendencia alcista EMA10 &gt; EMA50</div>
            </div>
          )}

          {loading && (
            <div className="empty-state">
              <div className="loading-ring" />
              <div className="empty-title">Analizando velas...</div>
              <div className="empty-sub">Calculando soportes y mechas inferiores</div>
            </div>
          )}

          {result && !loading && (
            <>
              <div className="result-header">
                <div className="result-meta">
                  <span>📊 {result.totalCandles?.toLocaleString()} velas</span>
                  <span>·</span>
                  <span>{params.dateFrom} → {params.dateTo}</span>
                </div>
                <div className="tabs">
                  <button className={activeTab === 'stats'   ? 'tab active' : 'tab'} onClick={() => setActiveTab('stats')}>Estadísticas</button>
                  <button className={activeTab === 'trades'  ? 'tab active' : 'tab'} onClick={() => setActiveTab('trades')}>Trades ({result.trades.length})</button>
                  <button className={activeTab === 'signals' ? 'tab active' : 'tab'} onClick={() => setActiveTab('signals')}>Señales ({result.signals.length})</button>
                </div>
              </div>

              {activeTab === 'stats' && (
                <>
                  <div className="stats-grid">
                    <StatCard label="Trades cerrados"                      value={stats.totalClosed}    variant="neutral" />
                    <StatCard label="TP ✅"                                 value={stats.totalTp}        variant="win" />
                    <StatCard label="SL ❌"                                 value={stats.totalSl}        variant="loss" />
                    <StatCard label="Win Rate"                              value={`${stats.winRate}%`}  variant={winRate >= 50 ? 'win' : 'loss'} />
                    <StatCard label={`Ganancia acum. x${params.leverage}`}  value={`${stats.totalProfitPct}%`} variant="win" />
                    <StatCard label={`Pérdida acum. x${params.leverage}`}   value={`${stats.totalLossPct}%`}  variant="loss" />
                    <StatCard label={`Neto simple x${params.leverage}`}     value={`${stats.totalNetPct}%`}   variant={netPct >= 0 ? 'win' : 'loss'} />
                    <StatCard label="Máx. Drawdown"                         value={`${stats.maxDrawdownPct}%`} variant="warn" />
                    <StatCard label="Capital simple"   value={`$${parseFloat(stats.simpleCapital).toLocaleString('es-CO',{minimumFractionDigits:2})}`}   variant="neutral" />
                    <StatCard label={params.monthlyContribution > 0 ? 'Capital compuesto (+ aportes)' : 'Capital compuesto'} value={`$${parseFloat(stats.compoundCapital).toLocaleString('es-CO',{minimumFractionDigits:2})}`} variant="accent" />
                    {params.monthlyContribution > 0 && <StatCard label="Total aportado" value={`$${parseFloat(stats.totalContributed).toLocaleString('es-CO',{minimumFractionDigits:2})}`} variant="neutral" />}
                    <StatCard label="Mejor método"                          value={stats.bestMethod}    variant="accent" />
                    {!result.isMulti && <StatCard label={`TP efectivo x${params.leverage}`} value={`${stats.effectiveTpPct}%`} variant="neutral" />}
                    {!result.isMulti && <StatCard label={`SL efectivo x${params.leverage}`} value={`${stats.effectiveSlPct}%`} variant="neutral" />}
                    {result.isMulti && <StatCard label="Combos activos" value={multiCombos.length} variant="neutral" />}
                  </div>

                  {result.trades.length > 0 && (() => {
                    const effTp = parseFloat(stats.effectiveTpPct || 0)
                    const effSl = parseFloat(stats.effectiveSlPct || 0)
                    const { byYear, byMonth, byCombo } = computePeriodStats(result.trades, effTp, effSl)
                    return <>
                      {result.isMulti && <PeriodTable title="🎯 Acumulado por combo" rows={byCombo} />}
                      <PeriodTable title="📅 Acumulado por año" rows={byYear}  />
                      <PeriodTable title="📆 Acumulado por mes" rows={byMonth} />
                    </>
                  })()}

                  {stats.totalTp > 0 && (
                    <div className="mae-section">
                      <div className="mae-title">📏 MAE — Excursión Adversa Máxima en trades TP</div>
                      <div className="mae-subtitle">Cuánto bajó el precio desde la entrada antes de rebotar al TP (para calibrar Trailing SL)</div>
                      <div className="stats-grid" style={{marginTop:12, marginBottom:16}}>
                        <StatCard label="MAE Promedio" value={`${stats.maeAvgTp}%`}    variant="neutral" />
                        <StatCard label="MAE Mediana"  value={`${stats.maeMedianTp}%`} variant="neutral" />
                        <StatCard label="MAE Máximo"   value={`${stats.maeMaxTp}%`}    variant="warn" />
                      </div>
                      <div className="mae-dist">
                        {stats.maeDist.map((b, i) => (
                          <div key={i} className="mae-bucket">
                            <span className="mae-range">
                              {b.to === Infinity ? `> ${b.from}%` : `${b.from}–${b.to}%`}
                            </span>
                            <div className="mae-bar-wrap">
                              <div className="mae-bar" style={{width: stats.totalTp > 0 ? `${b.count / stats.totalTp * 100}%` : '0%'}} />
                            </div>
                            <span className="mae-count">{b.count}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )}

              {activeTab === 'trades' && (
                <div className="table-wrap">
                  {result.trades.length === 0
                    ? <div className="empty-table">No se cerraron trades en este período</div>
                    : (
                      <table className="data-table">
                        <thead>
                          <tr>
                            <th>#</th>{result.isMulti && <th>Combo</th>}<th>Señal</th><th>Entrada</th><th>TP precio</th><th>SL precio</th><th>Cierre</th><th>Resultado</th><th>Capital entrada</th><th>Capital salida</th>
                          </tr>
                        </thead>
                        <tbody>
                          {result.trades.map((t, i) => (
                            <tr key={i} className={t.result === 'TP' ? 'row-win' : 'row-loss'}>
                              <td>{i + 1}</td>
                              {result.isMulti && <td style={{fontSize:11, color:'var(--accent)'}}>{t.comboLabel}</td>}
                              <td>{new Date(t.time).toLocaleString('es-CO',{timeZone:'UTC'})}</td>
                              <td>${parseFloat(t.price).toLocaleString('en-US')}</td>
                              <td className="tp-cell">${parseFloat(t.tp).toLocaleString('en-US')}</td>
                              <td className="sl-cell">${parseFloat(t.sl).toLocaleString('en-US')}</td>
                              <td>{new Date(t.closeTime).toLocaleString('es-CO',{timeZone:'UTC'})}</td>
                              <td><span className={`badge badge-${t.result.toLowerCase()}`}>{t.result === 'TP' ? '✅ TP' : '❌ SL'}</span></td>
                              <td>${parseFloat(t.capitalAtEntry).toLocaleString('es-CO',{minimumFractionDigits:2,maximumFractionDigits:2})}</td>
                              <td className={t.result === 'TP' ? 'tp-cell' : 'sl-cell'}>${parseFloat(t.capitalAtExit).toLocaleString('es-CO',{minimumFractionDigits:2,maximumFractionDigits:2})}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )
                  }
                </div>
              )}

              {activeTab === 'signals' && (
                <div className="table-wrap">
                  {result.signals.length === 0
                    ? <div className="empty-table">No se generaron señales en este período</div>
                    : (
                      <table className="data-table">
                        <thead>
                          <tr>
                            <th>#</th>{result.isMulti && <th>Combo</th>}<th>Fecha señal</th><th>Precio entrada</th><th>Rango %</th><th>Mecha inf %</th><th>TP</th><th>SL</th>
                          </tr>
                        </thead>
                        <tbody>
                          {result.signals.map((s, i) => (
                            <tr key={i} className="row-win">
                              <td>{i + 1}</td>
                              {result.isMulti && <td style={{fontSize:11, color:'var(--accent)'}}>{s.comboLabel}</td>}
                              <td>{new Date(s.time).toLocaleString('es-CO',{timeZone:'UTC'})}</td>
                              <td>${parseFloat(s.price).toLocaleString('en-US')}</td>
                              <td>{s.rangePct}%</td>
                              <td>{s.lowerWickPct}%</td>
                              <td className="tp-cell">${parseFloat(s.tp).toLocaleString('en-US')}</td>
                              <td className="sl-cell">${parseFloat(s.sl).toLocaleString('en-US')}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )
                  }
                </div>
              )}
            </>
          )}
        </main>
      </div>
    </div>
  )
}

function RangoResistenciaPortfolioView() {
  const [strategies, setStrategies]   = useState([])
  const [fileName, setFileName]       = useState('')
  const [candles, setCandles]         = useState(null)
  const [status, setStatus]           = useState('idle')
  const [result, setResult]           = useState(null)
  const [errorMsg, setErrorMsg]       = useState('')
  const [dateFrom, setDateFrom]       = useState('2022-01-01')
  const [dateTo, setDateTo]           = useState(new Date().toISOString().split('T')[0])
  const [params, setParams]           = useState({ feeSlPct: 0.10, feeTpPct: 0.05, leverage: 10, capitalPerStrategy: 1000 })
  const [activeTab, setActiveTab]     = useState('resumen')
  const [sortKey, setSortKey]         = useState('entryTime')
  const [sortDir, setSortDir]         = useState('asc')
  const [showStrategies, setShowStrategies] = useState(false)
  const workerRef   = useRef(null)
  const fileInputRef = useRef(null)

  function parseNum(v) {
    if (typeof v === 'number') return v
    if (typeof v === 'string') return parseFloat(v.replace(',', '.'))
    return NaN
  }

  function handleFile(e) {
    const file = e.target.files[0]
    if (!file) return
    setFileName(file.name)
    const reader = new FileReader()
    reader.onload = (ev) => {
      const wb   = XLSX.read(ev.target.result, { type: 'array' })
      const ws   = wb.Sheets[wb.SheetNames[0]]
      const rows = XLSX.utils.sheet_to_json(ws, { defval: '' })
      const groupMap = new Map()
      for (const row of rows) {
        const name = String(row['Estrategia'] ?? row['estrategia'] ?? '').trim()
        if (!name) continue
        const emaKey = Object.keys(row).find(k => k.trim().toLowerCase().includes('distancia'))
        const combo = {
          minRangePct:     parseNum(row['Min']    ?? row['Min%']    ?? row['minRangePct']),
          maxRangePct:     parseNum(row['Max']    ?? row['Max%']    ?? row['maxRangePct']),
          lookbackCandles: Math.round(parseNum(row['LB']  ?? row['lookbackCandles'])),
          minWickPct:      parseNum(row['W']      ?? row['Mecha%'] ?? row['minWickPct']),
          slPct:           parseNum(row['SL']     ?? row['SL%']    ?? row['slPct']),
          tpPct:           parseNum(row['TP']     ?? row['TP%']    ?? row['tpPct']),
          emaMinGapPct:    emaKey ? (parseNum(row[emaKey]) || 0) : 0,
        }
        if ([combo.minRangePct, combo.maxRangePct, combo.lookbackCandles, combo.minWickPct, combo.slPct, combo.tpPct].some(isNaN)) continue
        if (!groupMap.has(name)) groupMap.set(name, [])
        groupMap.get(name).push(combo)
      }
      const parsed = [...groupMap.entries()].map(([name, combos]) => ({ name, combos }))
      setStrategies(parsed)
      setResult(null)
      setStatus('idle')
    }
    reader.readAsArrayBuffer(file)
  }

  async function handleLoadCandles() {
    setStatus('loadingCandles')
    setErrorMsg('')
    try {
      const res  = await fetch(`http://localhost:3001/api/candles?from=${dateFrom}&to=${dateTo}`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Error cargando velas')
      setCandles(data.candles)
      setStatus('idle')
    } catch (err) {
      setErrorMsg(err.message)
      setStatus('error')
    }
  }

  function handleRun() {
    if (!candles || strategies.length === 0) return
    workerRef.current?.terminate()
    setStatus('running')
    setResult(null)
    const worker = new Worker(new URL('./portfolioWorker.js', import.meta.url), { type: 'module' })
    workerRef.current = worker
    worker.onmessage = (ev) => {
      const m = ev.data
      if (m.type === 'done') {
        setStatus('done')
        setResult({ perStrategy: m.perStrategy, combined: m.combined, allTrades: m.allTrades })
        setActiveTab('resumen')
        worker.terminate()
      } else if (m.type === 'error') {
        setErrorMsg(m.message)
        setStatus('error')
        worker.terminate()
      }
    }
    worker.onerror = (ev) => { setErrorMsg(ev.message); setStatus('error'); worker.terminate() }
    worker.postMessage({ strategies, candles, params })
  }

  const totalCombos       = strategies.reduce((s, st) => s + st.combos.length, 0)
  const isRunning         = status === 'running'
  const isLoadingCandles  = status === 'loadingCandles'
  const canRun            = candles && strategies.length > 0 && !isRunning && !isLoadingCandles
  const inputStyle        = { width:'100%', background:'var(--bg)', border:'1px solid var(--border)', borderRadius:'var(--radius)', color:'var(--text)', padding:'7px 10px', fontFamily:'var(--font-mono)', fontSize:13 }

  const sortedTrades = useMemo(() => {
    if (!result?.allTrades) return []
    return [...result.allTrades].sort((a, b) => {
      const av = a[sortKey] ?? '', bv = b[sortKey] ?? ''
      const cmp = typeof av === 'number' ? av - bv : String(av).localeCompare(String(bv))
      return sortDir === 'desc' ? -cmp : cmp
    })
  }, [result, sortKey, sortDir])

  function handleTradeSort(col) {
    if (sortKey === col) setSortDir(d => d === 'desc' ? 'asc' : 'desc')
    else { setSortKey(col); setSortDir('asc') }
  }

  function SortTh({ col, label }) {
    const active = sortKey === col
    return (
      <th onClick={() => handleTradeSort(col)}
        style={{cursor:'pointer', userSelect:'none', color: active ? 'var(--accent)' : undefined, whiteSpace:'nowrap'}}>
        {label}{' '}{active ? (sortDir==='desc'?'▼':'▲') : <span style={{opacity:0.25}}>▼</span>}
      </th>
    )
  }

  function StatCard({ title, value, sub, color }) {
    return (
      <div style={{background:'var(--bg)', border:'1px solid var(--border)', borderRadius:'var(--radius)', padding:'10px 14px', minWidth:0}}>
        <div style={{fontSize:10, color:'var(--text-muted)', fontFamily:'var(--font-mono)', marginBottom:3}}>{title}</div>
        <div style={{fontSize:14, fontWeight:700, color: color ?? 'var(--text)', fontFamily:'var(--font-mono)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}>{value}</div>
        {sub && <div style={{fontSize:10, color:'var(--text-muted)', fontFamily:'var(--font-mono)', marginTop:2}}>{sub}</div>}
      </div>
    )
  }

  function groupTradesByPeriod(trades, period) {
    const map = new Map()
    for (const t of trades) {
      const d   = new Date(t.entryTime)
      const key = period === 'year'
        ? String(d.getUTCFullYear())
        : `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
      if (!map.has(key)) map.set(key, { period: key, trades: 0, tp: 0, sl: 0, pnl: 0 })
      const g = map.get(key)
      g.trades++
      if (t.result === 'TP') g.tp++; else g.sl++
      g.pnl += typeof t.pnlPct === 'number' ? t.pnlPct : parseFloat(t.pnlPct) || 0
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([, v]) => v)
  }

  function PeriodBreakdown({ trades }) {
    const [view, setView] = useState('year')
    const groups = groupTradesByPeriod(trades, view)
    const btnBase = { padding:'4px 12px', borderRadius:'var(--radius)', fontSize:11, fontFamily:'var(--font-mono)', fontWeight:600, cursor:'pointer', border:'1px solid var(--border)' }
    return (
      <div style={{marginTop:24}}>
        <div style={{display:'flex', alignItems:'center', gap:8, marginBottom:10}}>
          <span style={{fontSize:12, fontWeight:600, color:'var(--text-muted)', fontFamily:'var(--font-mono)'}}>Resumen por período</span>
          <button onClick={() => setView('year')}  style={{...btnBase, background: view==='year'  ? 'var(--accent)' : 'var(--bg-2)', color: view==='year'  ? '#000' : 'var(--text)'}}>Año</button>
          <button onClick={() => setView('month')} style={{...btnBase, background: view==='month' ? 'var(--accent)' : 'var(--bg-2)', color: view==='month' ? '#000' : 'var(--text)'}}>Mes</button>
        </div>
        {groups.length === 0
          ? <div className="empty-table">Sin datos</div>
          : (
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>{view === 'year' ? 'Año' : 'Mes'}</th>
                    <th>Trades</th>
                    <th>TP</th>
                    <th>SL</th>
                    <th>Win%</th>
                    <th>PnL%</th>
                  </tr>
                </thead>
                <tbody>
                  {groups.map((g, i) => {
                    const wr = g.trades > 0 ? (g.tp / g.trades * 100) : 0
                    return (
                      <tr key={i} className={g.pnl >= 0 ? 'row-win' : ''}>
                        <td style={{fontFamily:'var(--font-mono)', fontWeight:600}}>{g.period}</td>
                        <td>{g.trades}</td>
                        <td style={{color:'var(--green)'}}>{g.tp}</td>
                        <td style={{color:'var(--red)'}}>{g.sl}</td>
                        <td className={wr >= 50 ? 'tp-cell' : 'sl-cell'}>{wr.toFixed(1)}%</td>
                        <td className={g.pnl >= 0 ? 'tp-cell' : 'sl-cell'}>
                          {g.pnl >= 0 ? '+' : ''}{g.pnl.toFixed(2)}%
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )
        }
      </div>
    )
  }

  function fmtMoney(v) {
    return '$' + parseFloat(v).toLocaleString('en-US', { minimumFractionDigits:2, maximumFractionDigits:2 })
  }

  function fmtGain(capital, initial) {
    const g = (parseFloat(capital) - initial) / initial * 100
    return `${g >= 0 ? '+' : ''}${g.toFixed(1)}%`
  }

  function TradeResultBadge({ result }) {
    return (
      <span style={{padding:'2px 8px', borderRadius:20, fontSize:11, fontWeight:600,
        background: result === 'TP' ? 'var(--green-dim)' : 'var(--red-dim)',
        color:      result === 'TP' ? 'var(--green)'     : 'var(--red)'}}>
        {result}
      </span>
    )
  }

  function TradeTable({ trades }) {
    if (!trades.length) return <div className="empty-table">Sin trades en este período</div>
    return (
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>#</th>
              <th>Entrada</th>
              <th>Cierre</th>
              <th>Precio entrada</th>
              <th>TP</th>
              <th>SL</th>
              <th>Resultado</th>
              <th>PnL%</th>
            </tr>
          </thead>
          <tbody>
            {trades.map((t, i) => (
              <tr key={i} className={t.result === 'TP' ? 'row-win' : ''}>
                <td style={{color:'var(--text-muted)'}}>{i + 1}</td>
                <td style={{fontFamily:'var(--font-mono)', fontSize:11}}>{new Date(t.entryTime).toLocaleString('es-CO', {timeZone:'UTC'})}</td>
                <td style={{fontFamily:'var(--font-mono)', fontSize:11}}>{new Date(t.closeTime).toLocaleString('es-CO', {timeZone:'UTC'})}</td>
                <td>{fmtMoney(t.entryPrice)}</td>
                <td className="tp-cell">{fmtMoney(t.tpPrice)}</td>
                <td className="sl-cell">{fmtMoney(t.slPrice)}</td>
                <td><TradeResultBadge result={t.result}/></td>
                <td className={t.result === 'TP' ? 'tp-cell' : 'sl-cell'}>
                  {t.pnlPct >= 0 ? '+' : ''}{typeof t.pnlPct === 'number' ? t.pnlPct.toFixed(2) : t.pnlPct}%
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )
  }

  function StrategyStatsGrid({ st }) {
    const net = parseFloat(st.totalNetPct)
    const wr  = parseFloat(st.winRate)
    const dd  = parseFloat(st.maxDrawdownPct)
    return (
      <div style={{display:'grid', gridTemplateColumns:'repeat(3, 1fr)', gap:8, marginBottom:20}}>
        <StatCard title="Trades"     value={st.totalClosed}  sub={`${st.totalTp} TP · ${st.totalSl} SL`}/>
        <StatCard title="Win%"       value={`${st.winRate}%`}         color={wr >= 50 ? 'var(--green)' : 'var(--red)'}/>
        <StatCard title="Neto%"      value={`${net >= 0 ? '+' : ''}${st.totalNetPct}%`} color={net >= 0 ? 'var(--green)' : 'var(--red)'}/>
        <StatCard title="Drawdown%"  value={`${st.maxDrawdownPct}%`}  color={dd > 30 ? 'var(--red)' : 'var(--text)'}/>
        <StatCard title="Capital"    value={fmtMoney(st.compoundCapital)}/>
        <StatCard title="Ganancia"   value={fmtGain(st.compoundCapital, st.initialCapital)}
          color={(parseFloat(st.compoundCapital) - st.initialCapital) >= 0 ? 'var(--green)' : 'var(--red)'}/>
      </div>
    )
  }

  const tabBtnStyle = (tab) => ({
    padding:'6px 14px', borderRadius:'var(--radius)', fontSize:12,
    fontFamily:'var(--font-mono)', fontWeight:600, cursor:'pointer',
    background: activeTab === tab ? 'var(--accent)' : 'var(--bg-2)',
    color:      activeTab === tab ? '#000' : 'var(--text)',
    border:     '1px solid ' + (activeTab === tab ? 'var(--accent)' : 'var(--border)'),
  })

  return (
    <div className="optim-page">

      {/* ── Header ── */}
      <header className="optim-page-header">
        <div className="logo">
          <span className="logo-icon">₿</span>
          <div>
            <div className="logo-title">MariaPaz<span style={{color:'var(--accent)'}}>Indicator</span></div>
            <div className="logo-sub">📊 Portfolio Multi-Estrategia · Rango &amp; Resistencia</div>
          </div>
        </div>
        <div className="optim-page-status">
          {status === 'idle' && strategies.length === 0 && 'Carga un Excel de estrategias para comenzar'}
          {status === 'idle' && strategies.length > 0 && !candles && `${strategies.length} estrategias · ${totalCombos} combos · Carga velas para continuar`}
          {status === 'idle' && strategies.length > 0 && candles  && `${strategies.length} estrategias · ${totalCombos} combos · ${candles.length.toLocaleString()} velas · Listo`}
          {isLoadingCandles && 'Cargando velas desde BD...'}
          {isRunning && <span>Simulando portfolio...</span>}
          {status === 'done' && result && (
            <span style={{color:'var(--green)'}}>
              ✅ Completado · {result.combined.totalClosed} trades · Capital: {fmtMoney(result.combined.compoundCapital)}
            </span>
          )}
          {status === 'error' && <span style={{color:'var(--red)'}}>⚠️ {errorMsg}</span>}
        </div>
      </header>

      <div className="optim-page-body">

        {/* ── Panel de configuración ── */}
        <div style={{background:'var(--bg-2)', border:'1px solid var(--border)', borderRadius:'var(--radius-lg)', padding:'20px 24px', marginBottom:20}}>
          <div style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap:24}}>

            {/* Columna izquierda: archivo + fechas + cargar velas */}
            <div style={{display:'flex', flexDirection:'column', gap:14}}>
              <div>
                <div className="optim-label" style={{marginBottom:6}}>Archivo Excel de Estrategias</div>
                <input ref={fileInputRef} type="file" accept=".xlsx,.xls" onChange={handleFile} style={{display:'none'}}/>
                <div style={{display:'flex', alignItems:'center', gap:10}}>
                  <button onClick={() => fileInputRef.current?.click()}
                    style={{...inputStyle, width:'auto', padding:'7px 14px', cursor:'pointer', background:'var(--bg-3)', fontFamily:'var(--font-ui)', fontWeight:600, fontSize:13, border:'1px solid var(--border-light)'}}>
                    📂 Seleccionar archivo
                  </button>
                  {fileName
                    ? <div style={{fontSize:12, fontFamily:'var(--font-mono)', lineHeight:1.6}}>
                        <div style={{color:'var(--green)'}}>✓ {fileName}</div>
                        <div style={{color:'var(--text-muted)'}}>{strategies.length} estrategias · {totalCombos} combos</div>
                      </div>
                    : <span style={{fontSize:12, color:'var(--text-muted)', fontFamily:'var(--font-mono)'}}>Sin archivo seleccionado</span>
                  }
                </div>
              </div>
              <div style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap:10}}>
                <div>
                  <div className="optim-label" style={{marginBottom:4}}>Desde</div>
                  <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} style={inputStyle}/>
                </div>
                <div>
                  <div className="optim-label" style={{marginBottom:4}}>Hasta</div>
                  <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} style={inputStyle}/>
                </div>
              </div>
              <button className="run-btn" style={{padding:'9px'}} onClick={handleLoadCandles} disabled={isLoadingCandles || isRunning}>
                {isLoadingCandles ? <><span className="spinner"/> Cargando velas...</> : '📥 Cargar velas desde BD'}
              </button>
            </div>

            {/* Columna derecha: parámetros + ejecutar */}
            <div style={{display:'flex', flexDirection:'column', gap:14}}>
              <div style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap:10}}>
                {[
                  ['Fee SL%',               'feeSlPct',           0.01],
                  ['Fee TP%',               'feeTpPct',           0.01],
                  ['Apalancamiento',         'leverage',           1   ],
                  ['Capital por estrategia $','capitalPerStrategy', 100 ],
                ].map(([label, key, step]) => (
                  <div key={key}>
                    <div className="optim-label" style={{marginBottom:4}}>{label}</div>
                    <input type="number" step={step} value={params[key]}
                      onChange={e => setParams(p => ({...p, [key]: parseFloat(e.target.value)}))}
                      style={inputStyle}/>
                  </div>
                ))}
              </div>
              <div style={{marginTop:'auto'}}>
                {status === 'error' && (
                  <div style={{marginBottom:8, padding:'8px 12px', background:'var(--red-dim)', border:'1px solid rgba(239,68,68,0.3)', borderRadius:'var(--radius)', fontSize:12, color:'var(--red)', fontFamily:'var(--font-mono)'}}>
                    ⚠️ {errorMsg}
                  </div>
                )}
                <button className="run-btn optim-btn" style={{width:'100%', padding:11}} onClick={handleRun} disabled={!canRun}>
                  {isRunning
                    ? <><span className="spinner"/> Simulando portfolio...</>
                    : `▶ Simular ${strategies.length} estrategias (${totalCombos} combos)`}
                </button>
                <div style={{fontSize:11, color:'var(--text-muted)', textAlign:'center', marginTop:6, fontFamily:'var(--font-mono)'}}>
                  Capital total: {fmtMoney(params.capitalPerStrategy * Math.max(strategies.length, 1))} · {strategies.length} estrategias SHORT simultáneas
                </div>
              </div>
            </div>

          </div>
        </div>

        {/* ── Vista previa de estrategias cargadas ── */}
        {strategies.length > 0 && (
          <div style={{marginBottom:16}}>
            <button onClick={() => setShowStrategies(v => !v)}
              style={{background:'none', border:'none', color:'var(--text-muted)', fontSize:12, fontFamily:'var(--font-mono)', cursor:'pointer', padding:'4px 0', display:'flex', alignItems:'center', gap:6}}>
              {showStrategies ? '▼' : '▶'} Ver estrategias cargadas ({strategies.length})
            </button>
            {showStrategies && (
              <div style={{marginTop:8, display:'flex', flexDirection:'column', gap:10}}>
                {strategies.map((st, i) => (
                  <div key={i} style={{background:'var(--bg-2)', border:'1px solid var(--border)', borderRadius:'var(--radius)', padding:'10px 16px'}}>
                    <div style={{fontWeight:600, marginBottom:6, fontSize:13}}>
                      {st.name}
                      <span style={{color:'var(--text-muted)', fontWeight:400, fontSize:11, marginLeft:8}}>({st.combos.length} combos)</span>
                    </div>
                    <div className="table-wrap">
                      <table className="data-table" style={{fontSize:11}}>
                        <thead>
                          <tr><th>#</th><th>Min%</th><th>Max%</th><th>LB</th><th>Mecha%</th><th>SL%</th><th>TP%</th><th>EMA dist%</th></tr>
                        </thead>
                        <tbody>
                          {st.combos.map((c, ci) => (
                            <tr key={ci}>
                              <td style={{color:'var(--text-muted)'}}>{ci + 1}</td>
                              <td>{c.minRangePct}</td><td>{c.maxRangePct}</td>
                              <td>{c.lookbackCandles}</td><td>{c.minWickPct}</td>
                              <td>{c.slPct}</td><td>{c.tpPct}</td>
                              <td>{c.emaMinGapPct}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── Resultados ── */}
        {result && (
          <>
            {/* Tab bar */}
            <div style={{display:'flex', gap:4, marginBottom:16, flexWrap:'wrap'}}>
              <button style={tabBtnStyle('resumen')} onClick={() => setActiveTab('resumen')}>
                📊 Resumen
              </button>
              {result.perStrategy.map(st => (
                <button key={st.name} style={tabBtnStyle(st.name)} onClick={() => setActiveTab(st.name)}>
                  {st.name}
                </button>
              ))}
              <button style={tabBtnStyle('trades')} onClick={() => setActiveTab('trades')}>
                📋 Todos los trades ({result.allTrades.length})
              </button>
            </div>

            {/* ── Tab: Resumen ── */}
            {activeTab === 'resumen' && (
              <div style={{display:'flex', flexDirection:'column', gap:16}}>

                {/* Card combinado */}
                <div style={{background:'var(--bg-2)', border:'2px solid var(--accent)', borderRadius:'var(--radius-lg)', padding:'16px 20px'}}>
                  <div style={{fontWeight:700, fontSize:14, marginBottom:12, color:'var(--accent)'}}>
                    Portfolio Combinado — {fmtMoney(result.combined.initialCapital)} capital total
                  </div>
                  <div style={{display:'grid', gridTemplateColumns:'repeat(6, minmax(0,1fr))', gap:8}}>
                    <StatCard title="Trades"
                      value={result.combined.totalClosed}
                      sub={`${result.combined.totalTp} TP · ${result.combined.totalSl} SL`}/>
                    <StatCard title="Win%"
                      value={`${result.combined.winRate}%`}
                      color={parseFloat(result.combined.winRate) >= 50 ? 'var(--green)' : 'var(--red)'}/>
                    <StatCard title="Neto% total"
                      value={`${parseFloat(result.combined.totalNetPct) >= 0 ? '+' : ''}${result.combined.totalNetPct}%`}
                      color={parseFloat(result.combined.totalNetPct) >= 0 ? 'var(--green)' : 'var(--red)'}/>
                    <StatCard title="DD% máx"
                      value={`${result.combined.maxDrawdownPct}%`}
                      color={parseFloat(result.combined.maxDrawdownPct) > 30 ? 'var(--red)' : 'var(--text)'}/>
                    <StatCard title="Capital final"
                      value={fmtMoney(result.combined.compoundCapital)}/>
                    <StatCard title="Ganancia"
                      value={fmtGain(result.combined.compoundCapital, result.combined.initialCapital)}
                      color={(parseFloat(result.combined.compoundCapital) - result.combined.initialCapital) >= 0 ? 'var(--green)' : 'var(--red)'}/>
                  </div>
                </div>

                {/* Cards por estrategia */}
                <div style={{display:'grid', gridTemplateColumns:'repeat(auto-fill, minmax(320px,1fr))', gap:12}}>
                  {result.perStrategy.map((st, i) => {
                    const net = parseFloat(st.totalNetPct)
                    const wr  = parseFloat(st.winRate)
                    const dd  = parseFloat(st.maxDrawdownPct)
                    return (
                      <div key={i} style={{background:'var(--bg-2)', border:'1px solid var(--border)', borderRadius:'var(--radius-lg)', padding:'14px 16px', minWidth:0}}>
                        <div style={{display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:10}}>
                          <div style={{fontWeight:700, fontSize:13}}>{st.name}</div>
                          <span style={{fontSize:11, color:'var(--text-muted)', fontFamily:'var(--font-mono)'}}>{st.numCombos} combos</span>
                        </div>
                        <div style={{display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:6}}>
                          <StatCard title="Trades"    value={st.totalClosed} sub={`${st.totalTp} TP · ${st.totalSl} SL`}/>
                          <StatCard title="Win%"      value={`${st.winRate}%`}         color={wr >= 50 ? 'var(--green)' : 'var(--red)'}/>
                          <StatCard title="Neto%"     value={`${net >= 0 ? '+' : ''}${st.totalNetPct}%`} color={net >= 0 ? 'var(--green)' : 'var(--red)'}/>
                          <StatCard title="Drawdown%" value={`${st.maxDrawdownPct}%`}  color={dd > 30 ? 'var(--red)' : 'var(--text)'}/>
                          <StatCard title="Capital"   value={fmtMoney(st.compoundCapital)}/>
                          <StatCard title="Ganancia"  value={fmtGain(st.compoundCapital, st.initialCapital)}
                            color={(parseFloat(st.compoundCapital) - st.initialCapital) >= 0 ? 'var(--green)' : 'var(--red)'}/>
                        </div>
                      </div>
                    )
                  })}
                </div>

              </div>
            )}

            {/* ── Tabs por estrategia ── */}
            {result.perStrategy.map(st => activeTab === st.name && (
              <div key={st.name}>
                <div style={{fontWeight:700, fontSize:14, marginBottom:12}}>
                  {st.name}
                  <span style={{color:'var(--text-muted)', fontWeight:400, fontSize:12, marginLeft:10}}>{st.numCombos} combos activos</span>
                </div>
                <StrategyStatsGrid st={st}/>
                <TradeTable trades={st.trades}/>
                <PeriodBreakdown trades={st.trades}/>
              </div>
            ))}

            {/* ── Tab: Todos los trades ── */}
            {activeTab === 'trades' && (
              <div>
                <div style={{marginBottom:10, fontSize:12, color:'var(--text-muted)', fontFamily:'var(--font-mono)'}}>
                  {result.allTrades.length} trades totales de {result.perStrategy.length} estrategias
                </div>
                {result.allTrades.length > 0 ? (
                  <div className="table-wrap">
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>#</th>
                          <SortTh col="strategyName" label="Estrategia"/>
                          <SortTh col="entryTime"    label="Entrada"/>
                          <SortTh col="closeTime"    label="Cierre"/>
                          <th>Precio entrada</th>
                          <th>TP</th>
                          <th>SL</th>
                          <SortTh col="result"       label="Resultado"/>
                          <SortTh col="pnlPct"       label="PnL%"/>
                        </tr>
                      </thead>
                      <tbody>
                        {sortedTrades.map((t, i) => (
                          <tr key={i} className={t.result === 'TP' ? 'row-win' : ''}>
                            <td style={{color:'var(--text-muted)'}}>{i + 1}</td>
                            <td style={{fontWeight:600, fontSize:12}}>{t.strategyName}</td>
                            <td style={{fontFamily:'var(--font-mono)', fontSize:11}}>{new Date(t.entryTime).toLocaleString('es-CO', {timeZone:'UTC'})}</td>
                            <td style={{fontFamily:'var(--font-mono)', fontSize:11}}>{new Date(t.closeTime).toLocaleString('es-CO', {timeZone:'UTC'})}</td>
                            <td>{fmtMoney(t.entryPrice)}</td>
                            <td className="tp-cell">{fmtMoney(t.tpPrice)}</td>
                            <td className="sl-cell">{fmtMoney(t.slPrice)}</td>
                            <td><TradeResultBadge result={t.result}/></td>
                            <td className={t.result === 'TP' ? 'tp-cell' : 'sl-cell'}>
                              {t.pnlPct >= 0 ? '+' : ''}{typeof t.pnlPct === 'number' ? t.pnlPct.toFixed(2) : t.pnlPct}%
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : <div className="empty-table">Sin trades en este período</div>}
                {result.allTrades.length > 0 && <PeriodBreakdown trades={result.allTrades}/>}
              </div>
            )}

          </>
        )}

      </div>
    </div>
  )
}

// =============================================================================
// EmaOptimView — Análisis Profundo EMA Touch
// =============================================================================
function EmaOptimView() {
  const [status, setStatus]     = useState('waiting')
  const [progress, setProgress] = useState(null)
  const [ranking, setRanking]   = useState([])
  const [errorMsg, setErrorMsg] = useState('')
  const bcRef      = useRef(null)
  const startRef   = useRef(null)

  useEffect(() => {
    let retryTimer = null
    const bc = new BroadcastChannel('btc-ema-optim')
    bcRef.current = bc

    function sendReady() { bc.postMessage({ type: 'ready' }) }
    sendReady()
    retryTimer = setTimeout(sendReady, 1200)

    bc.onmessage = (msg) => {
      if (msg.data.type !== 'init') return
      clearTimeout(retryTimer)
      const { candles, optimRanges, params } = msg.data
      setStatus('running')
      startRef.current = Date.now()

      const allPeriods = optRangeValues(
        optimRanges.emaPeriod.min,
        optimRanges.emaPeriod.max,
        optimRanges.emaPeriod.step
      ).map(v => Math.round(v))
      const chunks    = chunkArray(allPeriods, Math.min(navigator.hardwareConcurrency || 4, allPeriods.length))
      const numW      = chunks.length
      const wpDone    = new Array(numW).fill(0)
      const wpTotal   = new Array(numW).fill(0)
      const wpResults = new Array(numW).fill(null)
      let doneCount   = 0
      const workersArr = []

      chunks.forEach((subset, wi) => {
        const w = new Worker(new URL('./emaOptimWorker.js', import.meta.url), { type: 'module' })
        w.onmessage = (ev) => {
          const m = ev.data
          if (m.type === 'progress') {
            wpDone[wi] = m.done; wpTotal[wi] = m.total
            if (m.topResults?.length) wpResults[wi] = m.topResults
            const totalDone = wpDone.reduce((s, v) => s + v, 0)
            const totalAll  = wpTotal.reduce((s, v) => s + v, 0)
            const elapsed   = Date.now() - startRef.current
            const eta = (totalDone >= 100 && elapsed >= 500)
              ? Math.round((totalAll - totalDone) / (totalDone / elapsed)) : null
            setProgress({ done: totalDone, total: totalAll, eta })
            const merged = mergeEmaWorkerRankings(wpResults)
            if (merged.length) setRanking(merged)
          } else if (m.type === 'done') {
            wpDone[wi] = wpTotal[wi]; wpResults[wi] = m.results ?? []
            doneCount++; w.terminate()
            if (doneCount === numW) {
              setStatus('done')
              setProgress(p => p ? { ...p, done: p.total } : null)
              setRanking(mergeEmaWorkerRankings(wpResults))
            }
          } else if (m.type === 'error') {
            setErrorMsg(m.message); setStatus('error')
            workersArr.forEach(wk => wk.terminate())
          }
        }
        w.onerror = (ev) => { setErrorMsg(ev.message); setStatus('error'); workersArr.forEach(wk => wk.terminate()) }
        w.postMessage({ candles, optimRanges, params, emaPeriodSubset: subset })
        workersArr.push(w)
      })
    }
    return () => { clearTimeout(retryTimer); bc.close() }
  }, [])

  function applyParams(row) { bcRef.current?.postMessage({ type: 'apply', row }) }

  function handleExportExcel() {
    const rows = ranking.map((r, i) => ({
      '#':          i + 1,
      'Score':      parseFloat(r._score?.toFixed(4)),
      'EMA':        r.emaPeriod,
      'Mecha%':     r.minWickPct,
      'SL%':        r.slPct,
      'TP%':        r.tpPct,
      'Trades':     r.totalClosed,
      'Win%':       r.winRate,
      'Neto%':      r.totalNetPct,
      'Drawdown%':  r.maxDrawdownPct,
      'Capital':    parseFloat(r.compoundCapital),
    }))
    const ws = XLSX.utils.json_to_sheet(rows)
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'EMA Touch Profundo')
    XLSX.writeFile(wb, 'analisis_profundo_ema_touch.xlsx')
  }

  const pct = progress ? Math.round(progress.done / progress.total * 100) : 0

  return (
    <div className="optim-page">
      <header className="optim-page-header">
        <div className="logo">
          <span className="logo-icon">₿</span>
          <div>
            <div className="logo-title">MariaPaz<span style={{color:'var(--accent)'}}>Indicator</span></div>
            <div className="logo-sub">🔬 EMA Touch · Análisis Profundo · Ranking en vivo</div>
          </div>
        </div>
        <div className="optim-page-status">
          {status === 'waiting' && 'Esperando datos de la pestaña EMA Touch...'}
          {status === 'running' && progress && (
            <span>
              {progress.done.toLocaleString()} / {progress.total.toLocaleString()} · {pct}%
              {progress.eta != null && ` · faltan ${formatEta(progress.eta)}`}
              {' · '}{ranking.length} en ranking
            </span>
          )}
          {status === 'done'  && <span style={{color:'var(--green)'}}>✅ Completado · {ranking.length} en ranking</span>}
          {status === 'error' && <span style={{color:'var(--red)'}}>⚠️ {errorMsg}</span>}
        </div>
      </header>

      {progress && (
        <div className="optim-page-progress">
          <div className="progress-track" style={{borderRadius:0, height:3}}>
            <div className="progress-fill" style={{width:`${pct}%`, transition:'width 0.5s ease'}} />
          </div>
        </div>
      )}

      <div className="optim-page-body">
        {status === 'done' && ranking.length >= 2 && (
          <button
            className="run-btn optim-btn"
            style={{width:'100%', marginBottom:8, background:'var(--green)', color:'#000'}}
            onClick={handleExportExcel}
          >
            📥 Exportar ranking a Excel
          </button>
        )}

        {ranking.length > 0 && (
          <>
            <div className="optim-rank-meta">
              Ranking por Score = Neto% ÷ Drawdown% · top 5 por período EMA
              {status === 'running' && ' · actualizando en vivo...'}
            </div>
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Score</th>
                    <th>EMA</th><th>Mecha%</th><th>SL%</th><th>TP%</th>
                    <th>Trades</th><th>Win%</th><th>Neto%</th><th>Drawdown%</th><th>Capital $</th>
                    <th>Aplicar</th>
                  </tr>
                </thead>
                <tbody>
                  {ranking.map((r, i) => (
                    <tr key={i} className="row-win">
                      <td>{i + 1}</td>
                      <td style={{color:'var(--accent)', fontWeight:600}}>{r._score?.toFixed(2)}</td>
                      <td style={{fontWeight:600}}>{r.emaPeriod}</td>
                      <td>{r.minWickPct}</td>
                      <td>{r.slPct}</td>
                      <td>{r.tpPct}</td>
                      <td>{r.totalClosed}</td>
                      <td>{r.winRate}%</td>
                      <td className="tp-cell">{r.totalNetPct}%</td>
                      <td className={parseFloat(r.maxDrawdownPct) > 20 ? 'sl-cell' : ''}>{r.maxDrawdownPct}%</td>
                      <td>${parseFloat(r.compoundCapital).toLocaleString('es-CO', {minimumFractionDigits:2})}</td>
                      <td><button className="apply-btn" onClick={() => applyParams(r)} title="Aplicar en pestaña EMA Touch">▶</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// =============================================================================
// EmaExcelOptimView — Multi-Combo Excel para EMA Touch
// =============================================================================
function EmaExcelOptimView() {
  const [combos, setCombos]         = useState([])
  const [fileName, setFileName]     = useState('')
  const [candles, setCandles]       = useState(null)
  const [status, setStatus]         = useState('idle')
  const [progress, setProgress]     = useState(null)
  const [ranking, setRanking]       = useState([])
  const [errorMsg, setErrorMsg]     = useState('')
  const [dateFrom, setDateFrom]     = useState('2022-01-01')
  const [dateTo, setDateTo]         = useState(new Date().toISOString().split('T')[0])
  const [params, setParams]         = useState({
    feeSlPct: 0.10, feeTpPct: 0.05, leverage: 10, initialCapital: 1000,
    slowEmaPeriod: 200, direction: 'BOTH',
  })
  const [sortKey, setSortKey]       = useState('_score')
  const [sortDir, setSortDir]       = useState('desc')
  const [showCombos, setShowCombos] = useState(false)
  const [minTrades, setMinTrades]   = useState(0)
  const [maxTrades, setMaxTrades]   = useState(9999)
  const startTimeRef  = useRef(null)
  const workerRef     = useRef(null)
  const fileInputRef  = useRef(null)

  function parseNum(v) {
    if (typeof v === 'number') return v
    if (typeof v === 'string') return parseFloat(v.replace(',', '.'))
    return NaN
  }

  function handleFile(e) {
    const file = e.target.files[0]
    if (!file) return
    setFileName(file.name)
    const reader = new FileReader()
    reader.onload = (ev) => {
      const wb = XLSX.read(ev.target.result, { type: 'array' })
      const ws = wb.Sheets[wb.SheetNames[0]]
      const rows = XLSX.utils.sheet_to_json(ws, { defval: '' })
      const parsed = rows.map(row => ({
        emaPeriod:  Math.round(parseNum(row['EMA'] ?? row['emaPeriod'] ?? row['EmaPeriod'])),
        minWickPct: parseNum(row['Mecha%'] ?? row['minWickPct'] ?? row['Wick%']),
        slPct:      parseNum(row['SL%']    ?? row['slPct']),
        tpPct:      parseNum(row['TP%']    ?? row['tpPct']),
        _score:     parseNum(row['Score']  ?? row['_score'] ?? 0),
      })).filter(c =>
        !isNaN(c.emaPeriod) && c.emaPeriod > 0 &&
        !isNaN(c.minWickPct) && !isNaN(c.slPct) && !isNaN(c.tpPct)
      )
      setCombos(parsed)
      setRanking([])
      setStatus('idle')
    }
    reader.readAsArrayBuffer(file)
  }

  async function handleLoadCandles() {
    setStatus('loadingCandles')
    setErrorMsg('')
    try {
      const res = await fetch(`http://localhost:3001/api/candles?from=${dateFrom}&to=${dateTo}`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Error cargando velas')
      setCandles(data.candles)
      setStatus('idle')
    } catch (err) {
      setErrorMsg(err.message)
      setStatus('error')
    }
  }

  function handleRun() {
    if (!candles || combos.length < 3) return
    workerRef.current?.terminate()
    setStatus('running')
    setRanking([])
    setProgress(null)
    startTimeRef.current = Date.now()

    const worker = new Worker(new URL('./emaExcelMultiWorker.js', import.meta.url), { type: 'module' })
    workerRef.current = worker
    worker.onmessage = (ev) => {
      const m = ev.data
      if (m.type === 'progress') {
        const elapsed = Date.now() - startTimeRef.current
        let eta = null
        if (m.done >= 50 && elapsed >= 500) eta = Math.round((m.total - m.done) / (m.done / elapsed))
        setProgress({ done: m.done, total: m.total, eta })
        if (m.topResults?.length > 0) setRanking(m.topResults)
      } else if (m.type === 'done') {
        setStatus('done')
        setProgress(p => p ? { ...p, done: p.total } : null)
        if (m.results?.length > 0) setRanking(m.results)
        worker.terminate()
      } else if (m.type === 'error') {
        setErrorMsg(m.message)
        setStatus('error')
        worker.terminate()
      }
    }
    worker.onerror = (ev) => { setErrorMsg(ev.message); setStatus('error'); worker.terminate() }
    worker.postMessage({ combos, candles, params, groupSizes: [3,4,5,6,7,8,9,10,11,12,13,14,15], samplesPerSize: 5000 })
  }

  function handleSort(key) {
    if (sortKey === key) setSortDir(d => d === 'desc' ? 'asc' : 'desc')
    else { setSortKey(key); setSortDir('desc') }
  }

  const sortedRanking = useMemo(() => {
    if (!ranking.length) return []
    return [...ranking]
      .filter(r => {
        const tc = parseInt(r.totalClosed)
        return tc >= minTrades && tc <= maxTrades
      })
      .sort((a, b) => {
        const av = parseFloat(a[sortKey] ?? 0)
        const bv = parseFloat(b[sortKey] ?? 0)
        return sortDir === 'desc' ? bv - av : av - bv
      })
  }, [ranking, sortKey, sortDir, minTrades, maxTrades])

  function fmtEta(ms) {
    if (!ms) return ''
    const s = Math.round(ms / 1000)
    return s < 60 ? `~${s}s` : `~${Math.floor(s/60)}m ${s%60}s`
  }

  function SortTh({ col, label }) {
    const active = sortKey === col
    return (
      <th onClick={() => handleSort(col)}
        style={{cursor:'pointer', userSelect:'none', color: active ? 'var(--accent)' : undefined, whiteSpace:'nowrap'}}>
        {label}{' '}{active
          ? (sortDir === 'desc' ? '▼' : '▲')
          : <span style={{opacity:0.25}}>▼</span>}
      </th>
    )
  }

  function comboLabel(c) {
    return `EMA${c.emaPeriod} W${c.minWickPct} SL${c.slPct} TP${c.tpPct}`
  }

  const pct = progress ? Math.round(progress.done / progress.total * 100) : 0
  const isRunning        = status === 'running'
  const isLoadingCandles = status === 'loadingCandles'
  const canRun = candles && combos.length >= 3 && !isRunning && !isLoadingCandles

  const inputStyle = { width:'100%', background:'var(--bg)', border:'1px solid var(--border)', borderRadius:'var(--radius)', color:'var(--text)', padding:'7px 10px', fontFamily:'var(--font-mono)', fontSize:13 }

  return (
    <div className="optim-page">

      <header className="optim-page-header">
        <div className="logo">
          <span className="logo-icon">₿</span>
          <div>
            <div className="logo-title">MariaPaz<span style={{color:'var(--accent)'}}>Indicator</span></div>
            <div className="logo-sub">🔬 EMA Touch · Multi-Combo · Desde Excel</div>
          </div>
        </div>
        <div className="optim-page-status">
          {status === 'idle' && combos.length === 0 && 'Carga un archivo Excel para comenzar'}
          {status === 'idle' && combos.length > 0 && !candles && `${combos.length} combos cargados · Carga velas para continuar`}
          {status === 'idle' && combos.length > 0 && candles && `${combos.length} combos · ${candles.length.toLocaleString()} velas · Listo`}
          {isLoadingCandles && 'Cargando velas desde BD...'}
          {isRunning && progress && (
            <span>
              {progress.done.toLocaleString()} / {progress.total.toLocaleString()} · {pct}%
              {progress.eta != null && ` · faltan ${fmtEta(progress.eta)}`}
              {' · '}{ranking.length} grupos
            </span>
          )}
          {status === 'done' && <span style={{color:'var(--green)'}}>✅ Completado · {ranking.length} grupos</span>}
          {status === 'error' && <span style={{color:'var(--red)'}}>⚠️ {errorMsg}</span>}
        </div>
      </header>

      {(isRunning || status === 'done') && progress && (
        <div className="optim-page-progress">
          <div className="progress-track" style={{borderRadius:0, height:3}}>
            <div className="progress-fill" style={{width:`${pct}%`, transition:'width 0.5s ease'}}/>
          </div>
        </div>
      )}

      <div className="optim-page-body">

        <div style={{background:'var(--bg-2)', border:'1px solid var(--border)', borderRadius:'var(--radius-lg)', padding:'20px 24px', marginBottom:20}}>
          <div style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap:24}}>

            {/* Columna izquierda: archivo + fechas + botón cargar */}
            <div style={{display:'flex', flexDirection:'column', gap:14}}>
              <div>
                <div className="optim-label" style={{marginBottom:6}}>Archivo Excel (ranking Análisis Profundo EMA Touch)</div>
                <input ref={fileInputRef} type="file" accept=".xlsx,.xls" onChange={handleFile} style={{display:'none'}}/>
                <div style={{display:'flex', alignItems:'center', gap:10}}>
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    style={{...inputStyle, width:'auto', padding:'7px 14px', cursor:'pointer', background:'var(--bg-3)', fontFamily:'var(--font-ui)', fontWeight:600, fontSize:13, border:'1px solid var(--border-light)'}}>
                    📂 Seleccionar archivo
                  </button>
                  {fileName
                    ? <div style={{fontSize:12, fontFamily:'var(--font-mono)', lineHeight:1.4}}>
                        <div style={{color:'var(--green)'}}>✓ {fileName}</div>
                        <div style={{color:'var(--text-muted)'}}>{combos.length} combos válidos</div>
                      </div>
                    : <span style={{fontSize:12, color:'var(--text-muted)', fontFamily:'var(--font-mono)'}}>Sin archivo seleccionado</span>
                  }
                </div>
              </div>
              <div style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap:10}}>
                <div>
                  <div className="optim-label" style={{marginBottom:4}}>Desde</div>
                  <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} style={inputStyle}/>
                </div>
                <div>
                  <div className="optim-label" style={{marginBottom:4}}>Hasta</div>
                  <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} style={inputStyle}/>
                </div>
              </div>
              <button className="run-btn" style={{padding:'9px'}} onClick={handleLoadCandles} disabled={isLoadingCandles || isRunning}>
                {isLoadingCandles ? <><span className="spinner"/> Cargando velas...</> : '📥 Cargar velas desde BD'}
              </button>
            </div>

            {/* Columna derecha: params + botón ejecutar */}
            <div style={{display:'flex', flexDirection:'column', gap:14}}>
              <div style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap:10}}>
                {[['Fee SL%','feeSlPct',0.01],['Fee TP%','feeTpPct',0.01],['Apalancamiento','leverage',1],['Capital inicial $','initialCapital',100],['EMA lenta','slowEmaPeriod',1]].map(([label, key, step]) => (
                  <div key={key}>
                    <div className="optim-label" style={{marginBottom:4}}>{label}</div>
                    <input type="number" step={step} value={params[key]}
                      onChange={e => setParams(p => ({...p, [key]: parseFloat(e.target.value)}))}
                      style={inputStyle}/>
                  </div>
                ))}
                <div>
                  <div className="optim-label" style={{marginBottom:4}}>Dirección</div>
                  <select value={params.direction}
                    onChange={e => setParams(p => ({...p, direction: e.target.value}))}
                    style={inputStyle}>
                    <option value="BOTH">BOTH (SHORT+LONG)</option>
                    <option value="R">SHORT only</option>
                    <option value="S">LONG only</option>
                  </select>
                </div>
              </div>
              <div style={{marginTop:'auto'}}>
                {status === 'error' && (
                  <div style={{marginBottom:8, padding:'8px 12px', background:'var(--red-dim)', border:'1px solid rgba(239,68,68,0.3)', borderRadius:'var(--radius)', fontSize:12, color:'var(--red)', fontFamily:'var(--font-mono)'}}>
                    ⚠️ {errorMsg}
                  </div>
                )}
                <button className="run-btn optim-btn" style={{width:'100%', padding:11}} onClick={handleRun} disabled={!canRun}>
                  {isRunning
                    ? <><span className="spinner"/> Analizando grupos de 3–15 combos EMA...</>
                    : `🎲 Buscar mejores combinaciones (${combos.length} combos)`}
                </button>
                <div style={{fontSize:11, color:'var(--text-muted)', textAlign:'center', marginTop:6, fontFamily:'var(--font-mono)'}}>
                  Grupos de 3 al 15 combos · 5 000 muestras por tamaño · drawdown ≤ 50%
                </div>
              </div>
            </div>
          </div>
        </div>

        {combos.length > 0 && (
          <div style={{marginBottom:16}}>
            <button onClick={() => setShowCombos(v => !v)}
              style={{background:'none', border:'none', color:'var(--text-muted)', fontSize:12, fontFamily:'var(--font-mono)', cursor:'pointer', padding:'4px 0', display:'flex', alignItems:'center', gap:6}}>
              {showCombos ? '▼' : '▶'} Ver combos cargados ({combos.length})
            </button>
            {showCombos && (
              <div className="table-wrap" style={{marginTop:8}}>
                <table className="data-table">
                  <thead>
                    <tr><th>#</th><th>EMA</th><th>Mecha%</th><th>SL%</th><th>TP%</th><th>Score</th></tr>
                  </thead>
                  <tbody>
                    {combos.map((c, i) => (
                      <tr key={i}>
                        <td style={{color:'var(--text-muted)'}}>{i+1}</td>
                        <td style={{fontWeight:600}}>{c.emaPeriod}</td>
                        <td>{c.minWickPct}</td>
                        <td>{c.slPct}</td><td>{c.tpPct}</td>
                        <td style={{color:'var(--accent)', fontWeight:600}}>{c._score.toFixed(1)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {ranking.length > 0 && (
          <>
            <div className="optim-rank-meta" style={{display:'flex', alignItems:'center', justifyContent:'space-between', flexWrap:'wrap', gap:10}}>
              <span>{sortedRanking.length} / {ranking.length} grupos · Score = Neto% ÷ Drawdown% · drawdown ≤ 50%{isRunning && ' · actualizando en vivo...'}</span>
              <div style={{display:'flex', alignItems:'center', gap:8, fontSize:12, fontFamily:'var(--font-mono)'}}>
                <span style={{color:'var(--text-muted)'}}>Trades:</span>
                <input type="number" min={0} value={minTrades} onChange={e => setMinTrades(Math.max(0, parseInt(e.target.value) || 0))}
                  style={{width:60, background:'var(--bg)', border:'1px solid var(--border)', borderRadius:'var(--radius)', color:'var(--text)', padding:'3px 7px', fontFamily:'var(--font-mono)', fontSize:12, textAlign:'center'}}
                  title="Mínimo de trades"/>
                <span style={{color:'var(--text-muted)'}}>–</span>
                <input type="number" min={0} value={maxTrades} onChange={e => setMaxTrades(Math.max(0, parseInt(e.target.value) || 9999))}
                  style={{width:60, background:'var(--bg)', border:'1px solid var(--border)', borderRadius:'var(--radius)', color:'var(--text)', padding:'3px 7px', fontFamily:'var(--font-mono)', fontSize:12, textAlign:'center'}}
                  title="Máximo de trades"/>
              </div>
            </div>
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <SortTh col="_score"          label="Score"/>
                    <SortTh col="size"            label="Combos"/>
                    <th>Parámetros</th>
                    <SortTh col="totalClosed"     label="Trades"/>
                    <SortTh col="winRate"         label="Win%"/>
                    <SortTh col="totalNetPct"     label="Neto%"/>
                    <SortTh col="maxDrawdownPct"  label="Drawdown%"/>
                    <SortTh col="compoundCapital" label="Capital $"/>
                  </tr>
                </thead>
                <tbody>
                  {sortedRanking.map((r, i) => {
                    const net = parseFloat(r.totalNetPct)
                    const dd  = parseFloat(r.maxDrawdownPct)
                    const sizeColors = { 3:['var(--blue-dim)','var(--blue)'], 4:['var(--green-dim)','var(--green)'], 5:['var(--accent-dim)','var(--accent)'], 6:['var(--orange-dim)','var(--orange)'], 7:['var(--red-dim)','var(--red)'] }
                    const [bgC, fgC] = sizeColors[r.size] ?? ['var(--bg-3)','var(--text)']
                    return (
                      <tr key={i} className="row-win">
                        <td style={{color:'var(--text-muted)'}}>{i+1}</td>
                        <td style={{color:'var(--accent)', fontWeight:700}}>{r._score.toFixed(2)}</td>
                        <td style={{textAlign:'center'}}>
                          <span style={{padding:'2px 10px', borderRadius:20, fontSize:11, fontWeight:600, background:bgC, color:fgC}}>{r.size}</span>
                        </td>
                        <td style={{fontSize:10, lineHeight:1.8}}>
                          {r.combos.map((c, ci) => (
                            <div key={ci} style={{whiteSpace:'nowrap'}}>
                              <span style={{color:'var(--text-muted)', marginRight:5}}>#{c.idx+1}</span>
                              <span style={{color:'var(--text-dim)'}}>{comboLabel(c)}</span>
                            </div>
                          ))}
                        </td>
                        <td>{r.totalClosed}</td>
                        <td>{r.winRate}%</td>
                        <td className={net >= 0 ? 'tp-cell' : 'sl-cell'}>{r.totalNetPct}%</td>
                        <td className={dd > 30 ? 'sl-cell' : ''}>{r.maxDrawdownPct}%</td>
                        <td style={{fontWeight:600}}>
                          ${parseFloat(r.compoundCapital).toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2})}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}

      </div>
    </div>
  )
}

// =============================================================================
// EmaView — Vista principal EMA Touch
// =============================================================================
function EmaView() {
  const [params, setParams]         = useState(DEFAULT_EMA_TOUCH_PARAMS)
  const [result, setResult]         = useState(null)
  const [loading, setLoading]       = useState(false)
  const [error, setError]           = useState(null)
  const [dbStatus, setDbStatus]     = useState(null)
  const [activeTab, setActiveTab]   = useState('stats')
  const [optimMode, setOptimMode]   = useState(false)
  const [multiMode, setMultiMode]   = useState(false)
  const [multiEmaCombo, setMultiEmaCombo] = useState(DEFAULT_EMA_TOUCH_MULTI_COMBOS)
  const [optimRanges, setOptimRanges] = useState(DEFAULT_EMA_TOUCH_OPTIM)
  const optimBcRef = useRef(null)

  const estimatedCombos = useMemo(() => countEmaTouchCombinations(optimRanges), [optimRanges])

  useEffect(() => {
    fetch('/api/status')
      .then(r => r.json())
      .then(d => setDbStatus(d))
      .catch(() => setDbStatus({ connected: false, error: 'No se pudo conectar al servidor' }))
  }, [])

  const set = (key, val) => setParams(p => ({ ...p, [key]: val }))
  const num = (key, val) => set(key, parseFloat(val) || 0)
  const int = (key, val) => set(key, parseInt(val) || 1)
  const setOF = (field, key, val) =>
    setOptimRanges(r => ({ ...r, [field]: { ...r[field], [key]: parseFloat(val) || 0 } }))

  function applyOptimResult(row) {
    setParams(p => ({
      ...p,
      emaPeriod:  row.emaPeriod,
      minWickPct: row.minWickPct,
      slPct:      row.slPct,
      tpPct:      row.tpPct,
    }))
  }

  useEffect(() => {
    const bc = new BroadcastChannel('btc-ema-optim')
    optimBcRef.current = bc
    bc.onmessage = (e) => {
      if (e.data.type === 'apply') {
        applyOptimResult(e.data.row)
      }
    }
    return () => bc.close()
  }, [])

  async function handleRun() {
    setLoading(true); setError(null); setResult(null)
    try {
      const resp = await fetch(`/api/candles?from=${params.dateFrom}&to=${params.dateTo}`)
      if (!resp.ok) throw new Error((await resp.json()).error)
      const { candles, total } = await resp.json()
      if (!total) throw new Error('No se encontraron velas en ese rango de fechas.')
      const bt = runEmaTouchBacktest(candles, params)
      if (!bt) throw new Error('Datos insuficientes para ese período de EMA.')
      setResult({ ...bt, totalCandles: total })
      setActiveTab('stats')
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  async function handleOptimize() {
    setError(null)
    try {
      const resp = await fetch(`/api/candles?from=${params.dateFrom}&to=${params.dateTo}`)
      if (!resp.ok) throw new Error((await resp.json()).error)
      const { candles, total } = await resp.json()
      if (!total) throw new Error('No se encontraron velas en ese rango de fechas.')

      if (optimBcRef.current) optimBcRef.current.close()
      const bc = new BroadcastChannel('btc-ema-optim')
      optimBcRef.current = bc
      bc.onmessage = (e) => {
        if (e.data.type === 'ready') bc.postMessage({ type: 'init', candles, optimRanges, params })
        else if (e.data.type === 'apply') applyOptimResult(e.data.row)
      }
      window.open(window.location.pathname + '?strategy=ema&mode=optim', '_blank')
    } catch (e) {
      setError(e.message)
    }
  }

  const addEmaCombo = () => setMultiEmaCombo(cs =>
    cs.length < 15
      ? [...cs, { ...DEFAULT_EMA_TOUCH_MULTI_COMBOS[0], label: `Combo ${cs.length + 1}` }]
      : cs
  )
  const removeEmaCombo = (ci) => setMultiEmaCombo(cs => cs.filter((_, i) => i !== ci))
  const updateEmaCombo = (ci, key, raw) => {
    const val = key === 'emaPeriod' ? parseInt(raw) || 1 : parseFloat(raw) || 0
    setMultiEmaCombo(cs => cs.map((c, i) => i === ci ? { ...c, [key]: val } : c))
  }

  async function handleMultiRun() {
    setLoading(true); setError(null); setResult(null)
    try {
      const resp = await fetch(`/api/candles?from=${params.dateFrom}&to=${params.dateTo}`)
      if (!resp.ok) throw new Error((await resp.json()).error)
      const { candles, total } = await resp.json()
      if (!total) throw new Error('No se encontraron velas en ese rango de fechas.')
      const bt = runMultiEmaTouchBacktest(candles, multiEmaCombo, {
        feeSlPct: params.feeSlPct,
        feeTpPct: params.feeTpPct,
        leverage: params.leverage,
        initialCapital: params.initialCapital,
        monthlyContribution: params.monthlyContribution,
        slowEmaPeriod: params.slowEmaPeriod,
        emaSlopeLookback: params.emaSlopeLookback,
        emaConsistencyBars: params.emaConsistencyBars,
        maxBodyPct: params.maxBodyPct,
        minCrossBodyPct: params.minCrossBodyPct,
        atrPeriod: params.atrPeriod,
        atrMaPeriod: params.atrMaPeriod,
        atrMaxMultiplier: params.atrMaxMultiplier,
        rsiPeriod: params.rsiPeriod,
        rsiShortMax: params.rsiShortMax,
        rsiLongMin: params.rsiLongMin,
        direction: params.direction,
      })
      if (!bt) throw new Error('Datos insuficientes.')
      setResult({ ...bt, totalCandles: total })
      setActiveTab('stats')
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  const stats   = result?.stats ?? {}
  const winRate = parseFloat(stats.winRate     ?? 0)
  const netPct  = parseFloat(stats.totalNetPct ?? 0)

  const navButtons = (
    <>
      <button className="strategy-tab" onClick={() => { window.location.href = '/' }}>📐 Rango + Resistencias</button>
      <button className="strategy-tab" onClick={() => { window.location.href = '?strategy=sar' }}>📈 SAR</button>
      <button className="strategy-tab" onClick={() => { window.location.href = '?strategy=supertrend' }}>📊 Supertrend</button>
      <button className="strategy-tab" onClick={() => { window.location.href = '?strategy=confluence' }}>🎯 Confluencia</button>
      <button className="strategy-tab" onClick={() => { window.location.href = '?strategy=emapullback' }}>📉 EMA Pullback</button>
      <button className="strategy-tab" onClick={() => { window.location.href = '?strategy=pinbar' }}>🕯️ Pin Bar</button>
      <button className="strategy-tab" onClick={() => { window.location.href = '?strategy=soporte' }}>📗 Rango + Soporte</button>
      <button className="strategy-tab active">📡 EMA Touch</button>
      <button className="strategy-tab" onClick={() => { window.location.href = '?strategy=rangehigh' }}>🏔️ Rango Alto</button>
    </>
  )

  return (
    <div className="app">
      <header className="header">
        <div className="header-inner">
          <div className="logo">
            <span className="logo-icon">₿</span>
            <div>
              <div className="logo-title">MariaPaz<span style={{color:'var(--accent)'}}>Indicator</span></div>
              <div className="logo-sub">EMA Touch · BTCUSDC · 15m</div>
            </div>
          </div>
          <div className={`db-badge ${dbStatus?.connected ? 'connected' : 'disconnected'}`}>
            <span className="db-dot" />
            {dbStatus?.connected
              ? `BD conectada · ${dbStatus.totalCandles?.toLocaleString()} velas`
              : dbStatus?.error ?? 'Conectando...'}
          </div>
        </div>
        <div className="strategy-nav">{navButtons}</div>
      </header>

      <div className="layout">
        <aside className="sidebar">
          <div className="sidebar-scroll">

            <Section title="📅 Rango de fechas">
              <InputGroup label="Desde">
                <input type="date" value={params.dateFrom} onChange={e => set('dateFrom', e.target.value)} />
              </InputGroup>
              <InputGroup label="Hasta">
                <input type="date" value={params.dateTo}   onChange={e => set('dateTo',   e.target.value)} />
              </InputGroup>
            </Section>

            <Section title="📡 Configuración EMA">
              <InputGroup label="Período EMA" tooltip="Número de velas para calcular la EMA de toque">
                <input type="number" step="1" min="2" value={params.emaPeriod} onChange={e => int('emaPeriod', e.target.value)} />
              </InputGroup>
              <InputGroup label="EMA tendencia lenta" tooltip="EMA lenta de contexto. SHORT solo si EMA toque < EMA lenta. LONG solo si EMA toque > EMA lenta. 0 = sin filtro.">
                <input type="number" step="1" min="0" value={params.slowEmaPeriod} onChange={e => int('slowEmaPeriod', e.target.value)} />
              </InputGroup>
              <InputGroup label="Pendiente EMA (velas)" tooltip="Confirma pendiente de la EMA toque. SHORT solo si EMA[i] < EMA[i-N] (bajando). LONG solo si EMA[i] > EMA[i-N] (subiendo). 0 = sin filtro.">
                <input type="number" step="1" min="0" value={params.emaSlopeLookback} onChange={e => int('emaSlopeLookback', e.target.value)} />
              </InputGroup>
              <InputGroup label="Consistencia lado EMA (velas)" tooltip="Mínimo de velas con cuerpo al otro lado de la EMA antes del cruce. Opera SOLO el primer toque tras cruzar. 0 = sin filtro.">
                <input type="number" step="1" min="0" value={params.emaConsistencyBars} onChange={e => int('emaConsistencyBars', e.target.value)} />
              </InputGroup>
              <InputGroup label="Mecha mínima (%)" tooltip="% mínimo de mecha que debe tocar la EMA respecto al rango de la vela">
                <input type="number" step="0.5" min="0" value={params.minWickPct} onChange={e => num('minWickPct', e.target.value)} />
              </InputGroup>
              <InputGroup label="Cuerpo máximo (% rango)" tooltip="Cuerpo |close-open| debe ser menor a este % del rango total de la vela. Filtra cuerpos disfrazados de mecha. 0 = sin filtro.">
                <input type="number" step="5" min="0" max="100" value={params.maxBodyPct} onChange={e => num('maxBodyPct', e.target.value)} />
              </InputGroup>
              <InputGroup label="Dirección">
                <select value={params.direction} onChange={e => set('direction', e.target.value)}
                  style={{width:'100%', background:'var(--bg)', border:'1px solid var(--border)', borderRadius:'var(--radius)', color:'var(--text)', padding:'7px 10px', fontFamily:'var(--font-mono)', fontSize:13}}>
                  <option value="R">▼ Solo SHORT (resistencia)</option>
                  <option value="S">▲ Solo LONG (soporte)</option>
                  <option value="BOTH">⇅ Ambas (SHORT prioridad)</option>
                </select>
              </InputGroup>
            </Section>

            <Section title="📊 Filtros de calidad">
              <InputGroup label="Cruce mín. cuerpo (%)" tooltip="Filtro C: la vela que cruza la EMA debe tener cuerpo ≥ este % del rango. Confirma que el cruce fue decisivo (bajista para SHORT, alcista para LONG). 0 = sin filtro.">
                <input type="number" step="5" min="0" max="80" value={params.minCrossBodyPct} onChange={e => num('minCrossBodyPct', e.target.value)} />
              </InputGroup>
              <InputGroup label="RSI período" tooltip="Filtro B: período del RSI de Wilder. 0 = sin filtro RSI.">
                <input type="number" step="1" min="0" value={params.rsiPeriod} onChange={e => int('rsiPeriod', e.target.value)} />
              </InputGroup>
              <InputGroup label="RSI máx. SHORT" tooltip="Filtro B: solo SHORT si RSI ≤ este valor. Evita entrar cuando el momentum alcista es demasiado fuerte y puede romper la EMA.">
                <input type="number" step="1" min="40" max="90" value={params.rsiShortMax} onChange={e => int('rsiShortMax', e.target.value)} />
              </InputGroup>
              <InputGroup label="RSI mín. LONG" tooltip="Filtro B: solo LONG si RSI ≥ este valor. Evita entrar cuando el momentum bajista es demasiado fuerte y puede romper la EMA.">
                <input type="number" step="1" min="10" max="60" value={params.rsiLongMin} onChange={e => int('rsiLongMin', e.target.value)} />
              </InputGroup>
              <InputGroup label="Período ATR" tooltip="Filtro ATR: volatilidad. 0 = sin filtro ATR.">
                <input type="number" step="1" min="0" value={params.atrPeriod} onChange={e => int('atrPeriod', e.target.value)} />
              </InputGroup>
              <InputGroup label="Período MA del ATR" tooltip="Media del ATR para comparar nivel de volatilidad actual.">
                <input type="number" step="1" min="1" value={params.atrMaPeriod} onChange={e => int('atrMaPeriod', e.target.value)} />
              </InputGroup>
              <InputGroup label="Multiplicador máx. ATR" tooltip="Solo opera si ATR actual ≤ ATR_MA × este valor. 1.5 = permite 50% más de volatilidad que la media.">
                <input type="number" step="0.1" min="0.5" value={params.atrMaxMultiplier} onChange={e => num('atrMaxMultiplier', e.target.value)} />
              </InputGroup>
            </Section>

            <Section title="💰 TP / SL">
              <InputGroup label="TP (%)">
                <input type="number" step="0.05" min="0.01" value={params.tpPct}    onChange={e => num('tpPct',    e.target.value)} />
              </InputGroup>
              <InputGroup label="SL (%)">
                <input type="number" step="0.05" min="0.01" value={params.slPct}    onChange={e => num('slPct',    e.target.value)} />
              </InputGroup>
              <InputGroup label="Fee extra SL (%)">
                <input type="number" step="0.01" min="0"    value={params.feeSlPct} onChange={e => num('feeSlPct', e.target.value)} />
              </InputGroup>
              <InputGroup label="Fee descontado TP (%)">
                <input type="number" step="0.01" min="0"    value={params.feeTpPct} onChange={e => num('feeTpPct', e.target.value)} />
              </InputGroup>
              <InputGroup label="Apalancamiento">
                <input type="number" step="1"    min="1"    value={params.leverage} onChange={e => num('leverage', e.target.value)} />
              </InputGroup>
            </Section>

            <Section title="💵 Capital">
              <InputGroup label="Capital inicial ($)">
                <input type="number" step="100" min="1" value={params.initialCapital}      onChange={e => num('initialCapital',      e.target.value)} />
              </InputGroup>
              <InputGroup label="Aporte mensual ($)">
                <input type="number" step="10"  min="0" value={params.monthlyContribution} onChange={e => num('monthlyContribution', e.target.value)} />
              </InputGroup>
            </Section>

            {/* ── Análisis Profundo ── */}
            <div className="section">
              <button
                className="section-title collapsible"
                style={{width:'100%', textAlign:'left', background:'none', border:'none', color:'var(--text)', cursor:'pointer', padding:0, display:'flex', justifyContent:'space-between'}}
                onClick={() => { setOptimMode(v => !v); setMultiMode(false) }}
              >
                <span>🔬 Análisis Profundo</span>
                <span style={{color:'var(--text-muted)', fontSize:11}}>{optimMode ? '▲' : '▼'}</span>
              </button>
              {optimMode && (
                <div style={{marginTop:10, display:'flex', flexDirection:'column', gap:6}}>
                  <div style={{fontSize:11, color:'var(--text-muted)', fontFamily:'var(--font-mono)', marginBottom:4}}>
                    ~{estimatedCombos.toLocaleString()} combinaciones
                  </div>

                  {[
                    ['emaPeriod',  'Período EMA',  1,    true],
                    ['minWickPct', 'Mecha%',        0.5,  false],
                    ['slPct',      'SL%',           0.05, false],
                    ['tpPct',      'TP%',           0.05, false],
                  ].map(([field, label, step, isInt]) => (
                    <div key={field}>
                      <div style={{fontSize:11, color:'var(--text-muted)', fontFamily:'var(--font-mono)', marginBottom:3}}>{label}</div>
                      <div style={{display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:4}}>
                        {['min','max','step'].map(k => (
                          <input key={k} type="number" step={step} min={step}
                            placeholder={k}
                            value={optimRanges[field][k]}
                            onChange={e => setOF(field, k, e.target.value)}
                            style={{background:'var(--bg)', border:'1px solid var(--border)', borderRadius:'var(--radius)', color:'var(--text)', padding:'5px 7px', fontFamily:'var(--font-mono)', fontSize:12, width:'100%'}}
                            title={k}
                          />
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* ── Multi-Combinaciones ── */}
            <div className="section optim-section">
              <div className="optim-section-header" onClick={() => { setMultiMode(v => !v); setOptimMode(false) }}>
                <span className="section-title" style={{marginBottom:0, borderBottom:'none', paddingBottom:0}}>🎯 Multi-Combinaciones</span>
                <span className="optim-chevron">{multiMode ? '▲' : '▼'}</span>
              </div>
              {multiMode && (
                <div className="optim-body">
                  <div style={{fontSize:11, color:'var(--text-muted)', marginBottom:8, lineHeight:1.5}}>
                    Hasta 15 combos. Filtros de calidad y capital compartidos. 1 trade/día — dispara el primero.
                  </div>
                  {multiEmaCombo.map((combo, ci) => (
                    <div key={ci} className="multi-combo-block">
                      <div className="multi-combo-header">
                        <span style={{fontSize:11, fontWeight:700, color:'var(--accent)', textTransform:'uppercase', letterSpacing:'0.06em'}}>
                          Combo {ci + 1}
                        </span>
                        {multiEmaCombo.length > 1 && (
                          <button className="multi-remove-btn" onClick={() => removeEmaCombo(ci)}>✕</button>
                        )}
                      </div>
                      <div className="multi-combo-fields">
                        <div className="multi-field">
                          <label>EMA</label>
                          <input type="number" step="1" min="2" value={combo.emaPeriod} onChange={e => updateEmaCombo(ci, 'emaPeriod', e.target.value)} />
                        </div>
                        <div className="multi-field">
                          <label>Mecha%</label>
                          <input type="number" step="0.5" min="0" value={combo.minWickPct} onChange={e => updateEmaCombo(ci, 'minWickPct', e.target.value)} />
                        </div>
                        <div className="multi-field">
                          <label>SL%</label>
                          <input type="number" step="0.05" min="0.01" value={combo.slPct} onChange={e => updateEmaCombo(ci, 'slPct', e.target.value)} />
                        </div>
                        <div className="multi-field">
                          <label>TP%</label>
                          <input type="number" step="0.05" min="0.01" value={combo.tpPct} onChange={e => updateEmaCombo(ci, 'tpPct', e.target.value)} />
                        </div>
                      </div>
                    </div>
                  ))}
                  {multiEmaCombo.length < 15 && (
                    <button
                      className="run-btn optim-btn"
                      style={{width:'100%', marginTop:4, padding:'8px', fontSize:12}}
                      onClick={addEmaCombo}
                    >
                      + Agregar combo
                    </button>
                  )}
                </div>
              )}
            </div>

          </div>

          <div className="sidebar-footer">
            {optimMode
              ? <>
                  <button className="run-btn optim-btn" onClick={handleOptimize} disabled={!dbStatus?.connected}>
                    🔬 Abrir Análisis Profundo
                  </button>
                  <button className="run-btn optim-btn" style={{marginTop:'0.4rem'}}
                    onClick={() => window.open(window.location.pathname + '?strategy=ema&mode=exceloptim', '_blank')}>
                    📊 Análisis Multi-Combo Excel
                  </button>
                </>
              : multiMode
              ? <button className="run-btn" onClick={handleMultiRun} disabled={loading || !dbStatus?.connected}>
                  {loading ? <><span className="spinner" /> Procesando...</> : `🎯 Ejecutar ${multiEmaCombo.length} Combos`}
                </button>
              : <button className="run-btn" onClick={handleRun} disabled={loading || !dbStatus?.connected}>
                  {loading ? <><span className="spinner" /> Procesando...</> : '▶ Ejecutar Backtest'}
                </button>
            }
            {error && <div className="error-box">⚠️ {error}</div>}
          </div>
        </aside>

        {/* ── MAIN ── */}
        <main className="main">
          {!result && !loading && (
            <div className="empty-state">
              <div className="empty-icon">📡</div>
              <div className="empty-title">EMA Touch</div>
              <div className="empty-sub">
                Señal cuando la mecha de la vela toca la EMA<br/>
                manteniendo el cuerpo del lado contrario.<br/>
                <strong>SHORT</strong>: mecha superior · <strong>LONG</strong>: mecha inferior · 1 trade/día
              </div>
            </div>
          )}

          {loading && (
            <div className="empty-state">
              <div className="loading-ring" />
              <div className="empty-title">Analizando velas...</div>
              <div className="empty-sub">Calculando EMA · detectando toques de mecha</div>
            </div>
          )}

          {result && !loading && (
            <>
              <div className="result-header">
                <div className="result-meta">
                  <span>📊 {result.totalCandles.toLocaleString()} velas</span>
                  <span>·</span>
                  <span>{params.dateFrom} → {params.dateTo}</span>
                  <span>·</span>
                  <span>EMA {params.emaPeriod} · {params.direction === 'R' ? '▼ SHORT' : params.direction === 'S' ? '▲ LONG' : '⇅ Ambas'}</span>
                </div>
                <div className="tabs">
                  <button className={activeTab === 'stats'   ? 'tab active' : 'tab'} onClick={() => setActiveTab('stats')}>Estadísticas</button>
                  <button className={activeTab === 'trades'  ? 'tab active' : 'tab'} onClick={() => setActiveTab('trades')}>Trades ({result.trades.length})</button>
                  <button className={activeTab === 'signals' ? 'tab active' : 'tab'} onClick={() => setActiveTab('signals')}>Señales ({result.signals.length})</button>
                </div>
              </div>

              {activeTab === 'stats' && (
                <>
                  <div className="stats-grid">
                    <StatCard label="Trades cerrados"                      value={stats.totalClosed}    variant="neutral" />
                    <StatCard label="TP ✅"                                 value={stats.totalTp}        variant="win" />
                    <StatCard label="SL ❌"                                 value={stats.totalSl}        variant="loss" />
                    <StatCard label="Win Rate"                              value={`${stats.winRate}%`}  variant={winRate >= 50 ? 'win' : 'loss'} />
                    <StatCard label={`Ganancia acum. x${params.leverage}`} value={`${stats.totalProfitPct}%`} variant="win" />
                    <StatCard label={`Pérdida acum. x${params.leverage}`}  value={`${stats.totalLossPct}%`}  variant="loss" />
                    <StatCard label={`Neto x${params.leverage}`}           value={`${stats.totalNetPct}%`}   variant={netPct >= 0 ? 'win' : 'loss'} />
                    <StatCard label="Máx. Drawdown"                        value={`${stats.maxDrawdownPct}%`} variant="warn" />
                    <StatCard label="Capital simple"    value={`$${parseFloat(stats.simpleCapital).toLocaleString('es-CO',{minimumFractionDigits:2})}`}   variant="neutral" />
                    <StatCard label="Capital compuesto" value={`$${parseFloat(stats.compoundCapital).toLocaleString('es-CO',{minimumFractionDigits:2})}`} variant="accent" />
                    <StatCard label="Mejor método"                         value={stats.bestMethod}     variant="accent" />
                    {!result.isMulti && <StatCard label={`TP efectivo x${params.leverage}`} value={`${stats.effectiveTpPct}%`} variant="neutral" />}
                    {!result.isMulti && <StatCard label={`SL efectivo x${params.leverage}`} value={`${stats.effectiveSlPct}%`} variant="neutral" />}
                    {result.isMulti  && <StatCard label="Combos activos" value={multiEmaCombo.length} variant="neutral" />}
                  </div>

                  {result.trades.length > 0 && (() => {
                    const effTp = parseFloat(stats.effectiveTpPct ?? 0)
                    const effSl = parseFloat(stats.effectiveSlPct ?? 0)
                    const { byYear, byMonth, byCombo } = computePeriodStats(result.trades, effTp, effSl)
                    return <>
                      {result.isMulti && <PeriodTable title="🎯 Acumulado por combo" rows={byCombo} />}
                      <PeriodTable title="📅 Acumulado por año" rows={byYear}  />
                      <PeriodTable title="📆 Acumulado por mes" rows={byMonth} />
                    </>
                  })()}
                </>
              )}

              {activeTab === 'trades' && (
                <div className="table-wrap">
                  {result.trades.length === 0
                    ? <div className="empty-table">No se cerraron trades en este período</div>
                    : (
                      <table className="data-table">
                        <thead>
                          <tr>
                            <th>#</th><th>Lado</th>{result.isMulti && <th>Combo</th>}<th>Apertura</th><th>Entrada</th>
                            <th>EMA</th><th>Mecha%</th>
                            <th>TP</th><th>SL</th><th>Cierre</th><th>Resultado</th>
                            <th>Capital entrada</th><th>Capital salida</th>
                          </tr>
                        </thead>
                        <tbody>
                          {result.trades.map((t, i) => (
                            <tr key={i} className={t.result === 'TP' ? 'row-win' : 'row-loss'}>
                              <td>{i + 1}</td>
                              <td><span className={`badge badge-${t.tipo === 'S' ? 'tp' : 'sl'}`}>{t.tipo === 'S' ? '▲ LONG' : '▼ SHORT'}</span></td>
                              {result.isMulti && <td style={{fontFamily:'var(--font-mono)',fontSize:11,color:'var(--accent)'}}>{t.comboLabel}</td>}
                              <td style={{fontFamily:'var(--font-mono)',fontSize:11}}>{new Date(t.entryTime).toLocaleString('es-CO',{timeZone:'UTC'})}</td>
                              <td style={{fontFamily:'var(--font-mono)'}}>${parseFloat(t.price).toLocaleString('en-US')}</td>
                              <td style={{fontFamily:'var(--font-mono)',color:'var(--accent)'}}>${parseFloat(t.emaVal).toLocaleString('en-US')}</td>
                              <td style={{fontFamily:'var(--font-mono)'}}>{t.wickPct}%</td>
                              <td className="tp-cell" style={{fontFamily:'var(--font-mono)'}}>${parseFloat(t.tp).toLocaleString('en-US')}</td>
                              <td className="sl-cell" style={{fontFamily:'var(--font-mono)'}}>${parseFloat(t.sl).toLocaleString('en-US')}</td>
                              <td style={{fontFamily:'var(--font-mono)',fontSize:11}}>{new Date(t.closeTime).toLocaleString('es-CO',{timeZone:'UTC'})}</td>
                              <td><span className={`badge badge-${t.result.toLowerCase()}`}>{t.result === 'TP' ? '✅ TP' : '❌ SL'}</span></td>
                              <td>${parseFloat(t.capitalAtEntry).toLocaleString('es-CO',{minimumFractionDigits:2,maximumFractionDigits:2})}</td>
                              <td className={t.result === 'TP' ? 'tp-cell' : 'sl-cell'}>${parseFloat(t.capitalAtExit).toLocaleString('es-CO',{minimumFractionDigits:2,maximumFractionDigits:2})}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )
                  }
                </div>
              )}

              {activeTab === 'signals' && (
                <div className="table-wrap">
                  {result.signals.length === 0
                    ? <div className="empty-table">No se generaron señales en este período</div>
                    : (
                      <table className="data-table">
                        <thead>
                          <tr>
                            <th>#</th><th>Fecha</th><th>Lado</th><th>Precio</th><th>EMA</th><th>Mecha%</th>
                          </tr>
                        </thead>
                        <tbody>
                          {result.signals.map((s, i) => (
                            <tr key={i}>
                              <td>{i + 1}</td>
                              <td style={{fontFamily:'var(--font-mono)',fontSize:11}}>{new Date(s.time).toLocaleString('es-CO',{timeZone:'UTC'})}</td>
                              <td><span className={`badge badge-${s.tipo === 'S' ? 'tp' : 'sl'}`}>{s.tipo === 'S' ? '▲ LONG' : '▼ SHORT'}</span></td>
                              <td style={{fontFamily:'var(--font-mono)'}}>${parseFloat(s.price).toLocaleString('en-US')}</td>
                              <td style={{fontFamily:'var(--font-mono)',color:'var(--accent)'}}>${parseFloat(s.emaVal).toLocaleString('en-US')}</td>
                              <td style={{fontFamily:'var(--font-mono)'}}>{s.wickPct}%</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )
                  }
                </div>
              )}
            </>
          )}
        </main>
      </div>
    </div>
  )
}

// =============================================================================
// RangeHighView — Rango Dinámico + Toque con Mecha (SHORT y LONG)
// =============================================================================
function RangeHighView() {
  const [params, setParams]     = useState(DEFAULT_RANGE_HIGH_PARAMS)
  const [result, setResult]     = useState(null)
  const [loading, setLoading]   = useState(false)
  const [error, setError]       = useState(null)
  const [dbStatus, setDbStatus] = useState(null)
  const [activeTab, setActiveTab] = useState('stats')
  const [multiMode, setMultiMode] = useState(false)
  const [multiCombos, setMultiCombos] = useState(DEFAULT_RANGE_HIGH_MULTI_COMBOS)

  useEffect(() => {
    fetch('/api/status')
      .then(r => r.json())
      .then(d => setDbStatus(d))
      .catch(() => setDbStatus({ connected: false, error: 'No se pudo conectar al servidor' }))
  }, [])

  const set = (key, val) => setParams(p => ({ ...p, [key]: val }))
  const num = (key, val) => set(key, parseFloat(val) || 0)
  const int = (key, val) => set(key, parseInt(val) || 1)

  async function handleRun() {
    setLoading(true); setError(null); setResult(null)
    try {
      const resp = await fetch(`/api/candles?from=${params.dateFrom}&to=${params.dateTo}`)
      if (!resp.ok) throw new Error((await resp.json()).error)
      const { candles, total } = await resp.json()
      if (!total) throw new Error('No se encontraron velas en ese rango de fechas.')
      const bt = runRangeHighBacktest(candles, params)
      if (!bt) throw new Error('No se pudieron calcular resultados.')
      setResult({ ...bt, totalCandles: total })
      setActiveTab('stats')
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  async function handleMultiRun() {
    setLoading(true); setError(null); setResult(null)
    try {
      const resp = await fetch(`/api/candles?from=${params.dateFrom}&to=${params.dateTo}`)
      if (!resp.ok) throw new Error((await resp.json()).error)
      const { candles, total } = await resp.json()
      if (!total) throw new Error('No se encontraron velas en ese rango de fechas.')
      const bt = runMultiRangeHighBacktest(candles, multiCombos, {
        feeSlPct:            params.feeSlPct,
        feeTpPct:            params.feeTpPct,
        leverage:            params.leverage,
        initialCapital:      params.initialCapital,
        monthlyContribution: params.monthlyContribution,
      })
      setResult({ ...bt, totalCandles: total })
      setActiveTab('stats')
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  function handleDownloadDebug() {
    if (!result?.debugLog) return
    const blob = new Blob([JSON.stringify(result.debugLog, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = `debug_rangehigh_${params.dateFrom}_${params.dateTo}.json`; a.click()
    URL.revokeObjectURL(url)
  }

  const addCombo = () => setMultiCombos(cs =>
    cs.length < 15
      ? [...cs, { ...DEFAULT_RANGE_HIGH_MULTI_COMBOS[0], label: `Combo ${cs.length + 1}` }]
      : cs
  )
  const removeCombo = (ci) => setMultiCombos(cs => cs.filter((_, i) => i !== ci))
  const updateCombo = (ci, key, raw) => {
    const val = key === 'lookbackCandles' ? parseInt(raw) || 1 : parseFloat(raw) || 0
    setMultiCombos(cs => cs.map((c, i) => i === ci ? { ...c, [key]: val } : c))
  }

  const stats   = result?.stats ?? {}
  const winRate = parseFloat(stats.winRate     ?? 0)
  const netPct  = parseFloat(stats.totalNetPct ?? 0)

  return (
    <div className="app">
      <header className="header">
        <div className="header-inner">
          <div className="logo">
            <span className="logo-icon">₿</span>
            <div>
              <div className="logo-title">MariaPaz<span style={{color:'var(--accent)'}}>Indicator</span></div>
              <div className="logo-sub">Rango Alto · SHORT + LONG · BTCUSDC · 15m</div>
            </div>
          </div>
          <div className={`db-badge ${dbStatus?.connected ? 'connected' : 'disconnected'}`}>
            <span className="db-dot" />
            {dbStatus?.connected
              ? `BD conectada · ${dbStatus.totalCandles?.toLocaleString()} velas`
              : dbStatus?.error ?? 'Conectando...'}
          </div>
        </div>
        <div className="strategy-nav">
          <button className="strategy-tab" onClick={() => { window.location.href = '/' }}>📐 Rango + Resistencias</button>
          <button className="strategy-tab" onClick={() => { window.location.href = '?strategy=sar' }}>📈 SAR</button>
          <button className="strategy-tab" onClick={() => { window.location.href = '?strategy=supertrend' }}>📊 Supertrend</button>
          <button className="strategy-tab" onClick={() => { window.location.href = '?strategy=confluence' }}>🎯 Confluencia</button>
          <button className="strategy-tab" onClick={() => { window.location.href = '?strategy=emapullback' }}>📉 EMA Pullback</button>
          <button className="strategy-tab" onClick={() => { window.location.href = '?strategy=pinbar' }}>🕯️ Pin Bar</button>
          <button className="strategy-tab" onClick={() => { window.location.href = '?strategy=soporte' }}>📗 Rango + Soporte</button>
          <button className="strategy-tab" onClick={() => { window.location.href = '?strategy=ema' }}>📡 EMA Touch</button>
          <button className="strategy-tab active">🏔️ Rango Alto</button>
        </div>
      </header>

      <div className="layout">
        <aside className="sidebar">
          <div className="sidebar-scroll">

            <Section title="📅 Rango de fechas">
              <InputGroup label="Desde">
                <input type="date" value={params.dateFrom} onChange={e => set('dateFrom', e.target.value)} />
              </InputGroup>
              <InputGroup label="Hasta">
                <input type="date" value={params.dateTo}   onChange={e => set('dateTo',   e.target.value)} />
              </InputGroup>
            </Section>

            <Section title="📐 Configuración del Rango">
              <InputGroup label="Mínimo (%)" tooltip="% mínimo de compresión del rango">
                <input type="number" step="0.1" value={params.minRangePct} onChange={e => num('minRangePct', e.target.value)} />
              </InputGroup>
              <InputGroup label="Máximo (%)" tooltip="% máximo de compresión del rango">
                <input type="number" step="0.1" value={params.maxRangePct} onChange={e => num('maxRangePct', e.target.value)} />
              </InputGroup>
              <InputGroup label="Velas lookback">
                <input type="number" step="1" min="1" value={params.lookbackCandles} onChange={e => int('lookbackCandles', e.target.value)} />
              </InputGroup>
              <InputGroup label="Mecha mínima (%)" tooltip="% mínimo de mecha respecto al rango total de la vela">
                <input type="number" step="0.1" value={params.minWickPct} onChange={e => num('minWickPct', e.target.value)} />
              </InputGroup>
            </Section>

            <Section title="⚖️ TP / SL">
              <InputGroup label="Buffer SL (%)" tooltip="% adicional sobre el High (SHORT) o bajo el Low (LONG) para colocar el SL">
                <input type="number" step="0.01" value={params.slBufferPct} onChange={e => num('slBufferPct', e.target.value)} />
              </InputGroup>
              <InputGroup label="TP (%)">
                <input type="number" step="0.01" value={params.tpPct} onChange={e => num('tpPct', e.target.value)} />
              </InputGroup>
            </Section>

            <Section title="📊 Estadísticas">
              <InputGroup label="Fee SL extra (%)">
                <input type="number" step="0.01" value={params.feeSlPct} onChange={e => num('feeSlPct', e.target.value)} />
              </InputGroup>
              <InputGroup label="Fee TP (%)">
                <input type="number" step="0.01" value={params.feeTpPct} onChange={e => num('feeTpPct', e.target.value)} />
              </InputGroup>
              <InputGroup label="Apalancamiento">
                <input type="number" step="1" min="1" value={params.leverage} onChange={e => num('leverage', e.target.value)} />
              </InputGroup>
              <InputGroup label="Capital inicial ($)">
                <input type="number" step="100" min="1" value={params.initialCapital} onChange={e => num('initialCapital', e.target.value)} />
              </InputGroup>
              <InputGroup label="Aporte mensual ($)" tooltip="Monto que se suma al capital compuesto cada mes. 0 = sin aporte.">
                <input type="number" step="50" min="0" value={params.monthlyContribution} onChange={e => num('monthlyContribution', e.target.value)} />
              </InputGroup>
            </Section>

            <div className="section optim-section">
              <div className="optim-section-header" onClick={() => setMultiMode(v => !v)}>
                <span className="section-title" style={{marginBottom:0, borderBottom:'none', paddingBottom:0}}>🎯 Multi-Combinaciones</span>
                <span className="optim-chevron">{multiMode ? '▲' : '▼'}</span>
              </div>
              {multiMode && (
                <div className="optim-body">
                  <div style={{fontSize:11, color:'var(--text-muted)', marginBottom:8, lineHeight:1.5}}>
                    Hasta 15 combos. 1 trade/día — gana el primero que dispare señal (SHORT tiene prioridad sobre LONG).
                  </div>
                  {multiCombos.map((combo, ci) => (
                    <div key={ci} className="multi-combo-block">
                      <div className="multi-combo-header">
                        <span style={{fontSize:11, fontWeight:700, color:'var(--accent)', textTransform:'uppercase', letterSpacing:'0.06em'}}>
                          Combo {ci + 1}
                        </span>
                        {multiCombos.length > 1 && (
                          <button className="multi-remove-btn" onClick={() => removeCombo(ci)}>✕</button>
                        )}
                      </div>
                      <div className="multi-combo-fields">
                        <div className="multi-field">
                          <label>Min%</label>
                          <input type="number" step="0.1" value={combo.minRangePct} onChange={e => updateCombo(ci, 'minRangePct', e.target.value)} />
                        </div>
                        <div className="multi-field">
                          <label>Max%</label>
                          <input type="number" step="0.1" value={combo.maxRangePct} onChange={e => updateCombo(ci, 'maxRangePct', e.target.value)} />
                        </div>
                        <div className="multi-field">
                          <label>LB</label>
                          <input type="number" step="1" min="1" value={combo.lookbackCandles} onChange={e => updateCombo(ci, 'lookbackCandles', e.target.value)} />
                        </div>
                        <div className="multi-field">
                          <label>Mecha%</label>
                          <input type="number" step="0.1" value={combo.minWickPct} onChange={e => updateCombo(ci, 'minWickPct', e.target.value)} />
                        </div>
                        <div className="multi-field">
                          <label>Buffer%</label>
                          <input type="number" step="0.01" value={combo.slBufferPct} onChange={e => updateCombo(ci, 'slBufferPct', e.target.value)} />
                        </div>
                        <div className="multi-field">
                          <label>TP%</label>
                          <input type="number" step="0.01" value={combo.tpPct} onChange={e => updateCombo(ci, 'tpPct', e.target.value)} />
                        </div>
                      </div>
                    </div>
                  ))}
                  {multiCombos.length < 15 && (
                    <button
                      className="run-btn optim-btn"
                      style={{width:'100%', marginTop:4, padding:'8px', fontSize:12}}
                      onClick={addCombo}
                    >
                      + Agregar combo
                    </button>
                  )}
                </div>
              )}
            </div>

            <div style={{display:'flex', gap:8, marginTop:8}}>
              <button
                className="run-btn"
                style={{flex:1}}
                onClick={multiMode ? handleMultiRun : handleRun}
                disabled={loading}
              >
                {loading ? 'Calculando...' : multiMode ? '▶ Correr Multi' : '▶ Correr Backtest'}
              </button>
            </div>

            {result?.debugLog && (
              <button className="run-btn optim-btn" style={{width:'100%', marginTop:6, fontSize:11}} onClick={handleDownloadDebug}>
                ⬇ Debug JSON
              </button>
            )}

          </div>
        </aside>

        <main className="main">
          {error && <div className="error-box">{error}</div>}

          {result && (
            <>
              <div className="tabs">
                <button className={`tab ${activeTab === 'stats'  ? 'active' : ''}`} onClick={() => setActiveTab('stats')}>Estadísticas</button>
                <button className={`tab ${activeTab === 'trades' ? 'active' : ''}`} onClick={() => setActiveTab('trades')}>Trades ({result.trades?.length ?? 0})</button>
                <button className={`tab ${activeTab === 'signals'? 'active' : ''}`} onClick={() => setActiveTab('signals')}>Señales ({result.signals?.length ?? 0})</button>
              </div>

              {activeTab === 'stats' && (
                <div className="stats-grid">
                  <StatCard label="TP"          value={stats.totalTp}                         color="var(--green)" />
                  <StatCard label="SL"          value={stats.totalSl}                         color="var(--red)" />
                  <StatCard label="Total"       value={stats.totalClosed} />
                  <StatCard label="Win Rate"    value={`${parseFloat(stats.winRate ?? 0).toFixed(1)}%`} color={winRate >= 50 ? 'var(--green)' : 'var(--red)'} />
                  <StatCard label="Ganancia"    value={`${stats.totalProfitPct}%`}             color="var(--green)" />
                  <StatCard label="Pérdida"     value={`${stats.totalLossPct}%`}               color="var(--red)" />
                  <StatCard label="Neto"        value={`${stats.totalNetPct}%`}                color={netPct >= 0 ? 'var(--green)' : 'var(--red)'} />
                  <StatCard label="Max DD"      value={`${stats.maxDrawdownPct}%`}             color="var(--orange)" />
                  <StatCard label="Capital S"   value={`$${parseFloat(stats.simpleCapital ?? 0).toLocaleString(undefined,{maximumFractionDigits:0})}`} />
                  <StatCard label="Capital C"   value={`$${parseFloat(stats.compoundCapital ?? 0).toLocaleString(undefined,{maximumFractionDigits:0})}`} color="var(--accent)" />
                  <StatCard label="TP efectivo" value={`${stats.effectiveTpPct ?? '—'}%`} />
                  <StatCard label="Velas"       value={result.totalCandles?.toLocaleString()} />
                </div>
              )}

              {activeTab === 'trades' && (
                <div className="table-wrap">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Fecha</th>
                        <th>Tipo</th>
                        {result.isMulti && <th>Combo</th>}
                        <th>Entrada</th>
                        <th>SL</th>
                        <th>TP</th>
                        <th>Resultado</th>
                        <th>Cierre</th>
                        <th>Capital</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.trades.map((t, i) => (
                        <tr key={i} className={t.result === 'TP' ? 'row-tp' : 'row-sl'}>
                          <td>{t.time?.substring(0,16)}</td>
                          <td style={{color: t.tipo === 'SHORT' ? 'var(--red)' : 'var(--green)', fontWeight:700}}>{t.tipo}</td>
                          {result.isMulti && <td>{t.comboLabel}</td>}
                          <td>${parseFloat(t.price).toLocaleString(undefined,{maximumFractionDigits:0})}</td>
                          <td>${parseFloat(t.sl).toLocaleString(undefined,{maximumFractionDigits:0})}</td>
                          <td>${parseFloat(t.tp).toLocaleString(undefined,{maximumFractionDigits:0})}</td>
                          <td style={{color: t.result === 'TP' ? 'var(--green)' : 'var(--red)', fontWeight:700}}>{t.result}</td>
                          <td>{t.closeTime?.substring(0,16)}</td>
                          <td>${parseFloat(t.capitalAtExit ?? 0).toLocaleString(undefined,{maximumFractionDigits:0})}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {activeTab === 'signals' && (
                <div className="table-wrap">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Fecha</th>
                        <th>Tipo</th>
                        {result.isMulti && <th>Combo</th>}
                        <th>Entrada</th>
                        <th>SL</th>
                        <th>TP</th>
                        <th>Rango %</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.signals.map((s, i) => (
                        <tr key={i}>
                          <td>{s.time?.substring(0,16)}</td>
                          <td style={{color: s.tipo === 'SHORT' ? 'var(--red)' : 'var(--green)', fontWeight:700}}>{s.tipo}</td>
                          {result.isMulti && <td>{s.comboLabel}</td>}
                          <td>${parseFloat(s.price).toLocaleString(undefined,{maximumFractionDigits:0})}</td>
                          <td>${parseFloat(s.sl).toLocaleString(undefined,{maximumFractionDigits:0})}</td>
                          <td>${parseFloat(s.tp).toLocaleString(undefined,{maximumFractionDigits:0})}</td>
                          <td>{s.rangePct}%</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}

          {!result && !loading && !error && (
            <div className="empty-state">
              <div style={{fontSize:48, marginBottom:12}}>🏔️</div>
              <div style={{fontSize:18, marginBottom:8}}>Rango Dinámico · Toque con Mecha</div>
              <div style={{color:'var(--text-muted)', fontSize:13}}>
                SHORT en techo del rango · LONG en piso del rango<br/>
                SL sobre el High de la vela señal · 1 trade por día
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  )
}

// =============================================================================
// SupertrendExcelOptimView — Multi-Combo Excel para Supertrend
// =============================================================================
function SupertrendExcelOptimView() {
  const [combos, setCombos]         = useState([])
  const [fileName, setFileName]     = useState('')
  const [candles, setCandles]       = useState(null)
  const [status, setStatus]         = useState('idle')
  const [progress, setProgress]     = useState(null)
  const [ranking, setRanking]       = useState([])
  const [errorMsg, setErrorMsg]     = useState('')
  const [dateFrom, setDateFrom]     = useState('2022-01-01')
  const [dateTo, setDateTo]         = useState(new Date().toISOString().split('T')[0])
  const [params, setParams]         = useState({ feeSlPct: 0.10, feeTpPct: 0.05, leverage: 10, initialCapital: 1000 })
  const [sortKey, setSortKey]       = useState('_score')
  const [sortDir, setSortDir]       = useState('desc')
  const [showCombos, setShowCombos] = useState(false)
  const [minTrades, setMinTrades]   = useState(0)
  const [maxTrades, setMaxTrades]   = useState(9999)
  const startTimeRef = useRef(null)
  const workerRef    = useRef(null)
  const fileInputRef = useRef(null)

  function parseNum(v) {
    if (typeof v === 'number') return v
    if (typeof v === 'string') return parseFloat(v.replace(',', '.'))
    return NaN
  }

  function handleFile(e) {
    const file = e.target.files[0]
    if (!file) return
    setFileName(file.name)
    const reader = new FileReader()
    reader.onload = (ev) => {
      const wb = XLSX.read(ev.target.result, { type: 'array' })
      const ws = wb.Sheets[wb.SheetNames[0]]
      const rows = XLSX.utils.sheet_to_json(ws, { defval: '' })
      const parsed = rows.map(row => ({
        atrPeriod:    Math.round(parseNum(row['ATR Period'] ?? row['atrPeriod'] ?? row['ATR Per.'] ?? NaN)),
        atrMultiplier: parseNum(row['Mult.'] ?? row['atrMultiplier'] ?? NaN),
        atrVolFilter:  parseNum(row['ATR Vol.'] ?? row['atrVolFilter'] ?? 0),
        rsiThreshold:  parseNum(row['RSI'] ?? row['rsiThreshold'] ?? 0),
        bodyRatioMin:  parseNum(row['Body'] ?? row['bodyRatioMin'] ?? 0),
        tpPct:         parseNum(row['TP%'] ?? row['tpPct'] ?? NaN),
        slPct:         parseNum(row['SL%'] ?? row['slPct'] ?? NaN),
        _score:        parseNum(row['Score'] ?? row['_score'] ?? 0),
      })).filter(c =>
        !isNaN(c.atrPeriod) && c.atrPeriod > 0 &&
        !isNaN(c.atrMultiplier) && c.atrMultiplier > 0 &&
        !isNaN(c.tpPct) && !isNaN(c.slPct)
      )
      setCombos(parsed)
      setRanking([])
      setStatus('idle')
    }
    reader.readAsArrayBuffer(file)
  }

  async function handleLoadCandles() {
    setStatus('loadingCandles')
    setErrorMsg('')
    try {
      const res = await fetch(`http://localhost:3001/api/candles?from=${dateFrom}&to=${dateTo}`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Error cargando velas')
      setCandles(data.candles)
      setStatus('idle')
    } catch (err) {
      setErrorMsg(err.message)
      setStatus('error')
    }
  }

  function handleRun() {
    if (!candles || combos.length < 3) return
    workerRef.current?.terminate()
    setStatus('running')
    setRanking([])
    setProgress(null)
    startTimeRef.current = Date.now()

    const worker = new Worker(new URL('./supertrendExcelMultiWorker.js', import.meta.url), { type: 'module' })
    workerRef.current = worker
    worker.onmessage = (ev) => {
      const m = ev.data
      if (m.type === 'progress') {
        const elapsed = Date.now() - startTimeRef.current
        let eta = null
        if (m.done >= 50 && elapsed >= 500) eta = Math.round((m.total - m.done) / (m.done / elapsed))
        setProgress({ done: m.done, total: m.total, eta })
        if (m.topResults?.length > 0) setRanking(m.topResults)
      } else if (m.type === 'done') {
        setStatus('done')
        setProgress(p => p ? { ...p, done: p.total } : null)
        if (m.results?.length > 0) setRanking(m.results)
        worker.terminate()
      } else if (m.type === 'error') {
        setErrorMsg(m.message)
        setStatus('error')
        worker.terminate()
      }
    }
    worker.onerror = (ev) => { setErrorMsg(ev.message); setStatus('error'); worker.terminate() }
    worker.postMessage({ combos, candles, params, groupSizes: [3,4,5,6,7,8,9,10,11,12,13,14,15], samplesPerSize: 5000 })
  }

  function handleSort(key) {
    if (sortKey === key) setSortDir(d => d === 'desc' ? 'asc' : 'desc')
    else { setSortKey(key); setSortDir('desc') }
  }

  const sortedRanking = useMemo(() => {
    if (!ranking.length) return []
    return [...ranking]
      .filter(r => {
        const tc = parseInt(r.totalClosed)
        return tc >= minTrades && tc <= maxTrades
      })
      .sort((a, b) => {
        const av = parseFloat(a[sortKey] ?? 0)
        const bv = parseFloat(b[sortKey] ?? 0)
        return sortDir === 'desc' ? bv - av : av - bv
      })
  }, [ranking, sortKey, sortDir, minTrades, maxTrades])

  function fmtEta(ms) {
    if (!ms) return ''
    const s = Math.round(ms / 1000)
    return s < 60 ? `~${s}s` : `~${Math.floor(s/60)}m ${s%60}s`
  }

  function SortTh({ col, label }) {
    const active = sortKey === col
    return (
      <th onClick={() => handleSort(col)}
        style={{cursor:'pointer', userSelect:'none', color: active ? 'var(--accent)' : undefined, whiteSpace:'nowrap'}}>
        {label}{' '}{active
          ? (sortDir === 'desc' ? '▼' : '▲')
          : <span style={{opacity:0.25}}>▼</span>}
      </th>
    )
  }

  function comboLabel(c) {
    return `P${c.atrPeriod} M${c.atrMultiplier} V${c.atrVolFilter??0} R${c.rsiThreshold??0} B${c.bodyRatioMin??0} TP${c.tpPct} SL${c.slPct}`
  }

  const pct = progress ? Math.round(progress.done / progress.total * 100) : 0
  const isRunning        = status === 'running'
  const isLoadingCandles = status === 'loadingCandles'
  const canRun = candles && combos.length >= 3 && !isRunning && !isLoadingCandles

  const inputStyle = { width:'100%', background:'var(--bg)', border:'1px solid var(--border)', borderRadius:'var(--radius)', color:'var(--text)', padding:'7px 10px', fontFamily:'var(--font-mono)', fontSize:13 }

  return (
    <div className="optim-page">

      <header className="optim-page-header">
        <div className="logo">
          <span className="logo-icon">₿</span>
          <div>
            <div className="logo-title">MariaPaz<span style={{color:'var(--accent)'}}>Indicator</span></div>
            <div className="logo-sub">📗 Multi-Combo Supertrend · Desde Excel</div>
          </div>
        </div>
        <div className="optim-page-status">
          {status === 'idle' && combos.length === 0 && 'Carga un archivo Excel para comenzar'}
          {status === 'idle' && combos.length > 0 && !candles && `${combos.length} combos cargados · Carga velas para continuar`}
          {status === 'idle' && combos.length > 0 && candles && `${combos.length} combos · ${candles.length.toLocaleString()} velas · Listo`}
          {isLoadingCandles && 'Cargando velas desde BD...'}
          {isRunning && progress && (
            <span>
              {progress.done.toLocaleString()} / {progress.total.toLocaleString()} · {pct}%
              {progress.eta != null && ` · faltan ${fmtEta(progress.eta)}`}
              {' · '}{ranking.length} grupos
            </span>
          )}
          {status === 'done' && <span style={{color:'var(--green)'}}>✅ Completado · {ranking.length} grupos</span>}
          {status === 'error' && <span style={{color:'var(--red)'}}>⚠️ {errorMsg}</span>}
        </div>
      </header>

      {(isRunning || status === 'done') && progress && (
        <div className="optim-page-progress">
          <div className="progress-track" style={{borderRadius:0, height:3}}>
            <div className="progress-fill" style={{width:`${pct}%`, transition:'width 0.5s ease'}}/>
          </div>
        </div>
      )}

      <div className="optim-page-body">

        <div style={{background:'var(--bg-2)', border:'1px solid var(--border)', borderRadius:'var(--radius-lg)', padding:'20px 24px', marginBottom:20}}>
          <div style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap:24}}>

            <div style={{display:'flex', flexDirection:'column', gap:14}}>
              <div>
                <div className="optim-label" style={{marginBottom:6}}>Archivo Excel (ranking Análisis Profundo Supertrend)</div>
                <input ref={fileInputRef} type="file" accept=".xlsx,.xls" onChange={handleFile} style={{display:'none'}}/>
                <div style={{display:'flex', alignItems:'center', gap:10}}>
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    style={{...inputStyle, width:'auto', padding:'7px 14px', cursor:'pointer', background:'var(--bg-3)', fontFamily:'var(--font-ui)', fontWeight:600, fontSize:13, border:'1px solid var(--border-light)'}}>
                    📂 Seleccionar archivo
                  </button>
                  {fileName
                    ? <div style={{fontSize:12, fontFamily:'var(--font-mono)', lineHeight:1.4}}>
                        <div style={{color:'var(--green)'}}>✓ {fileName}</div>
                        <div style={{color:'var(--text-muted)'}}>{combos.length} combos válidos</div>
                      </div>
                    : <span style={{fontSize:12, color:'var(--text-muted)', fontFamily:'var(--font-mono)'}}>Sin archivo seleccionado</span>
                  }
                </div>
              </div>
              <div style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap:10}}>
                <div>
                  <div className="optim-label" style={{marginBottom:4}}>Desde</div>
                  <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} style={inputStyle}/>
                </div>
                <div>
                  <div className="optim-label" style={{marginBottom:4}}>Hasta</div>
                  <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} style={inputStyle}/>
                </div>
              </div>
              <button className="run-btn" style={{padding:'9px'}} onClick={handleLoadCandles} disabled={isLoadingCandles || isRunning}>
                {isLoadingCandles ? <><span className="spinner"/> Cargando velas...</> : '📥 Cargar velas desde BD'}
              </button>
            </div>

            <div style={{display:'flex', flexDirection:'column', gap:14}}>
              <div style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap:10}}>
                {[['Fee SL%','feeSlPct',0.01],['Fee TP%','feeTpPct',0.01],['Apalancamiento','leverage',1],['Capital inicial $','initialCapital',100]].map(([label, key, step]) => (
                  <div key={key}>
                    <div className="optim-label" style={{marginBottom:4}}>{label}</div>
                    <input type="number" step={step} value={params[key]}
                      onChange={e => setParams(p => ({...p, [key]: parseFloat(e.target.value)}))}
                      style={inputStyle}/>
                  </div>
                ))}
              </div>
              <div style={{marginTop:'auto'}}>
                {status === 'error' && (
                  <div style={{marginBottom:8, padding:'8px 12px', background:'var(--red-dim)', border:'1px solid rgba(239,68,68,0.3)', borderRadius:'var(--radius)', fontSize:12, color:'var(--red)', fontFamily:'var(--font-mono)'}}>
                    ⚠️ {errorMsg}
                  </div>
                )}
                <button className="run-btn optim-btn" style={{width:'100%', padding:11}} onClick={handleRun} disabled={!canRun}>
                  {isRunning
                    ? <><span className="spinner"/> Analizando grupos de 3–15 combos Supertrend...</>
                    : `🎲 Buscar mejores combinaciones (${combos.length} combos)`}
                </button>
                <div style={{fontSize:11, color:'var(--text-muted)', textAlign:'center', marginTop:6, fontFamily:'var(--font-mono)'}}>
                  Grupos de 3 al 15 combos · 5 000 muestras por tamaño · drawdown ≤ 50%
                </div>
              </div>
            </div>
          </div>
        </div>

        {combos.length > 0 && (
          <div style={{marginBottom:16}}>
            <button onClick={() => setShowCombos(v => !v)}
              style={{background:'none', border:'none', color:'var(--text-muted)', fontSize:12, fontFamily:'var(--font-mono)', cursor:'pointer', padding:'4px 0', display:'flex', alignItems:'center', gap:6}}>
              {showCombos ? '▼' : '▶'} Ver combos cargados ({combos.length})
            </button>
            {showCombos && (
              <div className="table-wrap" style={{marginTop:8}}>
                <table className="data-table">
                  <thead>
                    <tr><th>#</th><th>ATR Per.</th><th>Mult.</th><th>ATR Vol.</th><th>RSI</th><th>Body</th><th>TP%</th><th>SL%</th><th>Score</th></tr>
                  </thead>
                  <tbody>
                    {combos.map((c, i) => (
                      <tr key={i}>
                        <td style={{color:'var(--text-muted)'}}>{i+1}</td>
                        <td>{c.atrPeriod}</td>
                        <td>{c.atrMultiplier}</td>
                        <td>{c.atrVolFilter ?? 0}</td>
                        <td>{c.rsiThreshold ?? 0}</td>
                        <td>{c.bodyRatioMin ?? 0}</td>
                        <td>{c.tpPct}</td>
                        <td>{c.slPct}</td>
                        <td style={{color:'var(--accent)', fontWeight:600}}>{parseFloat(c._score).toFixed(1)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {ranking.length > 0 && (
          <>
            <div className="optim-rank-meta" style={{display:'flex', alignItems:'center', justifyContent:'space-between', flexWrap:'wrap', gap:10}}>
              <span>{sortedRanking.length} / {ranking.length} grupos · Score = Neto% ÷ Drawdown% · drawdown ≤ 50%{isRunning && ' · actualizando en vivo...'}</span>
              <div style={{display:'flex', alignItems:'center', gap:8, fontSize:12, fontFamily:'var(--font-mono)'}}>
                <span style={{color:'var(--text-muted)'}}>Trades:</span>
                <input type="number" min={0} value={minTrades} onChange={e => setMinTrades(Math.max(0, parseInt(e.target.value) || 0))}
                  style={{width:60, background:'var(--bg)', border:'1px solid var(--border)', borderRadius:'var(--radius)', color:'var(--text)', padding:'3px 7px', fontFamily:'var(--font-mono)', fontSize:12, textAlign:'center'}}/>
                <span style={{color:'var(--text-muted)'}}>–</span>
                <input type="number" min={0} value={maxTrades} onChange={e => setMaxTrades(Math.max(0, parseInt(e.target.value) || 9999))}
                  style={{width:60, background:'var(--bg)', border:'1px solid var(--border)', borderRadius:'var(--radius)', color:'var(--text)', padding:'3px 7px', fontFamily:'var(--font-mono)', fontSize:12, textAlign:'center'}}/>
              </div>
            </div>
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <SortTh col="_score"          label="Score"/>
                    <SortTh col="size"            label="Combos"/>
                    <th>Parámetros</th>
                    <SortTh col="totalClosed"     label="Trades"/>
                    <SortTh col="winRate"         label="Win%"/>
                    <SortTh col="totalNetPct"     label="Neto%"/>
                    <SortTh col="maxDrawdownPct"  label="Drawdown%"/>
                    <SortTh col="compoundCapital" label="Capital $"/>
                  </tr>
                </thead>
                <tbody>
                  {sortedRanking.map((r, i) => {
                    const net = parseFloat(r.totalNetPct)
                    const dd  = parseFloat(r.maxDrawdownPct)
                    const sizeColors = { 3:['var(--blue-dim)','var(--blue)'], 4:['var(--green-dim)','var(--green)'], 5:['var(--accent-dim)','var(--accent)'], 6:['var(--orange-dim)','var(--orange)'], 7:['var(--red-dim)','var(--red)'] }
                    const [bgC, fgC] = sizeColors[r.size] ?? ['var(--bg-3)','var(--text)']
                    return (
                      <tr key={i} className="row-win">
                        <td style={{color:'var(--text-muted)'}}>{i+1}</td>
                        <td style={{color:'var(--accent)', fontWeight:700}}>{r._score.toFixed(2)}</td>
                        <td style={{textAlign:'center'}}>
                          <span style={{padding:'2px 10px', borderRadius:20, fontSize:11, fontWeight:600, background:bgC, color:fgC}}>{r.size}</span>
                        </td>
                        <td style={{fontSize:10, lineHeight:1.8}}>
                          {r.combos.map((c, ci) => (
                            <div key={ci} style={{whiteSpace:'nowrap'}}>
                              <span style={{color:'var(--text-muted)', marginRight:5}}>#{c.idx+1}</span>
                              <span style={{color:'var(--text-dim)'}}>{comboLabel(c)}</span>
                            </div>
                          ))}
                        </td>
                        <td>{r.totalClosed}</td>
                        <td>{r.winRate}%</td>
                        <td className={net >= 0 ? 'tp-cell' : 'sl-cell'}>{r.totalNetPct}%</td>
                        <td className={dd > 30 ? 'sl-cell' : ''}>{r.maxDrawdownPct}%</td>
                        <td style={{fontWeight:600}}>
                          ${parseFloat(r.compoundCapital).toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2})}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

export default function App() {
  if (isEmaExcelOptimMode)          return <EmaExcelOptimView />
  if (isEmaOptimMode)               return <EmaOptimView />
  if (isSoporteOptimMode)      return <SoporteOptimView />
  if (isSoporteExcelOptimMode) return <SoporteExcelOptimView />
  if (isPinBarOptimMode)       return <PinBarOptimView />
  if (isEmaPullbackOptimMode)  return <EmaPullbackOptimView />
  if (isConfluenceOptimMode)   return <ConfluenceOptimView />
  if (isSupertrendOptimMode)      return <SupertrendOptimView />
  if (isSupertrendExcelOptimMode) return <SupertrendExcelOptimView />
  if (isSarOptimMode)             return <SarOptimView />
  if (isOptimMode)             return <OptimView />
  if (isMultiOptimMode)        return <MultiOptimView />
  if (isExcelOptimMode)        return <ExcelOptimView />
  if (isPortfolioMode)         return <RangoResistenciaPortfolioView />
  if (isEmaMode)               return <EmaView />
  if (isRangeHighMode)         return <RangeHighView />
  if (isSoporteMode)           return <SoporteView />
  if (isPinBarMode)            return <PinBarView />
  if (isEmaPullbackMode)       return <EmaPullbackView />
  if (isSupertrendMode)        return <SupertrendView />
  if (isSarMode)               return <SarView />
  if (isConfluenceMode)        return <ConfluenceView />
  return <AppMain />
}
