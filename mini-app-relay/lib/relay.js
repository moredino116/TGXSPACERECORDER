const { verifyTelegramInitData } = require('./verify')

function allowedUser(id, raw = process.env.TELEGRAM_ALLOWED_USER_IDS || '') {
  return String(raw)
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .includes(String(id))
}

function readInitData(req) {
  const header = req.headers?.authorization || req.headers?.Authorization || ''
  return header.startsWith('tma ') ? header.slice(4) : ''
}

function authorize(req) {
  const user = verifyTelegramInitData(readInitData(req), process.env.TELEGRAM_BOT_TOKEN)
  if (!user || !allowedUser(user.id)) {
    return { ok: false, status: 401, error: 'Telegram authorization required.' }
  }
  return { ok: true, user }
}

function safeId(id) {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(String(id || ''))
}

function readBody(req) {
  if (Buffer.isBuffer(req.body)) {
    try {
      return JSON.parse(req.body.toString('utf8') || '{}')
    } catch {
      return null
    }
  }
  if (req.body && typeof req.body === 'object') return req.body
  if (typeof req.body === 'string') {
    if (!req.body) return {}
    try {
      return JSON.parse(req.body)
    } catch {
      return null
    }
  }
  return {}
}

function queryOf(req) {
  if (req.query && typeof req.query === 'object') return req.query
  try {
    return Object.fromEntries(new URL(req.url || '/', 'http://localhost').searchParams)
  } catch {
    return {}
  }
}

async function forward(req, res, { method, path, body }) {
  const auth = authorize(req)
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error })

  if (!path.startsWith('/api/relay/') || path.includes('..')) {
    return res.status(400).json({ error: 'Rejected recorder path.' })
  }

  const origin = process.env.RECORDER_ORIGIN
  const key = process.env.RECORDER_RELAY_KEY
  if (!origin || !key) return res.status(500).json({ error: 'Recorder relay is not configured.' })

  let target
  try {
    const root = new URL(origin)
    target = new URL(path, root)
    if (target.origin !== root.origin) return res.status(400).json({ error: 'Rejected recorder path.' })
  } catch {
    return res.status(500).json({ error: 'Recorder relay is not configured.' })
  }

  let upstream
  try {
    upstream = await fetch(target, {
      method,
      headers: {
        Accept: 'application/json',
        'X-Recorder-Relay-Key': key,
        ...(body == null ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body == null ? undefined : JSON.stringify(body),
    })
  } catch {
    return res.status(502).json({ error: 'The recorder could not be reached.' })
  }

  const data = await upstream.text()
  res.status(upstream.status)
  res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/json')
  res.setHeader('Cache-Control', 'no-store')
  return res.send(data)
}

module.exports = { allowedUser, authorize, safeId, readBody, queryOf, forward }
