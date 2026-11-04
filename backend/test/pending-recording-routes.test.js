const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
process.env.RECORDER_RELAY_KEY = 'test-only-relay-key'
const os = require('node:os')
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')
const { attachPendingRecordingRoutes } =
  require('../lib/pending-recording-routes')

process.env.TELEGRAM_ALLOWED_USER_IDS = '42,77'

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'request-routes-'))
  const db = new DatabaseSync(path.join(dir, 'test.db'))
  db.exec(`
    CREATE TABLE x_connections (
      id TEXT PRIMARY KEY, workspace_id TEXT, user_id TEXT, status TEXT
    );
    INSERT INTO x_connections VALUES ('x_owned','telegram:42','42','active');
    INSERT INTO x_connections VALUES ('x_other','telegram:77','77','active');
  `)
  t.after(() => {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const registered = new Map()
  const calls = []
  let dbCalls = 0
  const router = {
    get: (p, ...h) => registered.set('GET ' + p, h),
    post: (p, ...h) => registered.set('POST ' + p, h),
  }
  attachPendingRecordingRoutes(router, {
    getDb: () => { dbCalls++; return db },
    forward: async (req, method, pathname, body) => {
      calls.push({ owner: req.xConnectionOwner.user, pathname, body })
      if (pathname === '/api/space/resolve') return {
        status: 200, json: {
          ok: true, title: 'Mock',
          m3u8: 'https://media.example/mock.m3u8',
        },
      }
      if (pathname === '/api/space/download') return {
        status: 200, json: { id: 'mock_job' },
      }
      throw new Error('Unexpected action')
    },
  })

  async function invoke(method, route, {
    user = '42', authenticated = true, body = {}, id = '',
  } = {}) {
    const req = {
      headers: authenticated ? {
        'x-relay-key': process.env.RECORDER_RELAY_KEY,
        'x-relay-user': user,
      } : {},
      params: { id }, body,
    }
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this },
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
  const enqueue = () => invoke('POST', '/requests', {
    body: { spaceId: '1rxmqpPayldxy', ownerId: '77' },
  })
  return { db, calls, invoke, enqueue, dbCalls: () => dbCalls }
}

test('request authentication runs before storage initialization', async t => {
  const q = setup(t)
  const r = await q.invoke('POST', '/requests', { authenticated: false })
  assert.equal(r.statusCode, 403)
  assert.equal(q.dbCalls(), 0)
})

test('enqueue uses verified identity and deduplicates', async t => {
  const q = setup(t)
  const a = await q.enqueue()
  const b = await q.enqueue()
  assert.equal(a.data.requestId, b.data.requestId)
  const row = q.db.prepare('SELECT * FROM pending_recording_requests').get()
  assert.equal(row.user_id, '42')
  assert.equal(row.workspace_id, 'telegram:42')
  assert.equal(a.data.claim_token, undefined)
})

test('another verified owner cannot read the request', async t => {
  const q = setup(t)
  const saved = await q.enqueue()
  const r = await q.invoke('GET', '/requests/:id', {
    id: saved.data.requestId, user: '77',
  })
  assert.equal(r.statusCode, 404)
  assert.equal(q.calls.length, 0)
})

test('retry starts once and repeated completion returns the saved job', async t => {
  const q = setup(t)
  const saved = await q.enqueue()
  const args = {
    id: saved.data.requestId,
    body: { connectionId: 'x_owned', ownerId: '77' },
  }
  const a = await q.invoke('POST', '/requests/:id/resume', args)
  const b = await q.invoke('POST', '/requests/:id/resume', args)
  assert.equal(a.statusCode, 200)
  assert.equal(a.data.jobId, 'mock_job')
  assert.equal(b.data.reused, true)
  assert.equal(q.calls.length, 2)
  assert.ok(q.calls.every(c => c.owner === '42'))
  assert.equal(q.calls[1].body.xConnectionId, 'x_owned')
})

test('another owners connection is rejected before recorder calls', async t => {
  const q = setup(t)
  const saved = await q.enqueue()
  const r = await q.invoke('POST', '/requests/:id/resume', {
    id: saved.data.requestId, body: { connectionId: 'x_other' },
  })
  assert.equal(r.statusCode, 403)
  assert.equal(q.calls.length, 0)
})

test('another verified owner cannot resume the request', async t => {
  const q = setup(t)
  const saved = await q.enqueue()
  const r = await q.invoke('POST', '/requests/:id/resume', {
    id: saved.data.requestId, user: '77',
    body: { connectionId: 'x_other' },
  })
  assert.equal(r.statusCode, 404)
  assert.equal(q.calls.length, 0)
})

