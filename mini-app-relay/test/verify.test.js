const { test } = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('crypto')
const { verifyTelegramInitData } = require('../lib/verify')

const TOKEN = 'test-bot-token'

function signInitData(fields, botToken = TOKEN) {
  const entries = Object.entries(fields).sort(([a], [b]) => a.localeCompare(b))
  const dataCheckString = entries.map(([key, value]) => `${key}=${value}`).join('\n')
  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest()
  const hash = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex')
  const params = new URLSearchParams()
  for (const [key, value] of entries) params.append(key, value)
  params.append('hash', hash)
  return params.toString()
}

function freshFields(id = 5567866089) {
  return {
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: 'AAE',
    user: JSON.stringify({ id, first_name: 'Megan' }),
  }
}

test('accepts a signed Mini App user and rejects forged or stale data', () => {
  const signed = signInitData(freshFields())
  const user = verifyTelegramInitData(signed, TOKEN)
  assert.equal(user.id, 5567866089)
  assert.equal(user.first_name, 'Megan')

  assert.equal(verifyTelegramInitData('', TOKEN), null)
  assert.equal(verifyTelegramInitData(signed, ''), null)
  assert.equal(verifyTelegramInitData(signed, 'other-token'), null)

  const forged = new URLSearchParams(signed)
  forged.set('user', JSON.stringify({ id: 1, first_name: 'Megan' }))
  assert.equal(verifyTelegramInitData(forged.toString(), TOKEN), null)

  const stale = signInitData({ ...freshFields(), auth_date: '1000' })
  assert.equal(verifyTelegramInitData(stale, TOKEN), null)

  const unsigned = new URLSearchParams(freshFields())
  assert.equal(verifyTelegramInitData(unsigned.toString(), TOKEN), null)
})
