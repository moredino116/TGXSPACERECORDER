const crypto = require('crypto')
function verifyInitData(initData, botToken, allowedIds, maxAgeSec = 3600, now = Date.now()) {
  if (!initData || !botToken) return null
  const p = new URLSearchParams(initData)
  const hash = p.get('hash')
  if (!hash) return null
  p.delete('hash')
  const str = [...p.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n')
  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest()
  const calc = crypto.createHmac('sha256', secret).update(str).digest('hex')
  const a = Buffer.from(calc), b = Buffer.from(hash)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null
  const age = Math.floor(now / 1000) - Number(p.get('auth_date') || 0)
  if (!(age >= 0 && age <= maxAgeSec)) return null
  let user
  try { user = JSON.parse(p.get('user') || '') } catch { return null }
  const allow = String(allowedIds || '').split(',').map(s => s.trim()).filter(Boolean)
  if (!allow.length || !allow.includes(String(user.id))) return null
  return user
}
// Allowed relay paths — must match backend/routes/space.js
const RULES = [
  ['GET', /^space\/(archive|clips|jobs|status)(\/[\w-]+)?$/],
  ['GET', /^space\/monitor\/[\w-]+$/],
  ['POST', /^space\/(download|monitor|resolve)$/],
  ['POST', /^space\/stop\/[\w-]+$/],
  ['POST', /^space\/monitor\/[\w-]+\/cancel$/],
  ['DELETE', /^space\/(archive|clips)\/[\w-]+$/],
  ['GET', /^space\/recordings\/[\w-]+\/duration$/],
  ['POST', /^space\/recordings\/[\w-]+\/clips$/]
]
function allowed(method, path) {
  if (!path || path.includes('..') || path.includes('//')) return false
  return RULES.some(([m, re]) => m === method && re.test(path))
}
module.exports = { verifyInitData, allowed }
