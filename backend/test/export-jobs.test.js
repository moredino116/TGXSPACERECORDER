const test = require('node:test')
const { beforeEach, after } = test
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const { DatabaseSync } = require('node:sqlite')

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'export-queue-'))
const archiveDir = path.join(directory, 'archive')
const exportDir = path.join(directory, 'exports')
fs.mkdirSync(archiveDir)
fs.mkdirSync(exportDir)
process.env.DATABASE_PATH = path.join(directory, 'disposable.db')
process.env.RECORDER_RELAY_KEY = 'isolated-export-route-key'
process.env.TELEGRAM_ALLOWED_USER_IDS = '7,8'

const { migrate, getDb } = require('../lib/db')
const { createExportQueue, activeExports, attachExportRoutes } = require('../lib/export-jobs')
const { createRetention } = require('../lib/retention')
migrate()
const db = getDb()

let clock, calls, workBusy, renderHook, q
const cover = Buffer.alloc(24)
Buffer.from([137,80,78,71,13,10,26,10]).copy(cover)
cover.write('IHDR', 12)
cover.writeUInt32BE(1, 16)
cover.writeUInt32BE(1, 20)

function queue(database = db, recoveryContext) {
  return createExportQueue({
    db: database, archiveDir, exportDir, recoveryContext,
    now: () => clock, isBusy: () => workBusy,
    renderer: {
      async render(options) {
        calls++
        if (renderHook) await renderHook(options)
        const output = path.join(exportDir, options.id + '.mp4')
        fs.writeFileSync(output, 'simulated completed MP4')
        return { path: output }
      },
    },
  })
}

beforeEach(() => {
  clock = Date.now()
  calls = 0
  workBusy = false
  renderHook = null
  q = queue()
  db.prepare('DELETE FROM media_exports').run()
  db.prepare('DELETE FROM clips').run()
  db.prepare('DELETE FROM recordings').run()
  for (const dir of [archiveDir, exportDir]) {
    for (const name of fs.readdirSync(dir)) {
      fs.rmSync(path.join(dir, name), { recursive: true, force: true })
    }
  }
  db.prepare(`
    INSERT INTO recordings(id,name,state,archived_at)
    VALUES ('parent','parent.m4a','ready',?)
  `).run(new Date(clock).toISOString())
  db.prepare(`
    INSERT INTO clips
      (id,parent_recording_id,title,start_seconds,end_seconds,
       duration_seconds,status,format,archived_at)
    VALUES ('clip1','parent','Clip',0,10,10,'completed','m4a',?)
  `).run(new Date(clock).toISOString())
  fs.writeFileSync(path.join(archiveDir, 'parent.m4a'), 'parent audio')
  fs.writeFileSync(path.join(archiveDir, 'clip1.m4a'), 'clip audio')
})
after(() => {
  db.close()
  fs.rmSync(directory, { recursive: true, force: true })
})

function request(extra = {}) {
  return {
    requestKey: 'request1', kind: 'clip', sourceId: 'clip1',
    preset: 'landscape720', coverBase64: cover.toString('base64'), ...extra,
  }
}

test('export enqueue is owner-scoped and repeated request keys do not duplicate work', () => {
  const first = q.enqueue('telegram:7', request())
  assert.equal(q.enqueue('telegram:7', request()).id, first.id)
  assert.equal(q.get('telegram:8', first.id), null)
  assert.equal(calls, 0)
  assert.equal(activeExports(db), true)
})

test('a repeated export request cannot silently change its format', () => {
  q.enqueue('telegram:7', request())
  assert.throws(() => q.enqueue('telegram:7', request({
    preset: 'landscape1080',
  })), /conflicts/)
})

test('queued export persists across separate SQLite handles', () => {
  const job = q.enqueue('telegram:7', request())
  const secondDb = new DatabaseSync(process.env.DATABASE_PATH)
  try {
    assert.equal(queue(secondDb).get('telegram:7', job.id).status, 'queued')
  } finally {
    secondDb.close()
  }
})

test('busy capture or clip work defers export rendering', async () => {
  const job = q.enqueue('telegram:7', request())
  workBusy = true
  assert.deepEqual(await q.runOnce(), [])
  assert.equal(calls, 0)
  assert.equal(q.get('telegram:7', job.id).status, 'queued')
})

