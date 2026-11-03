const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const { DatabaseSync } = require('node:sqlite')
const {
  ensureRecordingCaptureMetadata, captureMetadata,
} = require('../lib/recording-capture-metadata')
const { SQL } = require('../db/schema')
const { translate } = require('../lib/db')

const routePath = path.join(__dirname, '../routes/space.js')
const source = fs.readFileSync(routePath, 'utf8')
const begin = source.indexOf('async function archiveInsert(job) {')
const end = source.indexOf('\n}\n', begin) + 2
assert.ok(begin >= 0 && end > begin)
const archiveSource = source.slice(begin, end)

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-metadata-'))
  const file = path.join(dir, 'test.db')
  const q = { db: new DatabaseSync(file) }
  q.db.exec(SQL)
  ensureRecordingCaptureMetadata(q.db)
  t.after(() => {
    if (q.db) q.db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  q.archive = vm.runInNewContext('(' + archiveSource + ')', {
    require: createRequire(routePath),
    dbQuery: async (sql, params) => {
      const translated = translate(sql, params)
      q.db.prepare(translated.sql).run(...translated.params)
      return { rows: [] }
    },
    sleep: async () => {},
    console: { error() {} },
  })
  q.reopen = () => {
    q.db.close()
    q.db = new DatabaseSync(file)
  }
  return q
}

function job(extra = {}) {
  return {
    id: 'mock_job', name: 'Mock.m4a', title: 'Mock',
    file: '/virtual/mock.m4a', recordedSecs: 12,
    sizeBytes: 100, enhance: false, kind: 'live',
    captureWarning: 'capture_end_unconfirmed',
    captureStopReason: 'no_new_audio',
    capturedSegments: 2, capturedBytes: 100, gapSeconds: 0,
    ...extra,
  }
}

test('metadata migration is additive and repeatable on an older recording table', () => {
  const db = new DatabaseSync(':memory:')
  try {
    db.exec(`
      CREATE TABLE recordings (id TEXT PRIMARY KEY, title TEXT);
      INSERT INTO recordings VALUES ('old', 'Existing recording');
    `)
    ensureRecordingCaptureMetadata(db)
    ensureRecordingCaptureMetadata(db)
    const row = db.prepare('SELECT * FROM recordings WHERE id=?').get('old')
    assert.equal(row.title, 'Existing recording')
    assert.equal(row.capture_warning, null)
    assert.equal(row.captured_segments, null)
  } finally {
    db.close()
  }
})

test('metadata serialization does not persist arbitrary error or credential text', () => {
  const values = captureMetadata({
    captureWarning: 'private-session-marker',
    captureStopReason: 'https://private.example/token',
    capturedSegments: -1, capturedBytes: NaN, gapSeconds: Infinity,
  })
  assert.deepEqual(values, [null, null, null, null, null])
})

test('actual archive SQL persists warning and successful-audio metrics across reopening', async t => {
  const q = setup(t)
  assert.equal(await q.archive(job()), true)
  q.reopen()
  const row = q.db.prepare('SELECT * FROM recordings WHERE id=?').get('mock_job')
  assert.equal(row.capture_warning, 'capture_end_unconfirmed')
  assert.equal(row.capture_stop_reason, 'no_new_audio')
  assert.equal(row.captured_segments, 2)
  assert.equal(row.captured_bytes, 100)
  assert.equal(row.gap_seconds, 0)
})

test('archive upsert updates capture metadata without resetting retention fields', async t => {
  const q = setup(t)
  for (const name of ['archived_at', 'deleted_at', 'purge_after']) {
    const exists = q.db.prepare('PRAGMA table_info(recordings)').all()
      .some(column => column.name === name)
    if (!exists) q.db.exec(`ALTER TABLE recordings ADD COLUMN ${name} TEXT`)
  }
  assert.equal(await q.archive(job()), true)
  q.db.prepare(`
    UPDATE recordings SET archived_at=?, deleted_at=?, purge_after=? WHERE id=?
  `).run('keep-date', 'delete-date', 'purge-date', 'mock_job')

  assert.equal(await q.archive(job({
    captureWarning: 'missing_audio_segments',
    captureStopReason: 'playlist_end', gapSeconds: 8,
  })), true)

  const row = q.db.prepare('SELECT * FROM recordings WHERE id=?').get('mock_job')
  assert.equal(row.capture_warning, 'missing_audio_segments')
  assert.equal(row.capture_stop_reason, 'playlist_end')
  assert.equal(row.gap_seconds, 8)
  assert.equal(row.archived_at, 'keep-date')
  assert.equal(row.deleted_at, 'delete-date')
  assert.equal(row.purge_after, 'purge-date')
})

