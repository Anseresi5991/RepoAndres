/**
 * Signal Service — DCA 3-Agent BTC/USDC System
 *
 * Agent 1: Level Detector  — runs every 15m when IDLE, returns strongest S/R level
 * Agent 2: Entry Confirmer — triggered when price reaches level, picks LONG or SHORT
 * Agent 3: DCA Evaluator   — triggered at -2% adverse from last entry, finds DCA + SL on 4H
 *
 * State persisted in SQL Server: dca_operations, dca_legs, agent_runs
 */

import Anthropic from '@anthropic-ai/sdk'
import sql from 'mssql'

// ─── Constants ─────────────────────────────────────────────────────────────────
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY   || ''
const WEBHOOK_URL       = process.env.SIGNAL_WEBHOOK_URL  || 'https://kv2snoyyoylj6532brjx36i7pu0fhgut.lambda-url.sa-east-1.on.aws/'
const WEBHOOK_SECRET    = process.env.SIGNAL_WEBHOOK_SECRET  || 'TestAndres'
const WEBHOOK_ACCOUNT   = process.env.SIGNAL_WEBHOOK_ACCOUNT || ''
const SYMBOL            = 'BTCUSDC'

const LEVERAGE          = 10
const MARGIN_PER_LEG    = 20      // USD per entry
const DCA_TRIGGER_PCT   = 2.0     // % adverse from LAST entry to trigger DCA
const DCA_CAP_PCT       = 4.0     // % max adverse from ENTRY 1 (hard cap)
const MIN_TP_PCT        = 0.5     // minimum favorable price move for TP (scalping: ≥2:1 vs structural SL)
const LEVEL_TOUCH_PCT   = 0.15    // % tolerance to consider price "at" the level
const LEVEL_EXPIRY_MS   = 4 * 60 * 60 * 1000  // 4h — discard level if never touched
const MAX_LEGS          = 3
const MIN_CONFIDENCE    = 60      // Agent 2 must score ≥ this to enter (0-100)

const CANDLES_15M_KEEP  = 250
const CANDLES_5M_KEEP   = 100
const CANDLES_1M_KEEP   = 10

const MS_1M  = 60_000
const MS_5M  = 300_000
const MS_15M = 900_000

// ─── DB connection ─────────────────────────────────────────────────────────────
let _pool = null
async function getPool() {
  if (!_pool) _pool = await sql.connect({
    server: 'localhost', database: 'BotInformation',
    user: 'btcapp', password: 'btcapp123!',
    options: {
      instanceName: 'SQLEXPRESS', trustServerCertificate: true,
      encrypt: false, enableArithAbort: true,
      connectionTimeout: 30000, requestTimeout: 300000,
    },
  })
  return _pool
}

// ─── DB helpers ────────────────────────────────────────────────────────────────
async function dbLoadActive() {
  const p = await getPool()
  const opRes = await p.request().query(`
    SELECT TOP 1 * FROM dca_operations
    WHERE status NOT IN ('CLOSED')
    ORDER BY created_at DESC
  `)
  if (!opRes.recordset.length) return null
  const row = opRes.recordset[0]
  const legs = await p.request()
    .input('id', sql.VarChar, row.id)
    .query('SELECT * FROM dca_legs WHERE operation_id=@id ORDER BY leg_number')
  const runs = await p.request()
    .input('id', sql.VarChar, row.id)
    .query('SELECT * FROM agent_runs WHERE operation_id=@id ORDER BY run_at')
  return { ...row, legs: legs.recordset, agentRuns: runs.recordset }
}

async function dbCreate(id, supportPrice, resistancePrice) {
  const p = await getPool()
  await p.request()
    .input('id', sql.VarChar,        id)
    .input('sp', sql.Decimal(18, 2), supportPrice)
    .input('rp', sql.Decimal(18, 2), resistancePrice)
    .query(`INSERT INTO dca_operations (id, status, support_price, resistance_price)
            VALUES (@id, 'WATCHING_LEVEL', @sp, @rp)`)
}

async function dbUpdate(id, updates) {
  if (!id) return
  const p   = await getPool()
  const req = p.request().input('id', sql.VarChar, id)
  const sets = []
  const add  = (key, type, val, col) => { req.input(key, type, val); sets.push(`${col}=@${key}`) }
  if (updates.status           != null) add('st',  sql.VarChar,        updates.status,            'status')
  if (updates.direction        != null) add('dir', sql.VarChar,        updates.direction,         'direction')
  if (updates.level_price      != null) add('lp',  sql.Decimal(18, 2), updates.level_price,       'level_price')
  if (updates.level_type       != null) add('lt',  sql.VarChar,        updates.level_type,        'level_type')
  if (updates.current_tp       != null) add('ctp', sql.Decimal(18, 2), updates.current_tp,        'current_tp')
  if (updates.current_sl       != null) add('csl', sql.Decimal(18, 2), updates.current_sl,        'current_sl')
  if (updates.p_avg            != null) add('pav', sql.Decimal(18, 2), updates.p_avg,             'p_avg')
  if (updates.close_reason     != null) add('cr',   sql.VarChar,        updates.close_reason,       'close_reason')
  if (updates.closed_at        != null) add('cat',  sql.DateTime2,      new Date(updates.closed_at), 'closed_at')
  if (updates.close_price      != null) add('cp',   sql.Decimal(18, 2), updates.close_price,         'close_price')
  if (updates.realized_pnl_usd != null) add('rpnl', sql.Decimal(18, 8), updates.realized_pnl_usd,    'realized_pnl_usd')
  if (sets.length) await req.query(`UPDATE dca_operations SET ${sets.join(',')} WHERE id=@id`)
}

async function dbAddLeg(opId, legNumber, price) {
  const p = await getPool()
  await p.request()
    .input('oid', sql.VarChar,        opId)
    .input('ln',  sql.Int,            legNumber)
    .input('pr',  sql.Decimal(18, 2), price)
    .input('mg',  sql.Decimal(10, 2), MARGIN_PER_LEG)
    .query(`INSERT INTO dca_legs (operation_id, leg_number, entry_price, margin)
            VALUES (@oid, @ln, @pr, @mg)`)
}