test('independent clip export does not require its parent recording', async () => {
  const job = q.enqueue('telegram:7', request())
  db.prepare("DELETE FROM recordings WHERE id='parent'").run()
  fs.unlinkSync(path.join(archiveDir, 'parent.m4a'))
  await q.runOnce()
  assert.equal(q.get('telegram:7', job.id).status, 'completed')
  assert.equal(calls, 1)
})

test('source deletion before export prevents renderer invocation', async () => {
  const job = q.enqueue('telegram:7', request())
  const deletion = createRetention(db, () => clock).softDelete('clip', 'clip1')
  await q.runOnce()
  assert.equal(calls, 0)
  assert.equal(q.get('telegram:7', job.id).status, 'failed')
  assert.equal(db.prepare(
    "SELECT purge_after FROM clips WHERE id='clip1'"
  ).get().purge_after, deletion.purge_after)
})

test('source deletion during export prevents publication and preserves the hold', async () => {
  const job = q.enqueue('telegram:7', request())
  let deletion
  renderHook = async () => {
    deletion = createRetention(db, () => clock).softDelete('clip', 'clip1')
  }
  await q.runOnce()
  assert.equal(q.get('telegram:7', job.id).status, 'failed')
  assert.equal(fs.existsSync(path.join(exportDir, job.id + '.mp4')), false)
  assert.equal(db.prepare(
    "SELECT purge_after FROM clips WHERE id='clip1'"
  ).get().purge_after, deletion.purge_after)
})

test('two queue instances cannot render the same claimed work concurrently', async () => {
  const job = q.enqueue('telegram:7', request())
  let release, started
  const entered = new Promise(resolve => { started = resolve })
  renderHook = async () => {
    started()
    await new Promise(resolve => { release = resolve })
  }
  const first = q.runOnce()
  await entered
  assert.deepEqual(await queue().runOnce(), [])
  assert.equal(calls, 1)
  release()
  await first
  assert.equal(q.get('telegram:7', job.id).status, 'completed')
})

test('export status excludes cover bytes, owner, and filesystem paths', async () => {
  const job = q.enqueue('telegram:7', request())
  await q.runOnce()
  const result = q.get('telegram:7', job.id)
  assert.deepEqual(Object.keys(result).sort(), [
    'createdAt','finishedAt','id','kind','preset','sizeBytes','sourceId','status',
  ].sort())
  assert.equal(JSON.stringify(result).includes(directory), false)
})

test('invalid export input cannot enqueue work', () => {
  for (const body of [
    request({ sourceId: '../outside' }),
    request({ kind: 'unknown' }),
    request({ preset: 'unknown' }),
    request({ coverBase64: 'not base64' }),
  ]) assert.throws(() => q.enqueue('telegram:7', body))
  assert.equal(activeExports(db), false)
})

test('successful export preserves the original file and retention fields', async () => {
  const before = db.prepare("SELECT * FROM clips WHERE id='clip1'").get()
  const bytes = fs.readFileSync(path.join(archiveDir, 'clip1.m4a'))
  q.enqueue('telegram:7', request())
  await q.runOnce()
  assert.deepEqual(db.prepare("SELECT * FROM clips WHERE id='clip1'").get(), before)
  assert.deepEqual(fs.readFileSync(path.join(archiveDir, 'clip1.m4a')), bytes)
  assert.equal(fs.readdirSync(exportDir).some(n => n.includes('.cover.')), false)
})

function routeHarness(getDatabase = () => db) {
  const handlers = {}
  const router = {
    post(route, ...stack) { handlers['POST ' + route] = stack },
    get(route, ...stack) { handlers['GET ' + route] = stack },
    delete(route, ...stack) { handlers['DELETE ' + route] = stack },
  }
  const service = attachExportRoutes(router, {
    getDb: getDatabase, archiveDir, exportDir,
    ffmpegPath: process.env.TEST_FFMPEG_PATH,
    isBusy: () => true,
  })
  function invoke(method, route, { user = '7', key, body, id, kind, sourceId } = {}) {
    const req = {
      headers: {
        'x-relay-user': user,
        'x-relay-key': key === undefined ? process.env.RECORDER_RELAY_KEY : key,
      },
      body, params: { id, kind, sourceId },
    }
    const res = {
      statusCode: 200, headers: {},
      setHeader(name, value) { this.headers[name] = value },
      status(code) { this.statusCode = code; return this },
      json(value) { this.data = value; return this },
      download(file, name) {
        this.downloadedFile = file
        this.downloadedName = name
        return this
      },
    }
    const stack = handlers[method + ' ' + route]
    let index = 0
    function next() {
      const handler = stack[index++]
      if (handler) return handler(req, res, next)
    }
    next()
    return res
  }
  return { invoke, close: service.close }
}

