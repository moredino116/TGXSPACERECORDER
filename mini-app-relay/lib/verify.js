const crypto = require('crypto')

function verifyTelegramInitData(initData, botToken) {
  if (!initData || !botToken) return null
  let params
  try {
    params = new URLSearchParams(initData)
  } catch {
    return null
  }
  const suppliedHash = params.get('hash')
  if (!suppliedHash || !/^[0-9a-f]+$/i.test(suppliedHash)) return null

  params.delete('hash')
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n')

  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest()
  const expectedHash = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex')

  try {
    const expected = Buffer.from(expectedHash, 'hex')
    const received = Buffer.from(suppliedHash, 'hex')
    if (expected.length === 0 || expected.length !== received.length) return null
    if (!crypto.timingSafeEqual(expected, received)) return null
  } catch {
    return null
  }

  const issuedAt = Number(params.get('auth_date') || 0)
  if (!issuedAt || Date.now() / 1000 - issuedAt > 3600) return null

  try {
    const user = JSON.parse(params.get('user') || 'null')
    if (!user || user.id == null) return null
    return user
  } catch {
    return null
  }
}

module.exports = { verifyTelegramInitData }
