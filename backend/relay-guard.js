// Mount in backend/server.js BEFORE routes: app.use('/api', require('./relay-guard'))
// Requires RECORDER_RELAY_KEY in backend/.env.
// Loopback is allowed only when the request is NOT proxied (no X-Forwarded-* / X-Real-IP).
// Nginx must set those headers so public traffic is forced to present the key.
const crypto = require('crypto')
module.exports = (req, res, next) => {
  const key = process.env.RECORDER_RELAY_KEY

  // Signed playback links v1
  const signedPlaybackAllowed = /^\/space\/(?:file|preview)\/[A-Za-z0-9_-]+$/.test(req.path)
    || /^\/space\/clip\/[A-Za-z0-9_-]+\/file$/.test(req.path)
    || /^\/space\/exports\/e[a-f0-9]{32}\/file$/.test(req.path)
  if (key && signedPlaybackAllowed && ['GET', 'HEAD'].includes(req.method)) {
    const signedExpiry = String(req.query.expires || '')
    const signedValue = String(req.query.signature || '')
    const signedNow = Math.floor(Date.now() / 1000)
    if (/^\d{10}$/.test(signedExpiry) && Number(signedExpiry) > signedNow
        && Number(signedExpiry) <= signedNow + 86460
        && /^[a-f0-9]{64}$/.test(signedValue)) {
      const signedExpected = crypto.createHmac('sha256', key)
        .update('/api' + req.path + '\n' + signedExpiry).digest('hex')
      if (crypto.timingSafeEqual(Buffer.from(signedValue, 'hex'),
          Buffer.from(signedExpected, 'hex'))) return next()
    }
  }

  const given = req.headers['x-relay-key']
  if (given) {
    const a = Buffer.from(String(given)), b = Buffer.from(String(key || ''))
    if (key && a.length === b.length && crypto.timingSafeEqual(a, b)) return next()
    return res.status(401).json({ error: 'Bad relay key.' })
  }
  const ip = req.socket.remoteAddress || ''
  const loopback = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1'
  const proxied = req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.headers['x-forwarded-proto']
  if (loopback && !proxied) return next()
  return res.status(401).json({ error: 'Relay key required.' })
}