test('export route authentication runs before queue storage access', () => {
  let accessed = 0
  const h = routeHarness(() => { accessed++; throw new Error('must not access') })
  try {
    const result = h.invoke('POST', '/exports', {
      key: 'wrong-key', body: request(),
    })
    assert.equal(result.statusCode, 403)
    assert.equal(accessed, 0)
  } finally {
    h.close()
  }
})

test('export routes derive ownership from verified headers, not request-body owner', () => {
  const h = routeHarness()
  try {
    const started = h.invoke('POST', '/exports', {
      body: { ...request(), owner: 'telegram:8' },
    })
    assert.equal(started.statusCode, 202)
    const id = started.data.job.id
    assert.equal(h.invoke('GET', '/exports/:id', {
      user: '8', id,
    }).statusCode, 404)
    const owned = h.invoke('GET', '/exports/:id', { user: '7', id })
    assert.equal(owned.statusCode, 200)
    assert.equal(owned.data.job.id, id)
  } finally {
    h.close()
  }
})

test('actual scheduled cleanup busy check includes pending exports', async () => {
  const text = fs.readFileSync(path.join(__dirname, '../routes/space.js'), 'utf8')
  function extract(name) {
    const marker = 'function ' + name + '() {'
    const start = text.indexOf(marker)
    assert.ok(start >= 0)
    const end = text.indexOf('\n}', start)
    assert.ok(end >= 0)
    return text.slice(start, end + 2)
  }
  const check = vm.runInNewContext(
    extract('captureWorkIsBusy') + '\n' +
    extract('retentionWorkIsBusy') + '\nretentionWorkIsBusy',
    {
      jobs: new Map(),
      retentionDb: () => db,
      exportService: { hasWork: () => activeExports(db) },
    }
  )
  assert.equal(check(), false)
  q.enqueue('telegram:7', request())
  assert.equal(check(), true)
  await q.runOnce()
  assert.equal(check(), false)
})


const recoveryMachine = 'a'.repeat(32)
const oldInvocation = 'b'.repeat(32)
const newInvocation = 'c'.repeat(32)
function context(invocation = newInvocation) {
  return {
    unit: 'x-space-recorder.service',
    machine: recoveryMachine,
    invocation,
  }
}
function interrupted(extra = {}) {
  const job = q.enqueue('telegram:7', request(extra))
  db.prepare(`
    UPDATE media_exports
    SET status='rendering',worker_unit=?,worker_machine=?,worker_invocation=?
    WHERE id=?
  `).run('x-space-recorder.service', recoveryMachine, oldInvocation, job.id)
  return job
}

test('verified new service invocation fails interrupted work and removes only its derived artifacts', () => {
  const job = interrupted()
  fs.writeFileSync(path.join(exportDir, job.id + '.mp4'), 'unfinished')
  fs.writeFileSync(path.join(exportDir, job.id + '.cover.png'), cover)
  const scratch = fs.mkdtempSync(path.join(exportDir, '.render-' + job.id + '-'))
  fs.writeFileSync(path.join(scratch, 'output.mp4'), 'partial')
  const before = fs.readFileSync(path.join(archiveDir, 'clip1.m4a'))

  const restarted = queue(db, context())
  const result = restarted.recoverInterrupted()
  assert.equal(result.length, 1)
  assert.equal(result[0].reason, 'interrupted')
  assert.equal(restarted.get('telegram:7', job.id).status, 'failed')
  assert.equal(fs.existsSync(path.join(exportDir, job.id + '.mp4')), false)
  assert.equal(fs.existsSync(scratch), false)
  assert.deepEqual(fs.readFileSync(path.join(archiveDir, 'clip1.m4a')), before)
  assert.equal(db.prepare(
    'SELECT length(cover) AS length FROM media_exports WHERE id=?'
  ).get(job.id).length, 0)
})

test('same service invocation cannot reclaim its own rendering claim', () => {
  const job = interrupted()
  const same = queue(db, context(oldInvocation))
  assert.deepEqual(same.recoverInterrupted(), [])
  assert.equal(same.get('telegram:7', job.id).status, 'rendering')
})

