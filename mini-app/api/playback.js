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
      req.headers['x-telegram-init-data'],
      TELEGRAM_BOT_TOKEN,
      TELEGRAM_ALLOWED_USER_IDS
    )
  } catch {
    user = null
  }
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

  const { kind, id } = body || {}
  if (!['space', 'clip'].includes(kind) ||
      typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(id)) {
    return res.status(400).json({ error: 'Invalid item kind or ID.' })
  }

  let origin
  try {
    origin = new URL(ORACLE_ORIGIN)
    if (origin.protocol !== 'https:' || origin.username || origin.password ||
        origin.search || origin.hash || origin.pathname !== '/') {
      throw new Error('Invalid public origin')
    }
  } catch {
    return res.status(500).json({
      error: 'Playback requires a public HTTPS recorder origin.',
    })
  }

  const pathname = kind === 'clip'
    ? `/api/space/clip/${id}/file`
    : `/api/space/preview/${id}`
  const expires = String(Math.floor(Date.now() / 1000) + 3600)
  const signature = crypto.createHmac('sha256', RECORDER_RELAY_KEY)
    .update(pathname + '\n' + expires).digest('hex')
  const url = new URL(pathname, origin)
  url.searchParams.set('play', '1')
  url.searchParams.set('expires', expires)
  url.searchParams.set('signature', signature)

  return res.status(200).json({ url: url.href, expires: Number(expires) })
}
