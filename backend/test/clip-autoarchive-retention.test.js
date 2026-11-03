const test = require('node:test')
const { beforeEach, after } = test
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'clip-retention-'))
process.env.DATABASE_PATH = path.join(directory, 'disposable.db')
const { migrate, getDb, dbQuery } = require('../lib/db')
const { createRetention, HOLD_MS } = require('../lib/retention')
migrate()
const db = getDb()

beforeEach(() => {
  db.prepare('DELETE FROM clips').run()
  db.prepare('DELETE FROM recordings').run()
})
after(() => {
  db.close()
  fs.rmSync(directory, { recursive: true, force: true })
})

const source = fs.readFileSync(
  path.join(__dirname, '../routes/space.js'), 'utf8'
)
function extract(name) {
  const match = new RegExp(
    '^(?:async\\s+)?function\\s+' + name + '\\s*\\(', 'm'
  ).exec(source)
  assert.ok(match)
  const end = source.indexOf('\n}\n', match.index) + 2
  assert.ok(end > match.index)
  return source.slice(match.index, end)
}

function seed({ status = 'queued', archived = false } = {}) {
  db.prepare(`
    INSERT INTO recordings
      (id, name, title, state, duration_seconds)
    VALUES ('parent', 'Parent.m4a', 'Parent', 'ready', 100)
  `).run()
  db.prepare(`
    INSERT INTO clips
      (id, parent_recording_id, title, start_seconds, end_seconds,
       duration_seconds, status, format, size_bytes, enhanced, archived_at)
    VALUES ('clip1', 'parent', 'Clip', 10, 20, 10, ?, 'm4a', 0, 0, ?)
  `).run(status, archived ? '2026-01-01T00:00:00.000Z' : null)
}

function queueFixture({ fail = false, deleteDuringRender = false } = {}) {
  const original = Buffer.from('unchanged-parent-audio')
  const files = new Map([['/virtual/parent.m4a', Buffer.from(original)]])
  const renders = []
  const context = {
    clipQueueBusy: false,
    clipQueueRecovered: false,
    dbQuery, path, DL_DIR: '/virtual',
    console: { log() {}, error() {} },
    recordingFile: () => '/virtual/parent.m4a',
    extractClip: async (input, output, start, end, enhanced) => {
      renders.push({ input, output, start, end, enhanced })
      files.set(output, Buffer.from('completed-clip-audio'))
      if (deleteDuringRender) {
        createRetention(db, () => 1000000).softDelete('clip', 'clip1')
      }
      return !fail
    },
    fs: {
      existsSync: file => files.has(file),
      renameSync(from, to) {
        assert.notEqual(to, '/virtual/parent.m4a')
        assert.ok(files.has(from))
        files.set(to, files.get(from))
        files.delete(from)
      },
      statSync: file => ({ size: files.get(file).length }),
      unlinkSync(file) {
        assert.notEqual(file, '/virtual/parent.m4a')
        files.delete(file)
      },
    },
  }
  const run = vm.runInNewContext(
    '(' + extract('runClipQueue') + ')', context
  )
  return { run, files, original, renders, context }
}

async function archiveList(fixture) {
  const begin = source.indexOf("router.get('/archive',")
  const end = source.indexOf('\n})', begin) + 3
  assert.ok(begin >= 0 && end > begin)
  let handler
  vm.runInNewContext(source.slice(begin, end), {
    router: { get(route, callback) { handler = callback } },
    dbQuery, path, DL_DIR: '/virtual',
    fs: fixture.context.fs,
  })
  let rows
  const res = {
    status(code) { throw new Error('Archive request failed: ' + code) },
    json(value) { rows = value },
  }
  await handler({}, res)
  return rows
}

test('completed clip is automatically archived and has no expiry', async () => {
  seed()
  const fixture = queueFixture()
  await fixture.run()
  const row = db.prepare('SELECT * FROM clips WHERE id=?').get('clip1')
  assert.equal(row.status, 'completed')
  assert.ok(row.archived_at)
  assert.equal(row.expires_at, null)
  assert.equal(row.retention_remaining_seconds, null)
  assert.ok(row.size_bytes > 0)
})

test('completed clip appears directly in the actual archive collection', async () => {
  seed()
  const fixture = queueFixture()
  await fixture.run()
  const rows = await archiveList(fixture)
  const clip = rows.find(row => row.id === 'clip1')
  assert.ok(clip)
  assert.equal(clip.item_kind, 'clip')
  assert.equal(clip.available, true)
})

