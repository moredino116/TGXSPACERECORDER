const test = require('node:test')
const { beforeEach, after } = test
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'export-retention-'))
const archiveDir = path.join(directory, 'archive')
const exportDir = path.join(directory, 'exports')
fs.mkdirSync(archiveDir)
fs.mkdirSync(exportDir)
process.env.DATABASE_PATH = path.join(directory, 'disposable.db')

const { migrate, getDb } = require('../lib/db')
const { createRetention } = require('../lib/retention')
const { createPurgeWorker } = require('../lib/retention-purge')
const { createExportQueue } = require('../lib/export-jobs')
migrate()
const db = getDb()

let clock, queue, sequence
const cover = Buffer.alloc(24)
Buffer.from([137,80,78,71,13,10,26,10]).copy(cover)
cover.write('IHDR', 12)
cover.writeUInt32BE(1, 16)
cover.writeUInt32BE(1, 20)
const audio = id => path.join(archiveDir, id + '.m4a')
const video = id => path.join(exportDir, id + '.mp4')
const retention = () => createRetention(db, () => clock)

beforeEach(() => {
  clock = Date.now()
  sequence = 0
  queue = createExportQueue({
    db, archiveDir, exportDir,
    now: () => clock, isBusy: () => false,
    renderer: { render() { throw new Error('Rendering is not used in purge tests') } },
  })
  db.prepare('DELETE FROM media_exports').run()
  db.prepare('DELETE FROM clips').run()
  db.prepare('DELETE FROM recordings').run()
  for (const directory of [archiveDir, exportDir]) {
    for (const name of fs.readdirSync(directory)) {
      fs.rmSync(path.join(directory, name), { recursive: true, force: true })
    }
  }
})
after(() => {
  db.close()
  fs.rmSync(directory, { recursive: true, force: true })
})

function seed(kind, id, parent = 'parent') {
  const archived = new Date(clock).toISOString()
  if (kind === 'space') {
    db.prepare(`
      INSERT INTO recordings(id,name,state,archived_at)
      VALUES (?,?,'ready',?)
    `).run(id, id + '.m4a', archived)
  } else {
    db.prepare(`
      INSERT INTO clips
        (id,parent_recording_id,title,start_seconds,end_seconds,
         duration_seconds,status,format,archived_at)
      VALUES (?,?,?,0,10,10,'completed','m4a',?)
    `).run(id, parent, id, archived)
  }
  fs.writeFileSync(audio(id), 'source audio ' + id)
}

function exported(kind, id, status = 'completed') {
  const job = queue.enqueue('telegram:7', {
    requestKey: 'request_' + (++sequence),
    kind, sourceId: id, preset: 'landscape720',
    coverBase64: cover.toString('base64'),
  })
  if (status === 'completed') {
    fs.writeFileSync(video(job.id), 'completed MP4 fixture')
    db.prepare(`
      UPDATE media_exports
      SET status='completed',finished_at=?,size_bytes=?
      WHERE id=?
    `).run(clock, fs.statSync(video(job.id)).size, job.id)
  }
  return job
}

function purge() {
  return createPurgeWorker({
    db, archiveDir, exportDir,
    enabled: true, now: () => clock,
    // Deliberately incomplete: export protection must also work in the worker.
    isBusy: () => false,
  }).runOnce()
}

for (const kind of ['space', 'clip']) {
  test(kind + ': export survives the hold and is removed with permanent source deletion', () => {
    seed(kind, 'target')
    const job = exported(kind, 'target')
    const deletion = retention().softDelete(kind, 'target')
    clock = Date.parse(deletion.purge_after) - 1
    assert.deepEqual(purge(), [])
    assert.ok(fs.existsSync(audio('target')))
    assert.ok(fs.existsSync(video(job.id)))
    assert.ok(queue.get('telegram:7', job.id))

    clock++
    assert.ok(purge().some(row => row.kind === kind && row.action === 'purged'))
    assert.equal(fs.existsSync(audio('target')), false)
    assert.equal(fs.existsSync(video(job.id)), false)
    assert.equal(queue.get('telegram:7', job.id), null)
  })

  test(kind + ': restoration preserves the successful export after the old deadline', () => {
    seed(kind, 'target')
    const job = exported(kind, 'target')
    const expected = fs.readFileSync(video(job.id))
    const deletion = retention().softDelete(kind, 'target')
    clock = Date.parse(deletion.purge_after) - 1000
    retention().restore(kind, 'target')
    clock += 10000
    assert.deepEqual(purge(), [])
    assert.deepEqual(fs.readFileSync(video(job.id)), expected)
    assert.equal(queue.get('telegram:7', job.id).status, 'completed')
  })
}

test('parent purging removes only parent exports and preserves independent clip exports', () => {
  seed('space', 'parent')
  seed('clip', 'saved_clip', 'parent')
  const parentExport = exported('space', 'parent')
  const clipExport = exported('clip', 'saved_clip')
  const expected = fs.readFileSync(video(clipExport.id))
  const deletion = retention().softDelete('space', 'parent')
  clock = Date.parse(deletion.purge_after)
  purge()
  assert.equal(fs.existsSync(video(parentExport.id)), false)
  assert.equal(queue.get('telegram:7', parentExport.id), null)
  assert.ok(fs.existsSync(audio('saved_clip')))
  assert.deepEqual(fs.readFileSync(video(clipExport.id)), expected)
  assert.equal(queue.get('telegram:7', clipExport.id).status, 'completed')
})

test('queued export pins its source even when caller busy check returns false', () => {
  seed('space', 'target')
  const job = exported('space', 'target', 'queued')
  const deletion = retention().softDelete('space', 'target')
  clock = Date.parse(deletion.purge_after)
  assert.deepEqual(purge(), [])
  assert.ok(fs.existsSync(audio('target')))
  assert.equal(queue.get('telegram:7', job.id).status, 'queued')
})

test('purging an export symlink removes the link without removing its outside target', () => {
  seed('space', 'target')
  const job = exported('space', 'target')
  const outside = path.join(directory, 'outside-file')
  fs.writeFileSync(outside, 'preserve outside target')
  fs.unlinkSync(video(job.id))
  fs.symlinkSync(outside, video(job.id))
  const deletion = retention().softDelete('space', 'target')
  clock = Date.parse(deletion.purge_after)
  purge()
  assert.equal(fs.existsSync(video(job.id)), false)
  assert.equal(fs.readFileSync(outside, 'utf8'), 'preserve outside target')
})

test('unverified artifact types block deletion before original files are removed', () => {
  seed('space', 'target')
  const job = exported('space', 'target')
  fs.unlinkSync(video(job.id))
  fs.mkdirSync(video(job.id))
  const deletion = retention().softDelete('space', 'target')
  clock = Date.parse(deletion.purge_after)
  const result = purge()
  assert.ok(result.some(row => row.id === 'target' && row.action === 'retry'))
  assert.ok(fs.existsSync(audio('target')))
  assert.ok(queue.get('telegram:7', job.id))
})


test('removed-export tombstones do not block permanent source deletion', () => {
  seed('space', 'target')
  const job = exported('space', 'target')
  queue.removeExport('telegram:7', job.id)
  const deletion = retention().softDelete('space', 'target')
  clock = Date.parse(deletion.purge_after)
  assert.ok(purge().some(row => row.id === 'target' && row.action === 'purged'))
  assert.equal(fs.existsSync(audio('target')), false)
  assert.equal(queue.get('telegram:7', job.id), null)
})

