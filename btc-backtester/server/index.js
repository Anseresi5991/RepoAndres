import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import sql from 'mssql'
import { startSignalService, getSignalState, updateOperationLevels, resetSignalState, verifyTpSl, reloadAccountConfig } from './signalService.js'

const app = express()
app.use(cors())
app.use(express.json())

let pool = null

async function getPool() {
  if (!pool) {
    pool = await sql.connect({
      server: 'localhost',
      database: 'BotInformation',
      user: 'btcapp',
      password: 'btcapp123!',
      options: {
        instanceName: 'SQLEXPRESS',
        trustServerCertificate: true,
        encrypt: false,
        enableArithAbort: true,
        connectionTimeout: 30000,
        requestTimeout: 300000
      }
    })
  }
  return pool
}

const TIMEFRAME_SECONDS = {
  '1m':  60,
  '5m':  300,
  '15m': 900
}

// Caché en memoria — evita re-consultar la BD cuando el rango no cambia
const candleCache = new Map()

// GET /api/candles?from=YYYY-MM-DD&to=YYYY-MM-DD&timeframe=15m
app.get('/api/candles', async (req, res) => {
  const { from, to, timeframe = '15m' } = req.query

  if (!from || !to) {
    return res.status(400).json({ error: 'Se requieren parámetros from y to (YYYY-MM-DD)' })
  }

  const intervalSeconds = TIMEFRAME_SECONDS[timeframe]
  if (!intervalSeconds) {
    return res.status(400).json({ error: `Timeframe inválido: ${timeframe}. Usar: 1m, 5m, 15m` })
  }

  const cacheKey = `${from}|${to}|${timeframe}`
  if (candleCache.has(cacheKey)) {
    const cached = candleCache.get(cacheKey)
    return res.json({ candles: cached, total: cached.length, cached: true })
  }

  try {
    const db = await getPool()
    const result = await db.request()
      .input('from', sql.DateTime2, new Date(from))
      .input('to', sql.DateTime2, new Date(to + 'T23:59:59'))
      .input('intervalSeconds', sql.Int, intervalSeconds)
      .query(`
        SELECT
          c.CandleId,
          REPLACE(CONVERT(varchar(19), c.OpenTime, 120), ' ', 'T') + 'Z' AS OpenTime,
          REPLACE(CONVERT(varchar(19), c.CloseTime, 120), ' ', 'T') + 'Z' AS CloseTime,
          c.OpenCandle,
          c.HighCandle,
          c.LowCandle,
          c.CloseCandle,
          c.Volume
        FROM dbo.Candles c
        WHERE c.SymbolId    = (SELECT SymbolId    FROM dbo.Symbols    WHERE SymbolCode     = 'BTCUSDC')
          AND c.TimeframeId = (SELECT TimeframeId FROM dbo.Timeframes WHERE IntervalSeconds = @intervalSeconds)
          AND c.OpenTime >= @from
          AND c.OpenTime <= @to
        ORDER BY c.OpenTime ASC
      `)

    const candles = result.recordset
    candleCache.set(cacheKey, candles)

    res.json({ candles, total: candles.length, timeframe })
  } catch (err) {
    console.error('DB Error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// GET /api/status - check DB connection and candle counts per timeframe
app.get('/api/status', async (_req, res) => {
  try {
    const db = await getPool()
    const result = await db.request().query(`
      SELECT
        t.IntervalSeconds,
        COUNT(*) as total
      FROM dbo.Candles c
      JOIN dbo.Timeframes t ON c.TimeframeId = t.TimeframeId
      WHERE c.SymbolId = (SELECT SymbolId FROM dbo.Symbols WHERE SymbolCode = 'BTCUSDC')
      GROUP BY t.IntervalSeconds
      ORDER BY t.IntervalSeconds
    `)
    const candlesByTimeframe = result.recordset
    const totalCandles = candlesByTimeframe.reduce((sum, r) => sum + r.total, 0)
    res.json({ connected: true, totalCandles, candlesByTimeframe })
  } catch (err) {
    res.status(500).json({ connected: false, error: err.message })
  }
})

// PATCH /api/operations/:id — editar TP/SL manualmente en operación OPEN
app.patch('/api/operations/:id', (req, res) => {
  const { id } = req.params
  const { tpPrice, slPrice } = req.body
  if (tpPrice == null && slPrice == null)
    return res.status(400).json({ error: 'Se requiere tpPrice o slPrice' })
  const result = updateOperationLevels(id, tpPrice ?? null, slPrice ?? null)
  if (!result.ok) return res.status(404).json({ error: result.error })
  res.json(result.op)
})

// POST /api/verify-tp — revisa últimas 12h de velas 15m para detectar TP/SL por mecha
app.post('/api/verify-tp', async (_req, res) => {
  try {
    const result = await verifyTpSl()
    res.json(result)
  } catch (err) {
    console.error('[dca] verify-tp error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// POST /api/reset — borra operación activa y reinicia el estado en memoria
app.post('/api/reset', async (_req, res) => {
  try {
    const db = await getPool()
    await db.request().query(`DELETE FROM agent_runs  WHERE operation_id IN (SELECT id FROM dca_operations WHERE status != 'CLOSED')`)
    await db.request().query(`DELETE FROM dca_legs    WHERE operation_id IN (SELECT id FROM dca_operations WHERE status != 'CLOSED')`)
    await db.request().query(`DELETE FROM dca_operations WHERE status != 'CLOSED'`)
    resetSignalState()
    console.log('[dca] Reset via API — active operation cleared, CLOSED history preserved')
    res.json({ ok: true })
  } catch (err) {
    console.error('[dca] Reset error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// GET /api/stats — diario de operaciones + resumen
app.get('/api/stats', async (_req, res) => {
  try {
    const db = await getPool()
    const [cfgRes, tradesRes] = await Promise.all([
      db.request().query('SELECT total_capital FROM account_config WHERE id=1'),
      db.request().query('SELECT * FROM trade_journal ORDER BY trade_date DESC'),
    ])
    const totalCapital = cfgRes.recordset[0]?.total_capital ?? 0
    const trades = tradesRes.recordset.map(t => {
      const pnlUsd = t.capital_used != null && t.pnl_pct != null
        ? +(+t.capital_used * +t.pnl_pct / 100).toFixed(2) : null
      const pnlPctAcc = pnlUsd != null && totalCapital
        ? +(pnlUsd / totalCapital * 100).toFixed(3) : null
      return { ...t, pnl_usd: pnlUsd, pnl_pct_account: pnlPctAcc }
    })
    const closed   = trades.filter(t => t.result === 'TP' || t.result === 'SL')
    const wins     = closed.filter(t => t.result === 'TP').length
    const totalPnl = closed.reduce((s, t) => s + (t.pnl_usd ?? 0), 0)
    const summary  = {
      totalOps: closed.length, wins, losses: closed.length - wins,
      winRate:  closed.length ? +(wins / closed.length * 100).toFixed(1) : 0,
      totalPnlUsd: +totalPnl.toFixed(2),
      returnPct: totalCapital ? +(totalPnl / totalCapital * 100).toFixed(3) : 0,
    }
    res.json({ totalCapital, trades, summary })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// PUT /api/stats/config — actualizar capital total
app.put('/api/stats/config', async (req, res) => {
  try {
    const { total_capital } = req.body
    const db = await getPool()
    await db.request().input('tc', sql.Decimal(18, 2), total_capital)
      .query('UPDATE account_config SET total_capital=@tc, updated_at=GETUTCDATE() WHERE id=1')
    await reloadAccountConfig()
    res.json({ ok: true })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// POST /api/stats/trade — agregar operación manual
app.post('/api/stats/trade', async (req, res) => {
  try {
    const { trade_date, direction, capital_used, result, pnl_pct, notes, strategy } = req.body
    const id = `TJ_M_${Date.now()}`
    const db = await getPool()
    await db.request()
      .input('id',   sql.VarChar,        id)
      .input('date', sql.DateTime2,      new Date(trade_date ?? Date.now()))
      .input('dir',  sql.VarChar,        direction    ?? null)
      .input('cap',  sql.Decimal(18, 2), capital_used ?? null)
      .input('res',  sql.VarChar,        result       ?? null)
      .input('pct',  sql.Decimal(8, 4),  pnl_pct      ?? null)
      .input('nts',  sql.VarChar,        notes        ?? null)
      .input('strat',sql.VarChar,        strategy     ?? null)
      .query(`INSERT INTO trade_journal (id, source, trade_date, direction, capital_used, result, pnl_pct, notes, strategy)
              VALUES (@id, 'MANUAL', @date, @dir, @cap, @res, @pct, @nts, @strat)`)
    res.json({ ok: true, id })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// PUT /api/stats/trade/:id — editar operación
app.put('/api/stats/trade/:id', async (req, res) => {
  try {
    const { trade_date, direction, capital_used, result, pnl_pct, notes, strategy } = req.body
    const db = await getPool()
    await db.request()
      .input('id',   sql.VarChar,        req.params.id)
      .input('date', sql.DateTime2,      new Date(trade_date))
      .input('dir',  sql.VarChar,        direction    ?? null)
      .input('cap',  sql.Decimal(18, 2), capital_used ?? null)
      .input('res',  sql.VarChar,        result       ?? null)
      .input('pct',  sql.Decimal(8, 4),  pnl_pct      ?? null)
      .input('nts',  sql.VarChar,        notes        ?? null)
      .input('strat',sql.VarChar,        strategy     ?? null)
      .query(`UPDATE trade_journal
              SET trade_date=@date, direction=@dir, capital_used=@cap,
                  result=@res, pnl_pct=@pct, notes=@nts, strategy=@strat
              WHERE id=@id`)
    res.json({ ok: true })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// DELETE /api/stats/trade/:id
app.delete('/api/stats/trade/:id', async (req, res) => {
  try {
    const db = await getPool()
    await db.request().input('id', sql.VarChar, req.params.id)
      .query('DELETE FROM trade_journal WHERE id=@id')
    res.json({ ok: true })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// GET /api/signals — estado del servicio de señales live
app.get('/api/signals', (_req, res) => {
  try {
    res.json(getSignalState())
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

const server = app.listen(3001, () => {
  console.log('🚀 API corriendo en http://localhost:3001')
  startSignalService().catch(err => console.error('[signal] Start error:', err.message))
})
server.timeout = 0  // sin límite — el mssql requestTimeout controla el corte
