// Mount in backend/server.js BEFORE routes: app.use('/api', require('./relay-guard'))
// Requires RECORDER_RELAY_KEY in backend/.env. Requests without the key are allowed only from loopback,
// so the existing Telegram bot and local UI keep working.
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
  if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') return next()
  return res.status(401).json({ error: 'Relay key required.' })
}
