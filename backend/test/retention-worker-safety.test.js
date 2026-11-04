const test = require('node:test')
const { beforeEach, after } = test
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'purge-safety-'))
const archiveDir = path.join(directory, 'archive')
fs.mkdirSync(archiveDir)
process.env.DATABASE_PATH = path.join(directory, 'disposable.db')

const { migrate, getDb } = require('../lib/db')
const { createRetention, HOLD_MS } = require('../lib/retention')
const { createExpiryWorker } = require('../lib/retention-expiry')
const { createPurgeWorker } = require('../lib/retention-purge')
migrate()
const db = getDb()

let clock
beforeEach(() => {
  db.prepare('DELETE FROM clips').run()
  db.prepare('DELETE FROM recordings').run()
  for (const name of fs.readdirSync(archiveDir)) {
    fs.rmSync(path.join(archiveDir, name), { recursive: true, force: true })
  }
  clock = Date.UTC(2026, 0, 1)
})
after(() => {
  db.close()
  fs.rmSync(directory, { recursive: true, force: true })
})

const iso = value => new Date(value).toISOString()
const table = kind => kind === 'space' ? 'recordings' : 'clips'
const file = (id, extension = '.m4a') => path.join(archiveDir, id + extension)
const retention = () => createRetention(db, () => clock)

