const test = require('node:test')
const { beforeEach, after } = test
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const handler = require('../api/export-download')

const id = 'e' + 'a'.repeat(32)
const pathname = '/api/space/exports/' + id + '/file'
const originalFetch = globalThis.fetch
let calls, backendStatus, backendData

beforeEach(() => {
  process.env.TELEGRAM_BOT_TOKEN = 'isolated-export-download-token'
  process.env.TELEGRAM_ALLOWED_USER_IDS = '7'
  process.env.RECORDER_RELAY_KEY = 'isolated-export-download-key'
  process.env.ORACLE_ORIGIN = 'https://recorder.example.com'
  calls = []
  backendStatus = 200
  backendData = { ok: true, id, available: true, downloadPath: pathname }
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options })
    return {
      ok: backendStatus === 200,
      status: backendStatus,
      json: async () => backendData,
    }
  }
})
after(() => { globalThis.fetch = originalFetch })

function identity(userId = 7) {
  const params = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1000)),
    user: JSON.stringify({ id: userId }),
  })
  const text = [...params.entries()]
    .map(([key, value]) => `${key}=${value}`).sort().join('\n')
  const secret = crypto.createHmac('sha256', 'WebAppData')
    .update(process.env.TELEGRAM_BOT_TOKEN).digest()
  params.set('hash', crypto.createHmac('sha256', secret).update(text).digest('hex'))
  return params.toString()
}

async function issue({
  init = identity(), body = { id }, method = 'POST',
} = {}) {
  const res = {
    statusCode: 200, headers: {},
    setHeader(name, value) { this.headers[name.toLowerCase()] = value },
    status(code) { this.statusCode = code; return this },
    json(value) { this.data = value; return this },
  }
  await handler({
    method, body, headers: { 'x-telegram-init-data': init },
  }, res)
  return res
}

test('export signing verifies the owner with the backend before signing the exact file path', async () => {
  const result = await issue()
  assert.equal(result.statusCode, 200)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://recorder.example.com/api/space/exports/' + id + '/download')
  assert.equal(calls[0].options.method, 'POST')
  assert.equal(calls[0].options.headers['x-relay-user'], '7')
  assert.equal(calls[0].options.headers['x-relay-key'], process.env.RECORDER_RELAY_KEY)
  const url = new URL(result.data.url)
  assert.equal(url.pathname, pathname)
  const expected = crypto.createHmac('sha256', process.env.RECORDER_RELAY_KEY)
    .update(pathname + '\n' + url.searchParams.get('expires')).digest('hex')
  assert.equal(url.searchParams.get('signature'), expected)
  assert.equal(url.href.includes(process.env.RECORDER_RELAY_KEY), false)
  assert.equal(result.headers['cache-control'], 'no-store')
})

test('missing Telegram identity cannot trigger an export preflight', async () => {
  assert.equal((await issue({ init: '' })).statusCode, 401)
  assert.equal(calls.length, 0)
})

test('unapproved Telegram identity cannot trigger an export preflight', async () => {
  assert.equal((await issue({ init: identity(8) })).statusCode, 401)
  assert.equal(calls.length, 0)
})

test('backend ownership denial never produces a signed URL', async () => {
  backendStatus = 403
  const result = await issue()
  assert.equal(result.statusCode, 404)
  assert.equal(result.data.url, undefined)
})

test('unconfirmed or substituted backend paths never receive a signature', async () => {
  backendData.downloadPath = '/api/space/exports/other/file'
  const result = await issue()
  assert.equal(result.statusCode, 502)
  assert.equal(result.data.url, undefined)
})

test('an unavailable export never receives a signature', async () => {
  backendData.available = false
  const result = await issue()
  assert.equal(result.statusCode, 502)
  assert.equal(result.data.url, undefined)
})

test('export signing rejects non-POST methods without a backend call', async () => {
  assert.equal((await issue({ method: 'GET' })).statusCode, 405)
  assert.equal(calls.length, 0)
})

test('invalid export identifiers cannot select arbitrary backend paths', async () => {
  const result = await issue({ body: { id: '../outside' } })
  assert.equal(result.statusCode, 400)
  assert.equal(calls.length, 0)
})