test('missing or mismatched recovery identity leaves claims blocked', () => {
  const job = interrupted()
  db.prepare('UPDATE media_exports SET worker_invocation=NULL WHERE id=?').run(job.id)
  assert.deepEqual(queue(db, context()).recoverInterrupted(), [])
  db.prepare(
    'UPDATE media_exports SET worker_invocation=?,worker_machine=? WHERE id=?'
  ).run(oldInvocation, 'd'.repeat(32), job.id)
  assert.deepEqual(queue(db, context()).recoverInterrupted(), [])
  db.prepare(
    'UPDATE media_exports SET worker_machine=?,worker_unit=? WHERE id=?'
  ).run(recoveryMachine, 'different.service', job.id)
  assert.deepEqual(queue(db, context()).recoverInterrupted(), [])
  assert.equal(q.get('telegram:7', job.id).status, 'rendering')
})

test('interrupted export is not silently rerendered by repeating its request', async () => {
  const job = interrupted()
  const restarted = queue(db, context())
  restarted.recoverInterrupted()
  assert.equal(restarted.enqueue('telegram:7', request()).id, job.id)
  assert.deepEqual(await restarted.runOnce(), [])
  assert.equal(calls, 0)
  assert.equal(restarted.get('telegram:7', job.id).status, 'failed')
})

test('recovery preserves queued work and previously completed exports', () => {
  const lost = interrupted()
  const waiting = q.enqueue('telegram:7', request({ requestKey: 'waiting' }))
  const done = q.enqueue('telegram:7', request({ requestKey: 'done' }))
  db.prepare(
    "UPDATE media_exports SET status='completed',finished_at=? WHERE id=?"
  ).run(clock, done.id)
  const output = path.join(exportDir, done.id + '.mp4')
  fs.writeFileSync(output, 'preserve completed export')
  const restarted = queue(db, context())
  restarted.recoverInterrupted()
  assert.equal(restarted.get('telegram:7', lost.id).status, 'failed')
  assert.equal(restarted.get('telegram:7', waiting.id).status, 'queued')
  assert.equal(restarted.get('telegram:7', done.id).status, 'completed')
  assert.equal(fs.readFileSync(output, 'utf8'), 'preserve completed export')
})

test('unrecognized scratch contents block recovery instead of deleting arbitrary files', () => {
  const job = interrupted()
  const scratch = fs.mkdtempSync(path.join(exportDir, '.render-' + job.id + '-'))
  const unknown = path.join(scratch, 'unexpected.txt')
  fs.writeFileSync(unknown, 'keep')
  const restarted = queue(db, context())
  const result = restarted.recoverInterrupted()
  assert.equal(result[0].reason, 'recovery-blocked')
  assert.equal(restarted.get('telegram:7', job.id).status, 'rendering')
  assert.equal(fs.readFileSync(unknown, 'utf8'), 'keep')
})

test('persisted work wakes the route worker without another browser request', async () => {
  const job = q.enqueue('telegram:7', request())
  let accessed = 0
  const h = routeHarness(() => { accessed++; return db })
  try {
    await new Promise(resolve => setTimeout(resolve, 1750))
    assert.ok(accessed > 0)
    assert.equal(q.get('telegram:7', job.id).status, 'queued')
    assert.equal(calls, 0)
  } finally {
    h.close()
  }
})

test('service recovery identity requires matching invocation and verified group-kill configuration', () => {
  const { readSystemdRecoveryContext } = require('../lib/export-jobs')
  function inspect({
    invocation = newInvocation,
    reported = newInvocation,
    killMode = 'control-group',
    finalKill = 'yes',
    cgroup = '0::/system.slice/x-space-recorder.service',
  } = {}) {
    return readSystemdRecoveryContext({
      env: { INVOCATION_ID: invocation },
      readFile: file => file === '/etc/machine-id' ? recoveryMachine : cgroup,
      exec: () =>
        `KillMode=${killMode}\nSendSIGKILL=${finalKill}\nInvocationID=${reported}\n`,
    })
  }
  assert.deepEqual(inspect(), context())
  assert.equal(inspect({ reported: oldInvocation }), null)
  assert.equal(inspect({ killMode: 'process' }), null)
  assert.equal(inspect({ finalKill: 'no' }), null)
  assert.equal(inspect({ cgroup: '0::/user.slice/unrelated.scope' }), null)
  assert.equal(inspect({ invocation: '' }), null)
})


