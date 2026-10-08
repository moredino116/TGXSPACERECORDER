const crypto = require('crypto')

function relayKeyMatches(req, expected = process.env.RECORDER_RELAY_KEY) {
  const supplied = req.get ? req.get('X-Recorder-Relay-Key') || '' : req.headers?.['x-recorder-relay-key'] || ''
  if (!expected || !supplied) return false

  const expectedBuffer = Buffer.from(String(expected), 'utf8')
  const suppliedBuffer = Buffer.from(String(supplied), 'utf8')
  if (expectedBuffer.length !== suppliedBuffer.length) return false
  return crypto.timingSafeEqual(expectedBuffer, suppliedBuffer)
}

function requireRelay(req, res, next) {
  if (!relayKeyMatches(req)) {
    return res.status(401).json({ error: 'Trusted relay authorization required.' })
  }
  next()
}

module.exports = { requireRelay, relayKeyMatches }
