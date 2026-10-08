const { test } = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('crypto')

process.env.TELEGRAM_BOT_TOKEN = 'test-bot-token'
process.env.TELEGRAM_ALLOWED_USER_IDS = '5567866089'
process.env.RECORDER_ORIGIN = 'https://recorder.example.com'
process.env.RECORDER_RELAY_KEY = 'relay-secret'

const record = require('../api/relay/record')
const archive = require('../api/relay/archive')
const status = require('../api/relay/status')
const health = require('../api/health')

function signInitData(id = 5567866089) {
  const fields = {
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: 'AAE',
    user: JSON.stringify({ id, first_name: 'Megan' }),
  }
  const entries = Object.entries(fields).sort(([a], [b]) => a.localeCompare(b))
  const dataCheckString = entries.map(([key, value]) => `${key}=${value}`).join('\n')
  const secret = crypto.createHmac('sha256', 'WebAppData').update(process.env.TELEGRAM_BOT_TOKEN).digest()
  const hash = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex')
  const params = new URLSearchParams()
  for (const [key, value] of entries) params.append(key, value)
  params.append('hash', hash)
  return params.toString()
}

function mockRes() {
  return {
    statusCode: 200,
    headers: {},
    payload: undefined,
    status(code) {
      this.statusCode = code
      return this
    },
    setHeader(key, value) {
      this.headers[String(key).toLowerCase()] = value
      return this
    },
    json(body) {
      this.payload = body
      return this
    },
    send(body) {
      this.raw = body
      try {
        this.payload = JSON.parse(body)
      } catch {
        this.payload = body
      }
      return this
    },
  }
}

function request({ method = 'GET', initData = signInitData(), query = {}, body = undefined } = {}) {
  return {
    method,
    query,
    body,
    headers: { authorization: `tma ${initData}` },
  }
}

test('health stays free of configuration', async () => {
  const res = mockRes()
  await health({ method: 'GET', headers: {} }, res)
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.payload, { ok: true })
})

test('archive forwards only after Telegram initData passes, and hides the relay key', async () => {
  const calls = []
  const original = global.fetch
  global.fetch = async (url, options) => {
    calls.push({ url: String(url), options })
    return new Response(JSON.stringify([{ id: 'rec1' }]), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  try {
    const stranger = mockRes()
    await archive(request({ initData: signInitData(1) }), stranger)
    assert.equal(stranger.statusCode, 401)
    assert.equal(calls.length, 0)

    const allowed = mockRes()
    await archive(request(), allowed)
    assert.equal(allowed.statusCode, 200)
    assert.deepEqual(allowed.payload, [{ id: 'rec1' }])
    assert.equal(calls[0].url, 'https://recorder.example.com/api/relay/archive')
    assert.equal(calls[0].options.headers['X-Recorder-Relay-Key'], 'relay-secret')
    assert.equal(JSON.stringify(allowed.payload).includes('relay-secret'), false)
  } finally {
    global.fetch = original
  }
})

test('record posts only the space input and rejects a browser with no initData', async () => {
  const calls = []
  const original = global.fetch
  global.fetch = async (url, options) => {
    calls.push({ url: String(url), body: options.body })
    return new Response(JSON.stringify({ id: 'job1' }), { status: 201, headers: { 'content-type': 'application/json' } })
  }
  try {
    const anonymous = mockRes()
    await record({ method: 'POST', headers: {}, body: { input: 'https://x.com/i/spaces/abc' } }, anonymous)
    assert.equal(anonymous.statusCode, 401)
    assert.equal(calls.length, 0)

    const allowed = mockRes()
    await record(request({
      method: 'POST',
      body: {
        input: ' https://x.com/i/spaces/abc ',
        accessMode: 'connected_account',
        xConnectionId: 'conn',
        cookie: 'nope',
      },
    }), allowed)
    assert.equal(allowed.statusCode, 201)
    assert.deepEqual(JSON.parse(calls[0].body), { input: 'https://x.com/i/spaces/abc' })
    assert.equal(calls[0].url, 'https://recorder.example.com/api/relay/record')
  } finally {
    global.fetch = original
  }
})

test('status rejects a bad id before calling the recorder', async () => {
  let called = false
  const original = global.fetch
  global.fetch = async () => {
    called = true
    return new Response('{}', { status: 200 })
  }
  try {
    const res = mockRes()
    await status(request({ query: { id: '../admin' } }), res)
    assert.equal(res.statusCode, 400)
    assert.equal(called, false)
  } finally {
    global.fetch = original
  }
})

test('a missing recorder origin fails closed', async () => {
  const previous = process.env.RECORDER_ORIGIN
  delete process.env.RECORDER_ORIGIN
  let called = false
  const original = global.fetch
  global.fetch = async () => {
    called = true
    return new Response('{}')
  }
  try {
    const res = mockRes()
    await archive(request(), res)
    assert.equal(res.statusCode, 500)
    assert.equal(res.payload.error, 'Recorder relay is not configured.')
    assert.equal(called, false)
  } finally {
    process.env.RECORDER_ORIGIN = previous
    global.fetch = original
  }
})
