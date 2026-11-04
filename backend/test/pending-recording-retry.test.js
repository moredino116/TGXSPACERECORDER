const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')
const { createPendingRecordingStore } = require('../lib/pending-recording-store')
const { createPendingRecordingRetry } = require('../lib/pending-recording-retry')

function setup(t, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pending-retry-'))
  const db = new DatabaseSync(path.join(dir, 'test.db'))
  t.after(() => {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const store = createPendingRecordingStore(db)
  const row = store.enqueue({
    ownerId: '42', chatId: '42', spaceId: '1rxmqpPayldxy',
  })
  const calls = []
  const deps = {
    store,
    getConnection: async (id, ownerId) => {
      calls.push({ kind: 'connection', id, ownerId })
      return {
        id, workspace_id: 'telegram:42', user_id: '42', status: 'active',
      }
    },
    resolve: async args => {
      calls.push({ kind: 'resolve', args })
      return { status: 200, json: {
        ok: true, title: 'Mock Space',
        m3u8: 'https://media.example/mock.m3u8',
      } }
    },
    start: async args => {
      calls.push({ kind: 'start', args })
      assert.equal(store.get(row.id, '42').state, 'submitting')
      return { status: 200, json: { id: 'mock_job' } }
    },
    ...overrides,
  }
  const retry = createPendingRecordingRetry(deps)
  const request = {
    ownerId: '42', requestId: row.id, connectionId: 'x_test',
  }
  return { store, row, calls, retry, request, deps }
}

test('retry preserves owner and connection through one persisted start', async t => {
  const q = setup(t)
  const result = await q.retry.resume(q.request)
  assert.equal(result.status, 200)
  assert.equal(result.json.jobId, 'mock_job')
  assert.equal(q.store.get(q.row.id, '42').state, 'recording')
  const resolve = q.calls.find(c => c.kind === 'resolve').args
  const start = q.calls.find(c => c.kind === 'start').args
  assert.equal(resolve.ownerId, '42')
  assert.equal(resolve.accessMode, 'connected_account')
  assert.equal(resolve.xConnectionId, 'x_test')
  assert.equal(start.ownerId, '42')
  assert.equal(start.body.xConnectionId, 'x_test')
})

test('repeated completion returns the saved job without another start', async t => {
  const q = setup(t)
  await q.retry.resume(q.request)
  const again = await q.retry.resume(q.request)
  assert.equal(again.json.reused, true)
  assert.equal(again.json.jobId, 'mock_job')
  assert.equal(q.calls.filter(c => c.kind === 'start').length, 1)
})

test('another request owner cannot cause lookups or a start', async t => {
  const q = setup(t)
  const result = await q.retry.resume({ ...q.request, ownerId: '77' })
  assert.equal(result.status, 404)
  assert.equal(q.calls.length, 0)
})

test('connection owned by someone else is rejected before claiming', async t => {
  const q = setup(t, {
    getConnection: async () => ({
      id: 'x_test', workspace_id: 'telegram:77',
      user_id: '77', status: 'active',
    }),
  })
  assert.equal((await q.retry.resume(q.request)).status, 403)
  assert.equal(q.store.get(q.row.id, '42').state, 'waiting_connection')
  assert.equal(q.calls.length, 0)
})

test('inactive connection does not resolve audio or claim the request', async t => {
  const q = setup(t, {
    getConnection: async () => ({
      id: 'x_test', workspace_id: 'telegram:42',
      user_id: '42', status: 'reauth_required',
    }),
  })
  assert.equal((await q.retry.resume(q.request)).json.code, 'reconnect_required')
  assert.equal(q.store.get(q.row.id, '42').state, 'waiting_connection')
  assert.equal(q.calls.length, 0)
})

test('overlapping retry calls produce only one start', async t => {
  const q = setup(t)
  const results = await Promise.all([
    q.retry.resume(q.request), q.retry.resume(q.request),
  ])
  assert.equal(results.filter(r => r.status === 200).length, 1)
  assert.equal(q.calls.filter(c => c.kind === 'start').length, 1)
})

test('resolution timeout releases only the pre-submission claim', async t => {
  const q = setup(t, {
    resolve: async () => { throw new Error('private network detail') },
  })
  const result = await q.retry.resume(q.request)
  assert.equal(result.json.code, 'resolution_unavailable')
  assert.equal(q.store.get(q.row.id, '42').state, 'waiting_connection')
  assert.equal(q.calls.filter(c => c.kind === 'start').length, 0)
  assert.equal(JSON.stringify(result).includes('private network detail'), false)
})

test('start timeout stays blocked and cannot submit again', async t => {
  let starts = 0
  const q = setup(t, {
    start: async () => { starts++; throw new Error('uncertain response') },
  })
  assert.equal((await q.retry.resume(q.request)).json.code, 'submission_uncertain')
  assert.equal(q.store.get(q.row.id, '42').state, 'submitting')
  assert.equal((await q.retry.resume(q.request)).json.code, 'submission_uncertain')
  assert.equal(starts, 1)
})

test('failure saving an acknowledged job never triggers another start', async t => {
  const q = setup(t)
  q.store.markStarted = () => { throw new Error('storage detail') }
  const result = await q.retry.resume(q.request)
  assert.equal(result.json.code, 'submission_uncertain')
  await q.retry.resume(q.request)
  assert.equal(q.calls.filter(c => c.kind === 'start').length, 1)
  assert.equal(JSON.stringify(result).includes('storage detail'), false)
})
