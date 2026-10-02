const { verifyInitData, allowed } = require('../lib/verify')
module.exports = async (req, res) => {
  const { TELEGRAM_BOT_TOKEN, TELEGRAM_ALLOWED_USER_IDS, ORACLE_ORIGIN, RECORDER_RELAY_KEY } = process.env
  if (!TELEGRAM_BOT_TOKEN || !ORACLE_ORIGIN || !RECORDER_RELAY_KEY) return res.status(500).json({ error: 'Server not configured.' })
  const user = verifyInitData(req.headers['x-telegram-init-data'], TELEGRAM_BOT_TOKEN, TELEGRAM_ALLOWED_USER_IDS)
  if (!user) return res.status(401).json({ error: 'Open this from Telegram with an approved account.' })
  const path = String(req.query.path || '').replace(/^\/+/, '')
  if (!allowed(req.method, path)) return res.status(403).json({ error: 'Action not permitted.' })
  const url = new URL('/api/' + path, ORACLE_ORIGIN)
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), 20000)
  try {
    const init = { method: req.method, signal: ctrl.signal, headers: { 'x-relay-key': RECORDER_RELAY_KEY, 'x-relay-user': String(user.id) } }
    if (req.method !== 'GET' && req.method !== 'DELETE' && req.body) {
      init.headers['content-type'] = 'application/json'
      init.body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body)
    }
    const r = await fetch(url, init)
    res.status(r.status).setHeader('content-type', r.headers.get('content-type') || 'application/json')
    res.send(Buffer.from(await r.arrayBuffer()))
  } catch (e) {
    res.status(502).json({ error: 'Recorder unreachable.' })
  } finally { clearTimeout(t) }
}
