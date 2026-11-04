const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')
const { createPendingRecordingStore } =
  require('../lib/pending-recording-store')

const input = {
  ownerId: '42', chatId: '42', spaceId: '1rxmqpPayldxy',
}

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pending-store-'))
  const file = path.join(dir, 'test.db')
  const handles = new Set()
  function open() {
    const db = new DatabaseSync(file)
    handles.add(db)
    return { db, store: createPendingRecordingStore(db) }
  }
  function close(db) {
    db.close()
    handles.delete(db)
  }
  t.after(() => {
    for (const db of handles) db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  return { open, close }
}

test('repeated enqueue returns the same active request', t => {
  const q = setup(t)
  const { store } = q.open()
  const first = store.enqueue(input)
  assert.equal(store.enqueue(input).id, first.id)
  assert.equal(first.state, 'waiting_connection')
})

test('pending request survives closing and reopening SQLite', t => {
  const q = setup(t)
  const first = q.open()
  const row = first.store.enqueue(input)
  q.close(first.db)
  assert.equal(q.open().store.get(row.id, '42').space_id, input.spaceId)
})

test('another owner cannot read or claim the request', t => {
  const q = setup(t)
  const { store } = q.open()
  const row = store.enqueue(input)
  assert.equal(store.get(row.id, '77'), null)
  assert.equal(store.claim(row.id, '77', 'x_other'), null)
})

test('two database handles cannot both claim the same request', t => {
  const q = setup(t)
  const a = q.open()
  const b = q.open()
  const row = a.store.enqueue(input)
  assert.ok(a.store.claim(row.id, '42', 'x_test'))
  assert.equal(b.store.claim(row.id, '42', 'x_test'), null)
})

test('incorrect claim token cannot advance a request', t => {
  const q = setup(t)
  const { store } = q.open()
  const row = store.enqueue(input)
  const claimed = store.claim(row.id, '42', 'x_test')
  assert.equal(store.markSubmitting(row.id, '42', 'wrong-token'), null)
  assert.equal(store.get(row.id, '42').state, 'resolving')
  assert.ok(store.markSubmitting(row.id, '42', claimed.claim_token))
})

test('interrupted submission persists and cannot be blindly reclaimed', t => {
  const q = setup(t)
  const first = q.open()
  const row = first.store.enqueue(input)
  const claimed = first.store.claim(row.id, '42', 'x_test')
  first.store.markSubmitting(row.id, '42', claimed.claim_token)
  q.close(first.db)
  const reopened = q.open().store
  assert.equal(reopened.get(row.id, '42').state, 'submitting')
  assert.equal(reopened.claim(row.id, '42', 'x_test'), null)
  assert.equal(reopened.enqueue(input).id, row.id)
})

test('confirmed job identity persists across reopening', t => {
  const q = setup(t)
  const first = q.open()
  const row = first.store.enqueue(input)
  const claimed = first.store.claim(row.id, '42', 'x_test')
  first.store.markSubmitting(row.id, '42', claimed.claim_token)
  assert.ok(first.store.markStarted(
    row.id, '42', claimed.claim_token, 'mock_job'
  ))
  q.close(first.db)
  const saved = q.open().store.get(row.id, '42')
  assert.equal(saved.state, 'recording')
  assert.equal(saved.job_id, 'mock_job')
})

test('private-chat validation and metadata-only storage', t => {
  const q = setup(t)
  const { store, db } = q.open()
  assert.throws(() => store.enqueue({ ...input, chatId: '-100' }))
  assert.throws(() => store.enqueue({ ...input, spaceId: 'invalid' }))
  store.enqueue({ ...input, cookie: 'must-not-be-stored' })
  const rows = db.prepare('SELECT * FROM pending_recording_requests').all()
  assert.equal(rows.length, 1)
  assert.equal(JSON.stringify(rows).includes('must-not-be-stored'), false)
})
