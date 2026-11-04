const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')
const { createPendingRecordingStore } = require('../lib/pending-recording-store')
const { createRecorderBot } = require('../telegram-bot')
process.env.RECORDER_RELAY_KEY = 'test-only-relay-key'
process.env.TELEGRAM_ALLOWED_USER_IDS = '42'
const { attachPendingRecordingRoutes } = require('../lib/pending-recording-routes')

function database(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'saved-tracking-'))
  const db = new DatabaseSync(path.join(dir, 'test.db'))
  t.after(() => {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const store = createPendingRecordingStore(db)
  function recorded(user = '42', jobId = 'mock_job') {
    const row = store.enqueue({
      ownerId: user, chatId: user, spaceId: '1rxmqpPayldxy',
    })
    const claimed = store.claim(row.id, user, 'x_test')
    store.markSubmitting(row.id, user, claimed.claim_token)
    store.markStarted(row.id, user, claimed.claim_token, jobId)
    return row
  }
  return { db, store, recorded }
}

test('durable tracked-request listing is owner-scoped', t => {
  const q = database(t)
  q.recorded('42', 'job42')
  q.recorded('77', 'job77')
  assert.deepEqual(
    q.store.listRecordingRequests('42').map(r => r.job_id), ['job42']
  )
})

test('finishing tracking requires the correct owner and job', t => {
  const q = database(t)
  const row = q.recorded()
  assert.equal(q.store.finishTracking(row.id, '77', 'mock_job'), null)
  assert.equal(q.store.finishTracking(row.id, '42', 'other_job'), null)
  assert.ok(q.store.finishTracking(row.id, '42', 'mock_job'))
  assert.equal(q.store.listRecordingRequests('42').length, 0)
})

function backend({ ackFails = 0 } = {}) {
  const state = { jobState: 'downloading', tracked: true, acknowledgements: 0 }
  const calls = []
  async function request(method, route, body, options) {
    calls.push({ method, route, options })
    if (route === '/api/space/requests') return {
      status: 200, json: { ok: true, requests: state.tracked ? [{
        requestId: 'pending_test', jobId: 'mock_job',
        spaceId: '1rxmqpPayldxy', state: 'recording',
      }] : [] },
    }
    if (route === '/api/space/process') return {
      status: 200,
      json: {
        ok: true,
        active: [{
          id: 'mock_job',
          item_kind: 'space',
          state: 'downloading',
          title: 'Mock Space',
        }],
      },
    }
    if (route === '/api/space/status/mock_job') return {
      status: 200, json: { state: state.jobState, name: 'Mock Space' },
    }
    if (route === '/api/space/requests/pending_test/complete') {
      state.acknowledgements++
      if (state.acknowledgements <= ackFails) {
        return { status: 503, json: { ok: false } }
      }
      state.tracked = false
      return { status: 200, json: { ok: true } }
    }
    throw new Error('Unexpected mocked action')
  }
  function app() {
    const sent = []
    class FakeBot {
      on() {}
      async sendMessage(chatId, text, extra) { sent.push({ chatId, text, extra }) }
    }
    return {
      sent,
      bot: createRecorderBot({
        token: 'test-only',
        relayKey: process.env.RECORDER_RELAY_KEY,
        publicBaseUrl: 'https://recorder.example',
        miniAppBaseUrl: 'https://mini.example',
        allowedUserIds: ['42'],
        trackSavedRequests: true,
        Bot: FakeBot, request,
      }),
    }
  }
  return { state, calls, app }
}

test('fresh bot restores a saved recording into active tracking', async () => {
  const q = backend()
  const first = q.app()
  await first.bot.pollOnce()
  assert.equal(first.bot.active.get('mock_job').ownerId, '42')
  const restarted = q.app()
  await restarted.bot.pollOnce()
  assert.equal(restarted.bot.active.get('mock_job').savedRequestId, 'pending_test')
})

test('status command restores saved jobs before displaying status', async () => {
  const q = backend()
  const app = q.app()
  await app.bot.onMessage({
    text: '/status', from: { id: 42 }, chat: { id: 42, type: 'private' },
  })
  assert.ok(app.sent.some(s => s.text.includes('downloading')))
  assert.equal(app.bot.active.size, 1)
})

test('ready saved job sends completion and acknowledges tracking', async () => {
  const q = backend()
  q.state.jobState = 'ready'
  const app = q.app()
  await app.bot.pollOnce()
  await app.bot.pollOnce()
  assert.equal(app.sent.filter(s => s.text.startsWith('Saved.')).length, 1)
  assert.equal(q.state.acknowledgements, 1)
  assert.equal(app.bot.active.size, 0)
  assert.ok(q.calls.every(c => c.options.headers['x-relay-user'] === '42'))
})

test('failed acknowledgement is retried without repeating the saved message', async () => {
  const q = backend({ ackFails: 1 })
  q.state.jobState = 'ready'
  const app = q.app()
  await app.bot.pollOnce()
  assert.equal(app.bot.active.size, 1)
  await app.bot.pollOnce()
  assert.equal(app.sent.filter(s => s.text.startsWith('Saved.')).length, 1)
  assert.equal(q.state.acknowledgements, 2)
  assert.equal(app.bot.active.size, 0)
})

test('overlapping polls do not duplicate resumed-job completion', async () => {
  const q = backend()
  q.state.jobState = 'ready'
  const app = q.app()
  await Promise.all([app.bot.pollOnce(), app.bot.pollOnce()])
  assert.equal(app.sent.filter(s => s.text.startsWith('Saved.')).length, 1)
  assert.equal(q.state.acknowledgements, 1)
})

test('tracking endpoints redact rows and verify terminal state before completion', async t => {
  const q = database(t)
  const row = q.recorded()
  const registered = new Map()
  const router = {
    get: (p, ...h) => registered.set('GET ' + p, h),
    post: (p, ...h) => registered.set('POST ' + p, h),
  }
  let jobState = 'downloading'
  attachPendingRecordingRoutes(router, {
    getDb: () => q.db,
    forward: async () => ({ status: 200, json: { state: jobState } }),
  })
  async function invoke(route, method) {
    const req = {
      headers: {
        'x-relay-key': process.env.RECORDER_RELAY_KEY,
        'x-relay-user': '42',
      },
      params: { id: row.id }, body: {},
    }
    const res = {
      statusCode: 200,
      status(n) { this.statusCode = n; return this },
      json(data) { this.data = data; return this },
    }
    const handlers = registered.get(method + ' ' + route)
    let index = 0
    const next = () => {
      const fn = handlers[index++]
      return fn ? fn(req, res, next) : undefined
    }
    await next()
    return res
  }
  const listed = await invoke('/requests', 'GET')
  assert.equal(listed.data.requests.length, 1)
  assert.equal(listed.data.requests[0].claim_token, undefined)
  assert.equal(
    (await invoke('/requests/:id/complete', 'POST')).statusCode, 409
  )
  jobState = 'ready'
  assert.equal(
    (await invoke('/requests/:id/complete', 'POST')).statusCode, 200
  )
  assert.equal(q.store.get(row.id, '42').state, 'completed')
})

