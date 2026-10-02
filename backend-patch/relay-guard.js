// Mount in backend/server.js BEFORE routes: app.use('/api', require('./relay-guard'))
// Requires RECORDER_RELAY_KEY in backend/.env.
// Loopback is allowed only when the request is NOT proxied (no X-Forwarded-* / X-Real-IP).
// Nginx must set those headers so public traffic is forced to present the key.
const crypto = require('crypto')
module.exports = (req, res, next) => {
  const key = process.env.RECORDER_RELAY_KEY
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