async function dbAddRun(opId, agentNumber, timeframeUsed, output) {
  const p = await getPool()
  await p.request()
    .input('oid', sql.VarChar,             opId)
    .input('an',  sql.Int,                 agentNumber)
    .input('tf',  sql.VarChar,             timeframeUsed ?? null)
    .input('out', sql.NVarChar(sql.MAX),   JSON.stringify(output))
    .input('rsn', sql.NVarChar(sql.MAX),   output.reasoning ?? null)
    .query(`INSERT INTO agent_runs (operation_id, agent_number, timeframe_used, output, reasoning)
            VALUES (@oid, @an, @tf, @out, @rsn)`)
}

// ─── Account config cache ──────────────────────────────────────────────────────
let accountConfig = { capitalPerLeg: MARGIN_PER_LEG, minTpPct: MIN_TP_PCT, totalCapital: null }

async function loadAccountConfig() {
  try {
    const p   = await getPool()
    const res = await p.request().query('SELECT * FROM account_config WHERE id = 1')
    if (res.recordset.length) {
      const r = res.recordset[0]
      accountConfig.capitalPerLeg  = +r.capital_per_leg
      accountConfig.minTpPct       = +r.min_tp_pct
      accountConfig.totalCapital   = +r.total_capital
    }
  } catch (e) { console.warn('[dca] account_config not loaded:', e.message) }
}

// ─── In-memory state ───────────────────────────────────────────────────────────
const EMPTY_STATE = () => ({
  operationId:     null,
  status:          'IDLE',  // IDLE | WATCHING_LEVEL | OPEN_1LEG | OPEN_2LEGS | OPEN_3LEGS | CLOSED
  direction:       null,    // LONG | SHORT
  supportPrice:    null,    // nearest support BELOW price (Agent 1)
  resistancePrice: null,    // nearest resistance ABOVE price (Agent 1)
  levelPrice:      null,    // whichever of the two was actually touched
  levelType:       null,    // 'support' | 'resistance' — which one triggered
  levelSetAt:      null,
  currentTp:       null,
  currentSl:       null,
  pAvg:            null,
  legs:            [],      // [{ legNumber, price, margin }]
  agent1:          null,
  agent2:          null,
  agent3Calls:     [],
})

let TRADING_PAUSED = true   // ← set false to re-enable live trading

let state      = EMPTY_STATE()
let candles5m  = []
let candles15m = []
let candles1m  = []

export const serviceStatus = {
  running:       false,
  lastUpdate15m: null,
  lastUpdate5m:  null,
  lastAgent1:    null,
  error:         null,
}

function generateId() { return `DCA_${Date.now()}` }

// ─── Indicator utilities ───────────────────────────────────────────────────────
function calcEMA(values, period) {
  if (values.length < period) return NaN
  const k = 2 / (period + 1)
  let e = values.slice(0, period).reduce((a, b) => a + b, 0) / period
  for (let i = period; i < values.length; i++) e = values[i] * k + e * (1 - k)
  return e
}

function calcRSI(values, period) {
  if (values.length < period + 1) return NaN
  let ag = 0, al = 0
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1]
    if (d > 0) ag += d; else al -= d
  }
  ag /= period; al /= period
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1]
    ag = (ag * (period - 1) + (d > 0 ? d : 0)) / period
    al = (al * (period - 1) + (d < 0 ? -d : 0)) / period
  }
  return al === 0 ? 100 : 100 - 100 / (1 + ag / al)
}

function calcATR(candles, period) {
  if (candles.length < period + 1) return NaN
  const trs = candles.map((c, i) => {
    const h = +c.HighCandle, l = +c.LowCandle
    if (i === 0) return h - l
    const pc = +candles[i - 1].CloseCandle
    return Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc))
  })
  let a = trs.slice(0, period).reduce((x, y) => x + y, 0) / period
  for (let i = period; i < trs.length; i++) a = (a * (period - 1) + trs[i]) / period
  return a
}

function calcSMA(values, period) {
  if (values.length < period) return NaN
  return values.slice(-period).reduce((a, b) => a + b, 0) / period
}

function calcEMAArray(values, period) {
  if (values.length < period) return []
  const k = 2 / (period + 1)
  let e = values.slice(0, period).reduce((a, b) => a + b, 0) / period
  const result = new Array(period - 1).fill(NaN)
  result.push(e)
  for (let i = period; i < values.length; i++) { e = values[i] * k + e * (1 - k); result.push(e) }
  return result
}

function calcMACD(values, fast = 12, slow = 26, sig = 9) {
  if (values.length < slow + sig) return { macd: NaN, signal: NaN, hist: NaN }
  const emaF = calcEMAArray(values, fast)
  const emaS = calcEMAArray(values, slow)
  const macdLine = []
  for (let i = slow - 1; i < values.length; i++) macdLine.push(emaF[i] - emaS[i])
  if (macdLine.length < sig) return { macd: NaN, signal: NaN, hist: NaN }
  const sigVal  = calcEMA(macdLine, sig)
  const macdVal = macdLine.at(-1)
  return { macd: +macdVal.toFixed(2), signal: +sigVal.toFixed(2), hist: +(macdVal - sigVal).toFixed(2) }
}

function calcADX(candles, period = 14) {
  if (candles.length < period * 2 + 1) return { adx: NaN, pdi: NaN, ndi: NaN }
  const trs = [], pdms = [], ndms = []
  for (let i = 1; i < candles.length; i++) {
    const h = +candles[i].HighCandle, l = +candles[i].LowCandle
    const ph = +candles[i-1].HighCandle, pl = +candles[i-1].LowCandle, pc = +candles[i-1].CloseCandle
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)))
    const up = h - ph, dn = pl - l
    pdms.push(up > dn && up > 0 ? up : 0)
    ndms.push(dn > up && dn > 0 ? dn : 0)
  }
  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0)
  let pdm = pdms.slice(0, period).reduce((a, b) => a + b, 0)
  let ndm = ndms.slice(0, period).reduce((a, b) => a + b, 0)
  const dxArr = []
  const pushDX = () => {
    const pdi = atr > 0 ? pdm / atr * 100 : 0
    const ndi = atr > 0 ? ndm / atr * 100 : 0
    const s = pdi + ndi; dxArr.push({ dx: s > 0 ? Math.abs(pdi - ndi) / s * 100 : 0, pdi, ndi })
  }
  pushDX()
  for (let i = period; i < trs.length; i++) {
    atr = atr - atr / period + trs[i]
    pdm = pdm - pdm / period + pdms[i]
    ndm = ndm - ndm / period + ndms[i]
    pushDX()
  }
  if (dxArr.length < period) return { adx: NaN, pdi: NaN, ndi: NaN }
  const adx = calcEMA(dxArr.map(d => d.dx), period)
  const last = dxArr.at(-1)
  return { adx: +adx.toFixed(1), pdi: +last.pdi.toFixed(1), ndi: +last.ndi.toFixed(1) }
}

