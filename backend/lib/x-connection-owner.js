
const crypto = require('node:crypto')

function resolveXConnectionOwner(req, env = process.env) {
  const supplied = req.headers?.['x-relay-key']
  const expected = env.RECORDER_RELAY_KEY
  if (typeof supplied !== 'string' || !expected) return null

  const a = Buffer.from(supplied)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null

  const id = req.headers?.['x-relay-user']
  if (typeof id !== 'string' || !/^[1-9][0-9]{0,19}$/.test(id)) return null

  const allowed = String(env.TELEGRAM_ALLOWED_USER_IDS || '')
    .split(',').map(value => value.trim()).filter(Boolean)
  if (!allowed.includes(id)) return null

  return Object.freeze({
    workspace: 'telegram:' + id,
    user: id,
  })
}

function xConnectionOwnerGuard(req, res, next) {
  const owner = resolveXConnectionOwner(req)
  if (!owner) {
    return res.status(403).json({
      ok: false,
      error: 'An authorized Telegram connection is required.',
    })
  }
  req.xConnectionOwner = owner
  return next()
}

module.exports = { resolveXConnectionOwner, xConnectionOwnerGuard }