test('clip rendering does not modify or archive the original recording', async () => {
  seed()
  const fixture = queueFixture()
  await fixture.run()
  assert.deepEqual(fixture.files.get('/virtual/parent.m4a'), fixture.original)
  const parent = db.prepare('SELECT * FROM recordings WHERE id=?').get('parent')
  assert.equal(parent.archived_at, null)
  assert.equal(parent.duration_seconds, 100)
})

test('failed clip rendering does not publish or auto-archive an incomplete clip', async () => {
  seed()
  const fixture = queueFixture({ fail: true })
  await fixture.run()
  const row = db.prepare('SELECT * FROM clips WHERE id=?').get('clip1')
  assert.equal(row.status, 'failed')
  assert.equal(row.archived_at, null)
  assert.equal(fixture.files.has('/virtual/clip1.m4a'), false)
  assert.equal((await archiveList(fixture)).some(row => row.id === 'clip1'), false)
})

test('completion does not cancel or extend a deletion requested during rendering', async () => {
  seed()
  const fixture = queueFixture({ deleteDuringRender: true })
  await fixture.run()
  const row = db.prepare('SELECT * FROM clips WHERE id=?').get('clip1')
  assert.equal(row.status, 'completed')
  assert.ok(row.archived_at)
  assert.equal(Date.parse(row.deleted_at), 1000000)
  assert.equal(Date.parse(row.purge_after), 1000000 + HOLD_MS)
  assert.equal((await archiveList(fixture)).some(row => row.id === 'clip1'), false)
})

test('previously interrupted rendering is not silently rerendered or published', async () => {
  seed({ status: 'rendering' })
  const fixture = queueFixture()
  await fixture.run()
  const row = db.prepare('SELECT * FROM clips WHERE id=?').get('clip1')
  assert.equal(row.status, 'failed')
  assert.equal(fixture.renders.length, 0)
  assert.equal(row.archived_at, null)
})

for (const kind of ['space', 'clip']) {
  test(kind + ': deletion has a two-hour hold and repeated delete does not extend it', () => {
    seed({ status: 'completed', archived: true })
    if (kind === 'space') {
      db.prepare("UPDATE recordings SET archived_at='keep-date' WHERE id='parent'").run()
    }
    let now = 2000000
    const retention = createRetention(db, () => now)
    const id = kind === 'space' ? 'parent' : 'clip1'
    const first = retention.softDelete(kind, id)
    assert.equal(Date.parse(first.purge_after) - Date.parse(first.deleted_at), HOLD_MS)
    now += 60000
    const repeated = retention.softDelete(kind, id)
    assert.equal(repeated.purge_after, first.purge_after)
  })

  test(kind + ': archived item restores before the deadline without gaining an expiry', () => {
    seed({ status: 'completed', archived: true })
    if (kind === 'space') {
      db.prepare("UPDATE recordings SET archived_at='keep-date' WHERE id='parent'").run()
    }
    let now = 2000000
    const retention = createRetention(db, () => now)
    const id = kind === 'space' ? 'parent' : 'clip1'
    const deleted = retention.softDelete(kind, id)
    now = Date.parse(deleted.purge_after) - 1
    const restored = retention.restore(kind, id)
    assert.ok(restored.archived_at)
    assert.equal(restored.deleted_at, null)
    assert.equal(restored.purge_after, null)
    assert.equal(restored.expires_at, null)
  })

  test(kind + ': restoration is refused exactly at the two-hour deadline', () => {
    seed({ status: 'completed', archived: true })
    let now = 2000000
    const retention = createRetention(db, () => now)
    const id = kind === 'space' ? 'parent' : 'clip1'
    const deleted = retention.softDelete(kind, id)
    now = Date.parse(deleted.purge_after)
    assert.throws(() => retention.restore(kind, id), /window has expired/)
    assert.equal(retention.listRestorable().some(
      item => item.id === id && item.item_kind === kind
    ), false)
  })
}

test('restore collection lists both deleted Spaces and clips inside their hold windows', () => {
  seed({ status: 'completed', archived: true })
  const retention = createRetention(db, () => 2000000)
  retention.softDelete('space', 'parent')
  retention.softDelete('clip', 'clip1')
  const kinds = retention.listRestorable().map(row => row.item_kind).sort()
  assert.deepEqual(kinds, ['clip', 'space'])
})

