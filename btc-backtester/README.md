# BTC Backtester — Rango Dinámico

Replica exacta de tu indicador de TradingView contra tu base de datos local de velas BTCUSDC 15m.

## Requisitos

- Node.js 18+
- SQL Server Express corriendo con autenticación Windows (Integrated Security)
- Base de datos `BotInformation` con tablas `dbo.Candles`, `dbo.Symbols`, `dbo.Timeframes`

## Instalación

```bash
# 1. Instalar dependencias
npm install

# 2. Arrancar todo (backend + frontend juntos)
npm run dev
```

Abre http://localhost:5173 en tu navegador.

## Estructura del proyecto

```
btc-backtester/
├── server/
│   └── index.js          ← API Express (puerto 3001)
├── src/
│   ├── App.jsx           ← UI React completa
│   ├── App.css           ← Estilos
│   ├── backtester.js     ← Motor lógico (replica Pine Script)
│   └── main.jsx          ← Entrada React
├── index.html
├── vite.config.js
└── package.json
```

## Configuración de BD

Si tienes error de conexión, edita `server/index.js` y ajusta:

```js
// Para autenticación Windows (por defecto):
options: { trustedConnection: true, integratedSecurity: true }

// Para usuario/contraseña SQL:
user: 'tu_usuario',
password: 'tu_password',
options: { trustServerCertificate: true }
```

## Lógica implementada

La lógica en `src/backtester.js` replica fielmente el script Pine Script:

- ✅ Rango dinámico (min/max %) con lookback configurable
- ✅ Detección de mecha superior mínima
- ✅ Filtro EMA10 < EMA50 (tendencia bajista)
- ✅ Primer toque del techo de rango
- ✅ 1 señal por día (hora Colombia UTC-5)
- ✅ Reset diario de trade
- ✅ TP / SL con fees
- ✅ Capital simple y compuesto con interés compuesto
- ✅ Max Drawdown
- ✅ Win Rate
