import express from 'express'
import cors from 'cors'
import sql from 'mssql'

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

// Caché en memoria — evita re-consultar la BD cuando el rango no cambia
const candleCache = new Map()

// GET /api/candles - fetch candles for backtesting
app.get('/api/candles', async (req, res) => {
  const { from, to } = req.query

  if (!from || !to) {
    return res.status(400).json({ error: 'Se requieren parámetros from y to (YYYY-MM-DD)' })
  }

  const cacheKey = `${from}|${to}`
  if (candleCache.has(cacheKey)) {
    const cached = candleCache.get(cacheKey)
    return res.json({ candles: cached, total: cached.length, cached: true })
  }

  try {
    const db = await getPool()
    const result = await db.request()
      .input('from', sql.DateTime2, new Date(from))
      .input('to', sql.DateTime2, new Date(to + 'T23:59:59'))
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
        WHERE c.SymbolId  = (SELECT SymbolId   FROM dbo.Symbols    WHERE SymbolCode     = 'BTCUSDC')
          AND c.TimeframeId = (SELECT TimeframeId FROM dbo.Timeframes WHERE IntervalSeconds = 900)
          AND c.OpenTime >= @from
          AND c.OpenTime <= @to
        ORDER BY c.OpenTime ASC
      `)

    const candles = result.recordset
    candleCache.clear()           // solo guardamos el último rango
    candleCache.set(cacheKey, candles)

    res.json({ candles, total: candles.length })
  } catch (err) {
    console.error('DB Error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// GET /api/status - check DB connection
app.get('/api/status', async (_req, res) => {
  try {
    const db = await getPool()
    const result = await db.request().query(`
      SELECT COUNT(*) as total FROM dbo.Candles c
      WHERE c.SymbolId = (SELECT SymbolId FROM dbo.Symbols WHERE SymbolCode = 'BTCUSDC')
    `)
    res.json({ connected: true, totalCandles: result.recordset[0].total })
  } catch (err) {
    res.status(500).json({ connected: false, error: err.message })
  }
})

const server = app.listen(3001, () => {
  console.log('🚀 API corriendo en http://localhost:3001')
})
server.timeout = 0  // sin límite — el mssql requestTimeout controla el corte