test('completed export download authorization is owner-scoped and redacted', async () => {
  const job = q.enqueue('telegram:7', request())
  await q.runOnce()
  const result = q.authorizeDownload('telegram:7', job.id)
  assert.equal(result.id, job.id)
  assert.equal(result.available, true)
  assert.equal(result.downloadPath, '/api/space/exports/' + job.id + '/file')
  assert.equal(JSON.stringify(result).includes(directory), false)
  assert.throws(() => q.authorizeDownload('telegram:8', job.id))
})

test('queued and failed exports cannot be authorized or delivered', () => {
  const job = q.enqueue('telegram:7', request())
  assert.throws(() => q.authorizeDownload('telegram:7', job.id))
  assert.throws(() => q.fileForDelivery(job.id))
  db.prepare("UPDATE media_exports SET status='failed' WHERE id=?").run(job.id)
  assert.throws(() => q.authorizeDownload('telegram:7', job.id))
  assert.throws(() => q.fileForDelivery(job.id))
})

test('source deletion blocks export delivery and restoration restores availability', async () => {
  const job = q.enqueue('telegram:7', request())
  await q.runOnce()
  createRetention(db, () => clock).softDelete('clip', 'clip1')
  assert.throws(() => q.authorizeDownload('telegram:7', job.id))
  assert.throws(() => q.fileForDelivery(job.id))
  clock += 1000
  createRetention(db, () => clock).restore('clip', 'clip1')
  assert.equal(q.fileForDelivery(job.id), path.join(exportDir, job.id + '.mp4'))
})

test('missing source prevents serving a leftover export file', async () => {
  const job = q.enqueue('telegram:7', request())
  await q.runOnce()
  db.prepare("DELETE FROM clips WHERE id='clip1'").run()
  assert.throws(() => q.fileForDelivery(job.id))
})

test('export delivery rejects symlinks and changed-size artifacts', async () => {
  const job = q.enqueue('telegram:7', request())
  await q.runOnce()
  const output = path.join(exportDir, job.id + '.mp4')
  fs.unlinkSync(output)
  fs.symlinkSync(path.join(archiveDir, 'clip1.m4a'), output)
  assert.throws(() => q.fileForDelivery(job.id))
  fs.unlinkSync(output)
  fs.writeFileSync(output, 'changed')
  assert.throws(() => q.fileForDelivery(job.id))
})

test('download preflight route rejects another owner and returns only the authorized path', async () => {
  const job = q.enqueue('telegram:7', request())
  await q.runOnce()
  const h = routeHarness()
  try {
    const denied = h.invoke('POST', '/exports/:id/download', { user: '8', id: job.id })
    assert.equal(denied.statusCode, 404)
    const allowed = h.invoke('POST', '/exports/:id/download', { user: '7', id: job.id })
    assert.equal(allowed.statusCode, 200)
    assert.equal(allowed.data.downloadPath, '/api/space/exports/' + job.id + '/file')
  } finally {
    h.close()
  }
})

test('file route selects attachment delivery and rechecks source availability', async () => {
  const job = q.enqueue('telegram:7', request())
  await q.runOnce()
  const h = routeHarness()
  try {
    const ready = h.invoke('GET', '/exports/:id/file', { id: job.id })
    assert.equal(ready.downloadedName, job.id + '.mp4')
    assert.equal(ready.headers['Cache-Control'], 'no-store')
    createRetention(db, () => clock).softDelete('clip', 'clip1')
    assert.equal(h.invoke('GET', '/exports/:id/file', { id: job.id }).statusCode, 404)
  } finally {
    h.close()
  }
})

test('relay guard accepts only valid signed read access to the exact export file', () => {
  const crypto = require('node:crypto')
  const guard = require('../relay-guard')
  const id = 'e' + 'a'.repeat(32)
  for (const [method, pathname, tamper, expected] of [
    ['GET', '/space/exports/' + id + '/file', false, true],
    ['GET', '/space/exports/' + id + '/file', true, false],
    ['POST', '/space/exports/' + id + '/file', false, false],
    ['GET', '/space/exports/' + id, false, false],
  ]) {
    const expires = String(Math.floor(Date.now() / 1000) + 3600)
    let signature = crypto.createHmac('sha256', process.env.RECORDER_RELAY_KEY)
      .update('/api' + pathname + '\n' + expires).digest('hex')
    if (tamper) signature = (signature[0] === 'a' ? 'b' : 'a') + signature.slice(1)
    let passed = false
    const response = {
      status(code) { this.statusCode = code; return this },
      json(value) { this.data = value; return this },
    }
    guard({
      method, path: pathname, query: { expires, signature },
      headers: { 'x-forwarded-proto': 'https' },
      socket: { remoteAddress: '203.0.113.10' },
    }, response, () => { passed = true })
    assert.equal(passed, expected)
    if (!expected) assert.equal(response.statusCode, 401)
  }
})