function seed(kind, id, {
  archived = true,
  expiry = null,
  state,
  parent = 'independent_parent',
  writeFiles = true,
} = {}) {
  const archivedAt = archived ? iso(clock - 100000) : null
  if (kind === 'space') {
    db.prepare(`
      INSERT INTO recordings
        (id, name, title, state, archived_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, id + '.m4a', id, state || 'ready', archivedAt, expiry)
  } else {
    db.prepare(`
      INSERT INTO clips
        (id, parent_recording_id, title, start_seconds, end_seconds,
         duration_seconds, status, format, archived_at, expires_at)
      VALUES (?, ?, ?, 0, 10, 10, ?, 'm4a', ?, ?)
    `).run(id, parent, id, state || 'completed', archivedAt, expiry)
  }
  if (writeFiles) {
    for (const extension of kind === 'space'
      ? ['.m4a', '.aac', '.raw'] : ['.m4a']) {
      fs.writeFileSync(file(id, extension), 'fixture-audio-' + id)
    }
  }
}

function row(kind, id) {
  return db.prepare(`SELECT * FROM ${table(kind)} WHERE id=?`).get(id)
}

function purge({ enabled = true, busy = false } = {}) {
  return createPurgeWorker({
    db, archiveDir, enabled,
    now: () => clock,
    isBusy: () => busy,
  }).runOnce()
}

function expire({ enabled = true, busy = false } = {}) {
  return createExpiryWorker({
    db, enabled,
    now: () => clock,
    isBusy: () => busy,
  }).runOnce()
}

for (const kind of ['space', 'clip']) {
  test(kind + ': files and row survive until the deadline, then purge at the deadline', () => {
    seed(kind, 'target')
    const deleted = retention().softDelete(kind, 'target')
    clock = Date.parse(deleted.purge_after) - 1
    assert.deepEqual(purge(), [])
    assert.ok(row(kind, 'target'))
    assert.ok(fs.existsSync(file('target')))

    clock++
    const results = purge()
    assert.ok(results.some(r => r.kind === kind && r.action === 'purged'))
    assert.equal(row(kind, 'target'), undefined)
    assert.equal(fs.existsSync(file('target')), false)
    if (kind === 'space') {
      assert.equal(fs.existsSync(file('target', '.aac')), false)
      assert.equal(fs.existsSync(file('target', '.raw')), false)
    }
  })

  test(kind + ': restoring cancels eligibility even after the old deadline passes', () => {
    seed(kind, 'target')
    const deleted = retention().softDelete(kind, 'target')
    clock = Date.parse(deleted.purge_after) - 1000
    retention().restore(kind, 'target')
    clock += 10000
    assert.deepEqual(purge(), [])
    assert.ok(row(kind, 'target'))
    assert.ok(fs.existsSync(file('target')))
  })
}

test('purging a Space preserves its independently archived clip and clip file', () => {
  seed('space', 'parent')
  seed('clip', 'saved_clip', { parent: 'parent' })
  const expected = fs.readFileSync(file('saved_clip'))
  const deleted = retention().softDelete('space', 'parent')
  clock = Date.parse(deleted.purge_after)
  purge()

  assert.equal(row('space', 'parent'), undefined)
  assert.ok(row('clip', 'saved_clip'))
  assert.ok(row('clip', 'saved_clip').archived_at)
  assert.equal(row('clip', 'saved_clip').deleted_at, null)
  assert.deepEqual(fs.readFileSync(file('saved_clip')), expected)
})

test('purging a clip leaves its parent recording and files unchanged', () => {
  seed('space', 'parent')
  seed('clip', 'saved_clip', { parent: 'parent' })
  const expected = fs.readFileSync(file('parent'))
  const deleted = retention().softDelete('clip', 'saved_clip')
  clock = Date.parse(deleted.purge_after)
  purge()

  assert.equal(row('clip', 'saved_clip'), undefined)
  assert.ok(row('space', 'parent'))
  assert.deepEqual(fs.readFileSync(file('parent')), expected)
})

test('archived items do not expire merely because an old expiry value exists', () => {
  seed('space', 'old_space', { expiry: iso(clock - 100000) })
  seed('clip', 'old_clip', { expiry: iso(clock - 100000) })
  assert.deepEqual(expire(), [])
  assert.deepEqual(purge(), [])
  assert.equal(row('space', 'old_space').deleted_at, null)
  assert.equal(row('clip', 'old_clip').deleted_at, null)
  assert.ok(fs.existsSync(file('old_space')))
  assert.ok(fs.existsSync(file('old_clip')))
})

test('expiry schedules a fresh two-hour hold rather than immediately deleting files', () => {
  seed('space', 'expired', {
    archived: false, expiry: iso(clock - 1000),
  })
  const results = expire()
  assert.ok(results.some(r => r.action === 'scheduled'))
  const saved = row('space', 'expired')
  assert.equal(Date.parse(saved.purge_after) - Date.parse(saved.deleted_at), HOLD_MS)
  assert.deepEqual(purge(), [])
  assert.ok(fs.existsSync(file('expired')))
})

test('busy check prevents both expiry scheduling and permanent deletion', () => {
  seed('space', 'expired', {
    archived: false, expiry: iso(clock - 1000),
  })
  seed('clip', 'deleted_clip')
  const deleted = retention().softDelete('clip', 'deleted_clip')
  clock = Date.parse(deleted.purge_after)

  assert.deepEqual(expire({ busy: true }), [])
  assert.deepEqual(purge({ busy: true }), [])
  assert.equal(row('space', 'expired').deleted_at, null)
  assert.ok(row('clip', 'deleted_clip'))
  assert.ok(fs.existsSync(file('deleted_clip')))
})

test('purge defaults to dry-run and does not remove an eligible file or row', () => {
  seed('space', 'target')
  const deleted = retention().softDelete('space', 'target')
  clock = Date.parse(deleted.purge_after)

  const results = createPurgeWorker({
    db, archiveDir, now: () => clock, isBusy: () => false,
  }).runOnce()

  assert.ok(results.some(r => r.action === 'would-purge'))
  assert.ok(row('space', 'target'))
  assert.ok(fs.existsSync(file('target')))
})

test('expiry defaults to dry-run and does not schedule deletion', () => {
  seed('space', 'expired', {
    archived: false, expiry: iso(clock - 1000),
  })
  const results = createExpiryWorker({
    db, now: () => clock, isBusy: () => false,
  }).runOnce()
  assert.ok(results.some(r => r.action === 'would-schedule'))
  assert.equal(row('space', 'expired').deleted_at, null)
  assert.ok(fs.existsSync(file('expired')))
})

test('nonterminal recording and rendering states cannot be purged', () => {
  seed('space', 'active_space', { state: 'downloading' })
  seed('clip', 'active_clip', { state: 'rendering' })
  const a = retention().softDelete('space', 'active_space')
  retention().softDelete('clip', 'active_clip')
  clock = Date.parse(a.purge_after)
  assert.deepEqual(purge(), [])
  assert.ok(row('space', 'active_space'))
  assert.ok(row('clip', 'active_clip'))
  assert.ok(fs.existsSync(file('active_space')))
  assert.ok(fs.existsSync(file('active_clip')))
})

test('invalid or shortened hold deadlines are not trusted for deletion', () => {
  seed('space', 'short_hold')
  seed('clip', 'invalid_time')
  db.prepare(`
    UPDATE recordings SET deleted_at=?, purge_after=? WHERE id='short_hold'
  `).run(iso(clock - 3 * 3600000), iso(clock - 2 * 3600000))
  db.prepare(`
    UPDATE clips SET deleted_at=?, purge_after=? WHERE id='invalid_time'
  `).run(iso(clock - 3 * 3600000), 'not-a-timestamp')
  assert.deepEqual(purge(), [])
  assert.ok(fs.existsSync(file('short_hold')))
  assert.ok(fs.existsSync(file('invalid_time')))
})

test('path-traversal item identity is rejected before filesystem deletion', () => {
  const sentinel = path.join(directory, 'escape.m4a')
  fs.writeFileSync(sentinel, 'outside-archive-fixture')
  seed('space', '../escape', { writeFiles: false })
  const deleted = retention().softDelete('space', '../escape')
  clock = Date.parse(deleted.purge_after)
  assert.deepEqual(purge(), [])
  assert.ok(row('space', '../escape'))
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'outside-archive-fixture')
})

test('purging an archive symlink does not delete its target outside the archive', () => {
  seed('clip', 'linked', { writeFiles: false })
  const sentinel = path.join(directory, 'symlink-target')
  fs.writeFileSync(sentinel, 'preserve-target')
  fs.symlinkSync(sentinel, file('linked'))
  const deleted = retention().softDelete('clip', 'linked')
  clock = Date.parse(deleted.purge_after)
  purge()
  assert.equal(row('clip', 'linked'), undefined)
  assert.equal(fs.existsSync(file('linked')), false)
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'preserve-target')
})

test('workers refuse construction without an explicit busy-check function', () => {
  assert.throws(() => createPurgeWorker({ db, archiveDir }), /busy check/)
  assert.throws(() => createExpiryWorker({ db }), /busy check/)
})
