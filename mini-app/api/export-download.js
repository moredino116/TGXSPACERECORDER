const crypto = require('node:crypto')
const { verifyInitData } = require('../lib/verify')

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store')
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'Method not allowed.' })
  }
  const {
    TELEGRAM_BOT_TOKEN, TELEGRAM_ALLOWED_USER_IDS,
    ORACLE_ORIGIN, RECORDER_RELAY_KEY,
  } = process.env
  if (!TELEGRAM_BOT_TOKEN || !ORACLE_ORIGIN || !RECORDER_RELAY_KEY) {
    return res.status(500).json({ error: 'Server not configured.' })
  }

  let user
  try {
    user = verifyInitData(
      req.headers?.['x-telegram-init-data'],
      TELEGRAM_BOT_TOKEN, TELEGRAM_ALLOWED_USER_IDS
    )
  } catch {}
  if (!user) {
    return res.status(401).json({
      error: 'Open this from Telegram with an approved account.',
    })
  }

  let body
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body
  } catch {
    return res.status(400).json({ error: 'Invalid request body.' })
  }
  const id = body?.id
  if (typeof id !== 'string' || !/^e[a-f0-9]{32}$/.test(id)) {
    return res.status(400).json({ error: 'Invalid export ID.' })
  }

  let origin
  try {
    origin = new URL(ORACLE_ORIGIN)
    if (origin.protocol !== 'https:' || origin.username || origin.password ||
        origin.pathname !== '/' || origin.search || origin.hash) throw new Error()
  } catch {
    return res.status(500).json({ error: 'Invalid recorder origin.' })
  }

  const pathname = '/api/space/exports/' + id + '/file'
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10000)
  try {
    const checked = await fetch(
      new URL('/api/space/exports/' + id + '/download', origin),
      {
        method: 'POST',
        cache: 'no-store',
        signal: controller.signal,
        headers: {
          'x-relay-key': RECORDER_RELAY_KEY,
          'x-relay-user': String(user.id),
        },
      }
    )
    if (!checked.ok) {
      return res.status(404).json({ error: 'Export is not available for download.' })
    }
    const data = await checked.json()
    if (data?.ok !== true || data.id !== id ||
        data.available !== true || data.downloadPath !== pathname) {
      return res.status(502).json({ error: 'Export availability was not confirmed.' })
    }

    const expires = String(Math.floor(Date.now() / 1000) + 3600)
    const signature = crypto.createHmac('sha256', RECORDER_RELAY_KEY)
      .update(pathname + '\n' + expires).digest('hex')
    const url = new URL(pathname, origin)
    url.searchParams.set('expires', expires)
    url.searchParams.set('signature', signature)
    return res.json({ url: url.href, expires: Number(expires) })
  } catch {
    return res.status(502).json({ error: 'Export availability was not confirmed.' })
  } finally {
    clearTimeout(timer)
  }
}