test('export list contains only the verified owners jobs for the selected source', () => {
  const mine = q.enqueue('telegram:7', request())
  const other = q.enqueue('telegram:8', request())
  assert.deepEqual(q.list('telegram:7', 'clip', 'clip1').map(j => j.id), [mine.id])
  assert.deepEqual(q.list('telegram:8', 'clip', 'clip1').map(j => j.id), [other.id])
  assert.deepEqual(q.list('telegram:7', 'space', 'parent'), [])
})

test('removing an export deletes only its derived file and invalidates delivery', async () => {
  const job = q.enqueue('telegram:7', request())
  await q.runOnce()
  const before = db.prepare("SELECT * FROM clips WHERE id='clip1'").get()
  const bytes = fs.readFileSync(path.join(archiveDir, 'clip1.m4a'))
  assert.equal(q.removeExport('telegram:7', job.id).status, 'removed')
  assert.equal(fs.existsSync(path.join(exportDir, job.id + '.mp4')), false)
  assert.deepEqual(db.prepare("SELECT * FROM clips WHERE id='clip1'").get(), before)
  assert.deepEqual(fs.readFileSync(path.join(archiveDir, 'clip1.m4a')), bytes)
  assert.throws(() => q.fileForDelivery(job.id))
  assert.deepEqual(q.list('telegram:7', 'clip', 'clip1'), [])
})

test('another owner cannot remove a generated export', async () => {
  const job = q.enqueue('telegram:7', request())
  await q.runOnce()
  assert.throws(() => q.removeExport('telegram:8', job.id))
  assert.ok(fs.existsSync(path.join(exportDir, job.id + '.mp4')))
  assert.equal(q.get('telegram:7', job.id).status, 'completed')
})

test('queued and rendering exports cannot be removed by the management action', () => {
  const job = q.enqueue('telegram:7', request())
  assert.throws(() => q.removeExport('telegram:7', job.id))
  db.prepare("UPDATE media_exports SET status='rendering' WHERE id=?").run(job.id)
  assert.throws(() => q.removeExport('telegram:7', job.id))
  assert.equal(q.get('telegram:7', job.id).status, 'rendering')
})

test('removal frees capacity but retains the request tombstone to prevent silent recreation', async () => {
  const first = q.enqueue('telegram:7', request())
  await q.runOnce()
  for (let i = 0; i < 19; i++) {
    q.enqueue('telegram:7', request({ requestKey: 'capacity_' + i }))
  }
  assert.throws(() => q.enqueue('telegram:7', request({ requestKey: 'extra' })))
  q.removeExport('telegram:7', first.id)
  const oldRequest = q.enqueue('telegram:7', request())
  assert.equal(oldRequest.id, first.id)
  assert.equal(oldRequest.status, 'removed')
  assert.equal(q.removeExport('telegram:7', first.id).status, 'removed')
  assert.equal(q.enqueue('telegram:7', request({ requestKey: 'extra' })).status, 'queued')
})

test('management routes isolate source lists and removal by verified owner', async () => {
  const job = q.enqueue('telegram:7', request())
  await q.runOnce()
  const h = routeHarness()
  try {
    const mine = h.invoke('GET', '/exports/source/:kind/:sourceId', {
      kind: 'clip', sourceId: 'clip1',
    })
    assert.equal(mine.statusCode, 200)
    assert.equal(mine.data.jobs[0].id, job.id)
    const other = h.invoke('GET', '/exports/source/:kind/:sourceId', {
      user: '8', kind: 'clip', sourceId: 'clip1',
    })
    assert.deepEqual(other.data.jobs, [])
    assert.equal(h.invoke('DELETE', '/exports/:id', {
      user: '8', id: job.id,
    }).statusCode, 404)
    const removed = h.invoke('DELETE', '/exports/:id', { id: job.id })
    assert.equal(removed.statusCode, 200)
    assert.equal(removed.data.job.status, 'removed')
  } finally {
    h.close()
  }
})