function calcBB(values, period = 20, mult = 2) {
  if (values.length < period) return { upper: NaN, middle: NaN, lower: NaN }
  const slice = values.slice(-period)
  const mid   = slice.reduce((a, b) => a + b, 0) / period
  const std   = Math.sqrt(slice.reduce((s, v) => s + (v - mid) ** 2, 0) / period)
  return { upper: +(mid + mult * std).toFixed(2), middle: +mid.toFixed(2), lower: +(mid - mult * std).toFixed(2) }
}

// ─── Binance API ───────────────────────────────────────────────────────────────
async function fetchBinanceCandles(interval, limit) {
  const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${SYMBOL}&interval=${interval}&limit=${limit}`
  const r = await fetch(url)
  if (!r.ok) throw new Error(`Binance ${interval}: HTTP ${r.status}`)
  return (await r.json()).map(k => ({
    OpenTime:    new Date(+k[0]).toISOString(),
    CloseTime:   new Date(+k[6]).toISOString(),
    OpenCandle:  k[1], HighCandle: k[2], LowCandle: k[3],
    CloseCandle: k[4], Volume:     k[5],
  }))
}

function mergeAndTrim(existing, incoming, maxLen) {
  const map = new Map(existing.map(c => [c.OpenTime, c]))
  for (const c of incoming) map.set(c.OpenTime, c)
  return [...map.values()].sort((a, b) => a.OpenTime < b.OpenTime ? -1 : 1).slice(-maxLen)
}

const fmtC = c =>
  `${(+c.OpenCandle).toFixed(0)} ${(+c.HighCandle).toFixed(0)} ${(+c.LowCandle).toFixed(0)} ${(+c.CloseCandle).toFixed(0)} ${(+c.Volume).toFixed(1)}`

const n = v => isNaN(v) ? 'N/A' : +v.toFixed(2)

// ─── Anthropic ─────────────────────────────────────────────────────────────────
const anthropic = ANTHROPIC_API_KEY ? new Anthropic({ apiKey: ANTHROPIC_API_KEY }) : null

async function callClaude(system, prompt, maxTokens = 500) {
  const msg = await anthropic.messages.create({
    model: 'claude-sonnet-4-6', max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: prompt }],
  })
  const raw = msg.content[0].text.trim()
  try { return JSON.parse(raw) }
  catch { return JSON.parse(raw.replace(/^```[a-z]*\n?/, '').replace(/\n?```$/, '').trim()) }
}

// ─── Agent 1: Level Detector ───────────────────────────────────────────────────
async function runAgent1() {
  const [c15, c1h, c4h] = await Promise.all([
    fetchBinanceCandles('15m', 96),   // 24h
    fetchBinanceCandles('1h',  48),   // 2 days
    fetchBinanceCandles('4h',  60),   // 10 days
  ])
  const cl15  = c15.map(c => +c.CloseCandle)
  const cl1h  = c1h.map(c => +c.CloseCandle)
  const cl4h  = c4h.map(c => +c.CloseCandle)
  const price = cl15.at(-1)
  const bb1h  = calcBB(cl1h, 20)

  const prompt =
`BTC/USDC Dual Level Detection — ${new Date().toISOString()}
Current Price: ${price.toFixed(2)} USDC

=== 15m — last 96 candles (24h) | Open High Low Close Vol ===
EMAs: 50=${n(calcEMA(cl15,50))} | 100=${n(calcEMA(cl15,100))} | 200=${n(calcEMA(cl15,200))} | ATR14=${n(calcATR(c15,14))}
${c15.map(fmtC).join('\n')}

=== 1H — last 48 candles (2 days) | Open High Low Close Vol ===
EMAs: 50=${n(calcEMA(cl1h,50))} | 200=${n(calcEMA(cl1h,200))} | BB(20,2): U=${bb1h.upper} M=${bb1h.middle} L=${bb1h.lower}
${c1h.map(fmtC).join('\n')}

=== 4H — last 60 candles (10 days) | Open High Low Close Vol ===
EMAs: 50=${n(calcEMA(cl4h,50))} | 200=${n(calcEMA(cl4h,200))}
${c4h.map(fmtC).join('\n')}

TASK: Identify TWO levels near current price (within 5%):
  1. The strongest SUPPORT level STRICTLY BELOW current price (${price.toFixed(2)})
  2. The strongest RESISTANCE level STRICTLY ABOVE current price (${price.toFixed(2)})

For EACH level independently, follow this priority:
  - Use 15m structure first (swing high/low with multiple touches or strong volume reaction)
  - Use 1H only if 15m has no clear level in that direction
  - Use 4H only if 1H also lacks a clear level

A strong level has: multiple price touches, high volume at reaction points, clean structure (not mid-range noise).
Support must be < ${price.toFixed(2)}. Resistance must be > ${price.toFixed(2)}.

Respond ONLY with this JSON (no markdown):
{"supportPrice":number,"supportTimeframe":"15m|1H|4H","resistancePrice":number,"resistanceTimeframe":"15m|1H|4H","reasoning":"2-3 sentences explaining both levels and why they are significant"}`

  const result = await callClaude(
    'You are a BTC market structure analyst. Find the strongest support below and resistance above current price. Respond ONLY with valid JSON.',
    prompt, 500,
  )
  return { ...result, detectedAt: new Date().toISOString(), priceAtDetection: price }
}

// ─── Agent 2: Entry Confirmer ──────────────────────────────────────────────────
async function runAgent2(agent1, currentPrice, levelType = 'unknown') {
  const [c5, c15, c1h] = await Promise.all([
    fetchBinanceCandles('5m',  30),  // 2.5h
    fetchBinanceCandles('15m', 40),  // 10h
    fetchBinanceCandles('1h',  24),  // 24h — trend filter
  ])
  const cl5  = c5.map(c  => +c.CloseCandle)
  const cl15 = c15.map(c => +c.CloseCandle)
  const cl1h = c1h.map(c => +c.CloseCandle)

  // Volume ratio on last complete 5m bar (exclude current forming bar)
  const vol5 = c5.slice(0, -1).map(c => +c.Volume)
  const volR = vol5.length >= 20 ? (vol5.at(-1) / calcSMA(vol5, 20)).toFixed(2) : 'N/A'

  const adx15  = calcADX(c15, 14)
  const adx1h  = calcADX(c1h, 14)
  const macd5  = calcMACD(cl5)
  const rsi1h  = calcRSI(cl1h, 14)
  const ema21_1h = calcEMA(cl1h, 21)
  const ema50_1h = calcEMA(cl1h, 50)

  // Morphology of the touching candle (last completed 5m bar)
  const tc      = c5.at(-2) ?? c5.at(-1)  // -2 = last closed bar, -1 if only one bar
  const tcO = +tc.OpenCandle, tcH = +tc.HighCandle, tcL = +tc.LowCandle, tcC = +tc.CloseCandle
  const tcRange = tcH - tcL
  const tcBody  = Math.abs(tcC - tcO)
  const tcBodyPct  = tcRange > 0 ? +(tcBody  / tcRange * 100).toFixed(1) : 0
  const tcLowWick  = tcRange > 0 ? +((Math.min(tcO, tcC) - tcL) / tcRange * 100).toFixed(1) : 0
  const tcHighWick = tcRange > 0 ? +((tcH - Math.max(tcO, tcC)) / tcRange * 100).toFixed(1) : 0
  const tcBull = tcC >= tcO

  const minTpLong  = +(currentPrice * (1 + MIN_TP_PCT / 100)).toFixed(2)
  const minTpShort = +(currentPrice * (1 - MIN_TP_PCT / 100)).toFixed(2)

  const trendBias1h = currentPrice > ema21_1h ? 'BULLISH' : 'BEARISH'
  const trendStr1h  = adx1h.adx > 25 ? 'STRONG' : adx1h.adx > 18 ? 'MODERATE' : 'WEAK'

  const prompt =
`BTC/USDC Entry Confirmation — ${new Date().toISOString()}
Current Price: ${currentPrice.toFixed(2)} | Level touched: ${levelType.toUpperCase()}
${levelType === 'support'    ? `Arrived at SUPPORT ${agent1.supportPrice} from above`  : ''}
${levelType === 'resistance' ? `Arrived at RESISTANCE ${agent1.resistancePrice} from below` : ''}

=== AGENT 1 CONTEXT ===
Support: ${agent1.supportPrice} (${agent1.supportTimeframe}) | Resistance: ${agent1.resistancePrice} (${agent1.resistanceTimeframe})
${agent1.reasoning}

=== 1H TREND FILTER — last 24 candles ===
EMA21=${n(ema21_1h)} | EMA50=${n(ema50_1h)} | RSI14=${n(rsi1h)}
ADX=${n(adx1h.adx)} +DI=${n(adx1h.pdi)} -DI=${n(adx1h.ndi)} → Trend: ${trendStr1h} ${trendBias1h}
Price vs EMA21: ${currentPrice > ema21_1h ? 'ABOVE (bullish context)' : 'BELOW (bearish context)'}

=== TOUCHING CANDLE MORPHOLOGY (last closed 5m bar) ===
O=${tcO.toFixed(2)} H=${tcH.toFixed(2)} L=${tcL.toFixed(2)} C=${tcC.toFixed(2)} | ${tcBull ? 'BULLISH' : 'BEARISH'}
Body=${tcBodyPct}% of range | Lower wick=${tcLowWick}% | Upper wick=${tcHighWick}%
${levelType === 'support'    ? `Rejection signal: lower wick ≥ 40% = strong, body < 30% = pin bar` : ''}
${levelType === 'resistance' ? `Rejection signal: upper wick ≥ 40% = strong, body < 30% = pin bar` : ''}

=== 5m — last 30 candles (2.5h) | Open High Low Close Vol ===
EMAs: 9=${n(calcEMA(cl5,9))} | 21=${n(calcEMA(cl5,21))} | 50=${n(calcEMA(cl5,50))}
RSI14=${n(calcRSI(cl5,14))} | Vol/SMA20=${volR}x
MACD(12,26,9): line=${n(macd5.macd)} signal=${n(macd5.signal)} hist=${n(macd5.hist)}
${c5.map(fmtC).join('\n')}

=== 15m — last 40 candles (10h) | Open High Low Close Vol ===
EMAs: 9=${n(calcEMA(cl15,9))} | 21=${n(calcEMA(cl15,21))} | 50=${n(calcEMA(cl15,50))}
RSI14=${n(calcRSI(cl15,14))} | ADX=${n(adx15.adx)} +DI=${n(adx15.pdi)} -DI=${n(adx15.ndi)}
${c15.map(fmtC).join('\n')}

TASK: Decide whether to enter, and in which direction.

━━ STEP 1 — CLASSIFY THE PLAY TYPE ━━
Look at the touching candle morphology to classify FIRST:

  BOUNCE (preferred play — higher probability):
    At support → price rejected upward: lower wick ≥ 35%, bearish body < 40%, price still inside the level zone
    At resistance → price rejected downward: upper wick ≥ 35%, bullish body < 40%
    Direction: LONG at support, SHORT at resistance (with the level, against the short-term momentum)
    Min confidence to trade: ${MIN_CONFIDENCE}%

  BREAKOUT (higher risk — stricter criteria required):
    At support breaking DOWN: bearish body > 55% AND vol > 1.5× SMA20 AND 5m EMAs stacked bearish
    At resistance breaking UP: bullish body > 55% AND vol > 1.5× SMA20 AND 5m EMAs stacked bullish
    Direction: SHORT through support, LONG through resistance
    If ANY of the 3 breakout criteria is missing → it is likely a FALSE BREAKOUT → classify as BOUNCE or NO_TRADE
    Min confidence to trade: 72% (false breakouts are the #1 cause of loss in scalping)

━━ STEP 2 — 1H TREND FILTER ━━
  BOUNCE with 1H trend (e.g. LONG at support, 1H bullish): +2 points — ideal setup
  BOUNCE against 1H trend (e.g. LONG at support, 1H bearish): 0 points — acceptable only with extreme RSI + perfect wick
  BREAKOUT with 1H trend: +1 point
  BREAKOUT against 1H trend: −2 points → very likely NO_TRADE

━━ STEP 3 — SCORE 8 signals (1 point each, for the chosen direction) ━━
  1. 1H EMA21 and EMA50 aligned with direction
  2. 15m EMAs aligned (9 > 21 > 50 bullish, or inverse bearish)
  3. 5m EMAs aligned with direction
  4. RSI 5m: < 45 for LONG, > 55 for SHORT
  5. MACD 5m histogram in direction (positive for LONG, negative for SHORT)
  6. Volume > 1.2× SMA20 on touching candle (1.5× required for breakout)
  7. Touching candle morphology matches play type (wick for bounce, body for breakout)
  8. ADX 15m: > 18 with +DI > -DI for LONG, -DI > +DI for SHORT

━━ STEP 4 — CONFIDENCE ━━
  BOUNCE: confidence = 50 + trend_bonus + (signal_points × 6.25), clamp [0,100]
  BREAKOUT: confidence = 40 + trend_bonus + (signal_points × 6.25), clamp [0,100]  ← harder base
  If confidence < required minimum → direction = "NO_TRADE"

━━ STEP 5 — LEVELS ━━
  tpPrice: next clear S/R in trade direction | LONG ≥ ${minTpLong} | SHORT ≤ ${minTpShort}
  slPrice (structural, tight):
    BOUNCE LONG at support → 0.15-0.25% below ${levelType === 'support' ? agent1.supportPrice : agent1.resistancePrice}
    BOUNCE SHORT at resistance → 0.15-0.25% above the level
    BREAKOUT LONG → below the broken resistance (now support)
    BREAKOUT SHORT → above the broken support (now resistance)

Respond ONLY with this JSON (no markdown):
{"direction":"LONG|SHORT|NO_TRADE","playType":"BOUNCE|BREAKOUT|null","tpPrice":number|null,"slPrice":number,"confidence":number,"reasoning":"2-3 sentences: play type identified, key signals that decided, and why confidence is this level"}`

  const result = await callClaude(
    'You are a senior BTC scalper specializing in level-based entries. Bounces at strong levels are your primary setup. Breakouts require very strict confirmation — an unconfirmed breakout is just a bounce candidate gone wrong. NO_TRADE is always valid. Respond ONLY with valid JSON.',
    prompt, 600,
  )
  return { ...result, decidedAt: new Date().toISOString(), priceAtDecision: currentPrice }
}

// ─── Agent 3: DCA Evaluator ────────────────────────────────────────────────────
async function runAgent3(agent1, agent2, posState) {
  const c4h  = await fetchBinanceCandles('4h', 60)
  const cl4h = c4h.map(c => +c.CloseCandle)
  const atr4h = calcATR(c4h, 14)

  const capPrice = posState.direction === 'SHORT'
    ? +(posState.entry1 * (1 + DCA_CAP_PCT / 100)).toFixed(2)
    : +(posState.entry1 * (1 - DCA_CAP_PCT / 100)).toFixed(2)

  const dcaSearch = posState.direction === 'SHORT' ? 'resistance above' : 'support below'
  const slSide    = posState.direction === 'SHORT' ? 'above'            : 'below'

  const prompt =
`BTC/USDC DCA Evaluation — ${new Date().toISOString()}
Position: ${posState.direction} | Legs: ${posState.legCount}/${MAX_LEGS} | Current price: ${posState.currentPrice.toFixed(2)}
Entry1=${posState.entry1.toFixed(2)} | LastEntry=${posState.lastEntry.toFixed(2)} | PAvg=${posState.pAvg.toFixed(2)}
DCA hard cap: ${capPrice} (${DCA_CAP_PCT}% from entry1) | ATR(4H)=${n(atr4h)}
Adverse move from entry1: ${Math.abs((posState.currentPrice - posState.entry1) / posState.entry1 * 100).toFixed(2)}%

=== AGENT 1 CONTEXT ===
Support: ${agent1.supportPrice} (${agent1.supportTimeframe}) | Resistance: ${agent1.resistancePrice} (${agent1.resistanceTimeframe})
${agent1.reasoning}

=== AGENT 2 CONTEXT ===
Direction: ${agent2.direction} | TP: ${agent2.tpPrice}
${agent2.reasoning}

=== 4H — last 60 candles (10 days) | Open High Low Close Vol ===
EMAs: 50=${n(calcEMA(cl4h,50))} | 100=${n(calcEMA(cl4h,100))} | 200=${n(calcEMA(cl4h,200))}
${c4h.map(fmtC).join('\n')}

TASK:
1. DCA price: Find the next clear ${dcaSearch} current price on the 4H chart.
   Must be a level with prior price reactions — not mid-air.
   If that level is beyond the hard cap (${capPrice}) → use ${capPrice} as dcaPrice.

2. SL price: Find the next structural level ${slSide} the DCA level (on 4H) and add ATR×0.5 buffer.
   SL must be more adverse than the cap (${capPrice}).

Respond ONLY with this JSON (no markdown):
{"dcaPrice":number,"slPrice":number,"reasoning":"2-3 sentences: DCA level rationale and SL placement logic"}`

  const result = await callClaude(
    'You are a BTC risk manager. Find the optimal DCA entry and structural SL on the 4H chart. Respond ONLY with valid JSON.',
    prompt, 450,
  )

  // Enforce hard cap
  let dcaPrice = result.dcaPrice
  if (posState.direction === 'SHORT' && dcaPrice > capPrice) dcaPrice = capPrice
  if (posState.direction === 'LONG'  && dcaPrice < capPrice) dcaPrice = capPrice

  return {
    dcaPrice:  +dcaPrice.toFixed(2),
    slPrice:   +result.slPrice.toFixed(2),
    reasoning: result.reasoning,
    calledAt:  new Date().toISOString(),
  }
}

// ─── Weighted average entry price ──────────────────────────────────────────────
function calcPAvg(legs) {
  const notional = MARGIN_PER_LEG * LEVERAGE
  const totalN   = legs.length * notional
  const totalC   = legs.reduce((s, l) => s + notional / l.price, 0)
  return totalN / totalC
}

// ─── Lambda webhooks ───────────────────────────────────────────────────────────
async function webhookOpen(direction, tpPct, slPct, addToPosition = false) {
  const body = JSON.stringify({
    secret:  WEBHOOK_SECRET,
    account: WEBHOOK_ACCOUNT,
    tipo:    direction === 'LONG' ? 'S' : 'R',
    tp:      +tpPct.toFixed(4),
    sl:      +slPct.toFixed(4),
    ...(addToPosition ? { action: 'ADD_TO_POSITION' } : {}),
  })
  const r    = await fetch(WEBHOOK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })
  const json = await r.json().catch(() => null)
  if (!r.ok) { console.error('[dca] webhookOpen error:', r.status, json); return { ok: false, data: null } }
  return { ok: true, data: json }
}

// Updates TP and optionally SL on the open position via Lambda MOVE_SL action
async function webhookUpdateTP(direction, newTpPrice, newSlPrice) {
  const body = JSON.stringify({
    secret:       WEBHOOK_SECRET,
    account:      WEBHOOK_ACCOUNT,
    action:       'MOVE_SL',
    symbol:       SYMBOL,
    positionSide: direction,
    newSlPrice:   newSlPrice ?? null,
    tpPrice:      newTpPrice,
  })
  const r    = await fetch(WEBHOOK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })
  const json = await r.json().catch(() => null)
  if (!r.ok) { console.error('[dca] webhookUpdateTP error:', r.status, json); return false }
  console.log(`[dca] TP → ${newTpPrice}${newSlPrice ? ` | SL → ${newSlPrice}` : ''}`)
  return true
}

// ─── Price helpers ─────────────────────────────────────────────────────────────
function currentPrice() {
  return candles1m.length  > 0 ? +candles1m.at(-1).CloseCandle
       : candles5m.length  > 0 ? +candles5m.at(-1).CloseCandle
       : null
}

function isTouching(price, level) {
  return Math.abs(price - level) / level * 100 <= LEVEL_TOUCH_PCT
}

function isAdverse(price, direction, fromPrice, pct) {
  const move = direction === 'SHORT'
    ? (price - fromPrice) / fromPrice * 100
    : (fromPrice - price) / fromPrice * 100
  return move >= pct
}

// ─── State machine handlers ────────────────────────────────────────────────────
async function handleWatchingLevel(price) {
  if (TRADING_PAUSED) return
  // Expire stale levels first
  if (Date.now() - new Date(state.levelSetAt).getTime() > LEVEL_EXPIRY_MS) {
    console.log('[dca] Levels expired — resetting to IDLE and searching new levels immediately')
    await dbUpdate(state.operationId, { status: 'CLOSED', close_reason: 'EXPIRED', closed_at: new Date().toISOString() })
    state = EMPTY_STATE()
    await agent1Cycle()
    return
  }

  const atSupport    = state.supportPrice    != null && isTouching(price, state.supportPrice)
  const atResistance = state.resistancePrice != null && isTouching(price, state.resistancePrice)
  if (!atSupport && !atResistance) return

  // If both in range simultaneously, use the closer one
  let touchedLevel, levelType
  if (atSupport && atResistance) {
    const dS = Math.abs(price - state.supportPrice)
    const dR = Math.abs(price - state.resistancePrice)
    touchedLevel = dS <= dR ? state.supportPrice    : state.resistancePrice
    levelType    = dS <= dR ? 'support'             : 'resistance'
  } else if (atSupport) {
    touchedLevel = state.supportPrice;    levelType = 'support'
  } else {
    touchedLevel = state.resistancePrice; levelType = 'resistance'
  }

  state.levelPrice = touchedLevel
  state.levelType  = levelType
  await dbUpdate(state.operationId, { level_price: touchedLevel, level_type: levelType })

  console.log(`[dca] Price ${price.toFixed(2)} touched ${levelType} @ ${touchedLevel} — calling Agent 2`)
  try {
    const agent2 = await runAgent2(state.agent1, price, levelType)
    state.agent2 = agent2
    await dbAddRun(state.operationId, 2, null, agent2)

    const confidence = agent2.confidence ?? 100
    if (agent2.direction === 'NO_TRADE' || confidence < MIN_CONFIDENCE) {
      console.log(`[dca] Agent 2 → NO_TRADE (confidence=${confidence}%) — level skipped. Reason: ${agent2.reasoning}`)
      return
    }

    // Initial TP% from current price to Agent 2 target
    const tpPct = agent2.direction === 'LONG'
      ? (agent2.tpPrice - price) / price * 100
      : (price - agent2.tpPrice) / price * 100

    // Structural SL from Agent 2 (just beyond the level) used as the actual exchange stop
    const slPct = agent2.slPrice
      ? Math.abs(price - agent2.slPrice) / price * 100
      : 0.5

    const wh = await webhookOpen(agent2.direction, tpPct, slPct)
    if (!wh.ok) { console.error('[sc] Failed to open position'); return }

    const entryPrice = wh.data?.entryPrice ?? price

    state.direction = agent2.direction
    state.currentTp = agent2.tpPrice
    state.currentSl = agent2.slPrice ?? null
    state.legs      = [{ legNumber: 1, price: entryPrice, margin: MARGIN_PER_LEG }]
    state.pAvg      = entryPrice
    state.status    = 'OPEN_1LEG'

    await dbUpdate(state.operationId, {
      status:     'OPEN_1LEG',
      direction:  agent2.direction,
      current_tp: agent2.tpPrice,
      current_sl: agent2.slPrice ?? null,
      p_avg:      entryPrice,
    })
    await dbAddLeg(state.operationId, 1, entryPrice)

    console.log(`[sc] ✅ ${agent2.direction} ${agent2.playType ?? ''} @ ${entryPrice} | TP=${agent2.tpPrice} | SL=${agent2.slPrice} | conf=${agent2.confidence}%`)
  } catch (err) {
    console.error('[dca] Agent 2 error:', err.message)
    serviceStatus.error = err.message
  }
}

async function handleOpenPosition(price) {
  if (TRADING_PAUSED) return
  const { direction, currentTp, currentSl } = state
  const last1m = candles1m.at(-1)
  const high   = last1m ? +last1m.HighCandle : price
  const low    = last1m ? +last1m.LowCandle  : price

  // Check SL first (wick-based to catch mecha touches)
  if (currentSl != null) {
    const slHit = direction === 'LONG' ? low <= currentSl : high >= currentSl
    if (slHit) { await closeOperation('SL'); return }
  }

  // Check TP (wick-based)
  const tpHit = direction === 'LONG' ? high >= currentTp : low <= currentTp
  if (tpHit) { await closeOperation('TP'); return }
}

async function closeOperation(reason) {
  console.log(`[dca] Operation ${state.operationId} closed by ${reason} — Binance handles the order`)

  const closePrice = reason === 'TP' ? state.currentTp
                   : reason === 'SL' ? state.currentSl
                   : null

  const capital = state.legs.length * accountConfig.capitalPerLeg

  let pnlUsd = null, pnlPct = null
  if (closePrice && state.pAvg && state.legs.length && state.direction) {
    const move = state.direction === 'LONG'
      ? (closePrice - state.pAvg) / state.pAvg
      : (state.pAvg - closePrice) / state.pAvg
    pnlUsd = +(move * LEVERAGE * capital).toFixed(4)
    pnlPct = +(move * LEVERAGE * 100).toFixed(4)
  }

  await dbUpdate(state.operationId, {
    status:           'CLOSED',
    close_reason:     reason,
    closed_at:        new Date().toISOString(),
    close_price:      closePrice ?? undefined,
    realized_pnl_usd: pnlUsd    ?? undefined,
  })

  // Auto-insert into trade_journal
  try {
    await (await getPool()).request()
      .input('id',   sql.VarChar,        `TJ_${state.operationId}`)
      .input('opId', sql.VarChar,        state.operationId)
      .input('dir',  sql.VarChar,        state.direction ?? null)
      .input('cap',  sql.Decimal(18, 2), capital)
      .input('res',  sql.VarChar,        reason)
      .input('pct',  sql.Decimal(8, 4),  pnlPct)
      .query(`INSERT INTO trade_journal (id, source, op_id, trade_date, direction, capital_used, result, pnl_pct, strategy)
              VALUES (@id, 'AUTO', @opId, GETUTCDATE(), @dir, @cap, @res, @pct, 'dca_auto')`)
  } catch (e) { console.warn('[dca] trade_journal insert skipped:', e.message) }

  console.log(`[sc] ✅ CLOSED (${reason}) pnl=${pnlUsd != null ? `$${pnlUsd}` : 'n/a'} — scanning new levels in 10s`)
  state = EMPTY_STATE()
  // Re-scan immediately after close so the bot finds new levels without waiting up to 15m
  setTimeout(() => agent1Cycle(), 10_000)
}

// ─── Monitor tick (1m) ─────────────────────────────────────────────────────────
async function monitorTick() {
  const price = currentPrice()
  if (!price) return
  try {
    if      (state.status === 'WATCHING_LEVEL') await handleWatchingLevel(price)
    else if (state.status === 'OPEN_1LEG')      await handleOpenPosition(price)
  } catch (err) {
    console.error('[sc] Monitor tick error:', err.message)
    serviceStatus.error = err.message
  }
}

// ─── Agent 1 cycle (15m when IDLE) ────────────────────────────────────────────
async function agent1Cycle() {
  if (TRADING_PAUSED) return
  if (state.status !== 'IDLE') return
  try {
    console.log('[dca] Running Agent 1 (level detection)...')
    serviceStatus.lastAgent1 = new Date().toISOString()
    serviceStatus.error = null

    const agent1 = await runAgent1()
    console.log(`[dca] Agent 1 → support=${agent1.supportPrice}(${agent1.supportTimeframe}) resistance=${agent1.resistancePrice}(${agent1.resistanceTimeframe})`)

    const opId = generateId()
    await dbCreate(opId, agent1.supportPrice, agent1.resistancePrice)
    await dbAddRun(opId, 1, `${agent1.supportTimeframe}/${agent1.resistanceTimeframe}`, agent1)

    state.operationId     = opId
    state.agent1          = agent1
    state.supportPrice    = agent1.supportPrice
    state.resistancePrice = agent1.resistancePrice
    state.levelSetAt      = new Date().toISOString()
    state.status          = 'WATCHING_LEVEL'
  } catch (err) {
    console.error('[dca] Agent 1 error:', err.message)
    serviceStatus.error = err.message
  }
}

// ─── Startup recovery from DB ──────────────────────────────────────────────────
async function recoverFromDB() {
  try {
    const saved = await dbLoadActive()
    if (!saved) {
      console.log('[dca] No active operation in DB — starting fresh')
      return
    }

    console.log(`[dca] Recovering operation ${saved.id} (status: ${saved.status})`)

    const runs = saved.agentRuns ?? []
    const ag1  = runs.find(r => r.agent_number === 1)
    const ag2  = runs.find(r => r.agent_number === 2)
    const ag3s = runs.filter(r => r.agent_number === 3)

    state.operationId     = saved.id
    state.status          = saved.status
    state.direction       = saved.direction       ?? null
    state.supportPrice    = saved.support_price    ? +saved.support_price    : null
    state.resistancePrice = saved.resistance_price ? +saved.resistance_price : null
    state.levelPrice      = saved.level_price      ? +saved.level_price      : null
    state.levelType       = saved.level_type       ?? null
    state.levelSetAt      = saved.created_at?.toISOString?.() ?? new Date().toISOString()
    state.currentTp       = saved.current_tp       ? +saved.current_tp       : null
    state.currentSl       = saved.current_sl       ? +saved.current_sl       : null
    state.pAvg            = saved.p_avg            ? +saved.p_avg            : null
    state.legs        = (saved.legs ?? []).map(l => ({
      legNumber: l.leg_number,
      price:     +l.entry_price,
      margin:    +l.margin,
    }))
    state.agent1      = ag1  ? JSON.parse(ag1.output)  : null
    state.agent2      = ag2  ? JSON.parse(ag2.output)  : null
    state.agent3Calls = ag3s.map(r => JSON.parse(r.output))

    console.log(`[dca] Recovered: ${state.status} | legs=${state.legs.length} | TP=${state.currentTp} | SL=${state.currentSl}`)

    // Detect incomplete state — missing critical data for the current status
    const incomplete = (
      (state.status === 'WATCHING_LEVEL' && !state.agent1) ||
      (state.status === 'OPEN_1LEG'      && (!state.agent2 || state.legs.length < 1)) ||
      (state.status === 'OPEN_2LEGS'     && state.legs.length < 2) ||
      (state.status === 'OPEN_3LEGS'     && state.legs.length < 3)
    )
    if (incomplete) {
      console.log(`[dca] Incomplete state detected (${state.status}, agent1=${!!state.agent1}, legs=${state.legs.length}) — cleaning DB and restarting`)
      try {
        const p = await getPool()
        await p.request().query('DELETE FROM agent_runs')
        await p.request().query('DELETE FROM dca_legs')
        await p.request().query('DELETE FROM dca_operations')
      } catch (e) { console.error('[dca] Auto-cleanup error:', e.message) }
      state = EMPTY_STATE()
    }
  } catch (err) {
    console.error('[dca] DB recovery error:', err.message)
  }
}

// ─── Clock alignment ───────────────────────────────────────────────────────────
function alignedDelay(ms) { return ms - (Date.now() % ms) + 5_000 }

// ─── Public exports ────────────────────────────────────────────────────────────
export function getSignalState() {
  return {
    tradingPaused: TRADING_PAUSED,
    status: { ...serviceStatus },
    dcaState: {
      status:          state.status,
      operationId:     state.operationId,
      direction:       state.direction,
      supportPrice:    state.supportPrice,
      resistancePrice: state.resistancePrice,
      levelPrice:      state.levelPrice,
      levelType:       state.levelType,
      levelSetAt:      state.levelSetAt,
      currentTp:       state.currentTp,
      currentSl:       state.currentSl,
      pAvg:            state.pAvg,
      legs:            state.legs,
      agent1:          state.agent1,
      agent2:          state.agent2,
      agent3Calls:     state.agent3Calls,
    },
    currentPrice: currentPrice(),
    candles:      { count15m: candles15m.length, count5m: candles5m.length },
  }
}

export async function reloadAccountConfig() { await loadAccountConfig() }

export function resetSignalState() {
  state = EMPTY_STATE()
  console.log('[dca] State reset via API — returning to IDLE')
}

export async function verifyTpSl() {
  const isOpenStatus = ['OPEN_1LEG', 'OPEN_2LEGS', 'OPEN_3LEGS'].includes(state.status)
  if (!isOpenStatus) return { checked: false, reason: 'No hay operación abierta' }
  if (!state.currentTp)  return { checked: false, reason: 'TP no definido' }

  const { direction, currentTp, legs, levelSetAt } = state
  const safetySl = legs.length > 0
    ? (direction === 'LONG'
        ? legs[0].price * (1 - (DCA_CAP_PCT + 2.0) / 100)
        : legs[0].price * (1 + (DCA_CAP_PCT + 2.0) / 100))
    : null
  const currentSl = state.currentSl ?? safetySl

  const candles = await fetchBinanceCandles('15m', 48)
  const since   = levelSetAt ? new Date(levelSetAt).getTime() : 0

  for (const c of candles) {
    if (new Date(c.OpenTime).getTime() < since) continue
    const high = +c.HighCandle
    const low  = +c.LowCandle

    const tpHit = direction === 'LONG' ? high >= currentTp  : low  <= currentTp
    const slHit = currentSl != null && (direction === 'LONG' ? low  <= currentSl : high >= currentSl)

    if (tpHit || slHit) {
      const reason = tpHit ? 'TP' : 'SL'
      console.log(`[dca] verifyTpSl → ${reason} hit on candle ${c.OpenTime} (H:${high} L:${low})`)
      await dbUpdate(state.operationId, {
        status:      'CLOSED',
        close_reason: reason,
        closed_at:   new Date(c.CloseTime ?? c.OpenTime).toISOString(),
      })
      state = EMPTY_STATE()
      return { checked: true, hit: reason, candleTime: c.OpenTime, high, low, tp: currentTp, sl: currentSl }
    }
  }

  return { checked: true, hit: null }
}

export function updateOperationLevels(id, tpPrice, slPrice) {
  if (!state.operationId || state.operationId !== id)
    return { ok: false, error: 'No matching active operation' }
  if (tpPrice != null) state.currentTp = tpPrice
  if (slPrice != null) state.currentSl = slPrice
  dbUpdate(id, {
    ...(tpPrice != null && { current_tp: tpPrice }),
    ...(slPrice != null && { current_sl: slPrice }),
  })
  console.log(`[dca] Manual update ${id}: TP=${tpPrice ?? 'unchanged'} SL=${slPrice ?? 'unchanged'}`)
  return { ok: true }
}

// ─── Service entry point ───────────────────────────────────────────────────────
export async function startSignalService() {
  if (!ANTHROPIC_API_KEY) {
    console.warn('[dca] ANTHROPIC_API_KEY not set — service disabled')
    return
  }

  // Load account config and recover state from DB on startup
  await loadAccountConfig()
  await recoverFromDB()

  // Initial candle load
  try {
    const [c15, c5] = await Promise.all([
      fetchBinanceCandles('15m', CANDLES_15M_KEEP),
      fetchBinanceCandles('5m',  CANDLES_5M_KEEP),
    ])
    candles15m = c15
    candles5m  = c5
    serviceStatus.lastUpdate15m = serviceStatus.lastUpdate5m = new Date().toISOString()
    console.log(`[dca] Loaded ${candles15m.length} 15m + ${candles5m.length} 5m candles`)
  } catch (err) {
    console.error('[dca] Initial candle load failed:', err.message)
    serviceStatus.error = err.message
  }

  // 1m — price monitoring (level touch, DCA trigger, TP/SL)
  const tick1m = async () => {
    try {
      const fr = await fetchBinanceCandles('1m', 3)
      candles1m = mergeAndTrim(candles1m, fr, CANDLES_1M_KEEP)
      await monitorTick()
    } catch (err) { console.error('[dca] 1m error:', err.message) }
  }
  setTimeout(() => { tick1m(); setInterval(tick1m, MS_1M) }, alignedDelay(MS_1M))

  // 5m — candle refresh
  const tick5m = async () => {
    try {
      const fr = await fetchBinanceCandles('5m', 3)
      candles5m = mergeAndTrim(candles5m, fr, CANDLES_5M_KEEP)
      serviceStatus.lastUpdate5m = new Date().toISOString()
    } catch (err) { console.error('[dca] 5m error:', err.message) }
  }
  setTimeout(() => { tick5m(); setInterval(tick5m, MS_5M) }, alignedDelay(MS_5M))

  // 15m — candle refresh + Agent 1 when IDLE
  const tick15m = async () => {
    try {
      const fr = await fetchBinanceCandles('15m', 3)
      candles15m = mergeAndTrim(candles15m, fr, CANDLES_15M_KEEP)
      serviceStatus.lastUpdate15m = new Date().toISOString()
    } catch (err) { console.error('[dca] 15m error:', err.message) }
    await agent1Cycle()
  }

  // Run Agent 1 immediately on start if IDLE
  await agent1Cycle()
  serviceStatus.running = true

  const delay15m = alignedDelay(MS_15M)
  console.log(`[dca] First 15m cycle in ${Math.round(delay15m / 1000)}s`)
  setTimeout(() => { tick15m(); setInterval(tick15m, MS_15M) }, delay15m)

  console.log('[dca] Service started')
}
