const test = require('node:test')
const { beforeEach, after } = test
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const { Writable } = require('node:stream')

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'clip-playback-'))
const archiveDir = path.join(directory, 'archive')
fs.mkdirSync(archiveDir)

process.env.DATABASE_PATH = path.join(directory, 'disposable.db')
process.env.TELEGRAM_BOT_TOKEN = 'isolated-playback-test-token'
process.env.TELEGRAM_ALLOWED_USER_IDS = '7'
process.env.RECORDER_RELAY_KEY = 'isolated-playback-test-relay-key'
process.env.ORACLE_ORIGIN = 'https://recorder.example.com'

const { migrate, getDb, dbQuery } = require('../lib/db')
const { createRetention } = require('../lib/retention')
const { createPurgeWorker } = require('../lib/retention-purge')
const relayGuard = require('../relay-guard')
const playback = require('../../mini-app/api/playback')
migrate()
const db = getDb()

const routeSource = fs.readFileSync(
  path.join(__dirname, '../routes/space.js'), 'utf8'
)

function sourceBlock(start, end, label) {
  const first = routeSource.indexOf(start)
  assert.ok(first >= 0, 'Missing source block: ' + label)
  assert.equal(routeSource.indexOf(start, first + start.length), -1,
    'Ambiguous source block: ' + label)
  const last = routeSource.indexOf(end, first + start.length)
  assert.ok(last >= 0, 'Missing source terminator: ' + label)
  return routeSource.slice(first, last + end.length)
}

const deletionGate = sourceBlock(
  '// Pending-deletion access guard v1\nrouter.use(',
  '\n})',
  'pending-deletion middleware'
)
const rangeServer = sourceBlock(
  'function serveWithRange(req, res, file, contentType) {',
  '\n}',
  'range server'
)
const clipRoute = sourceBlock(
  "router.get('/clip/:id/file',",
  '\n})',
  'clip file route'
)

const captured = {}
const context = vm.createContext({
  fs, path, console,
  DL_DIR: archiveDir,
  retentionDb: getDb,
  dbQuery,
  router: {
    use(handler) {
      assert.equal(captured.availability, undefined)
      captured.availability = handler
    },
    get(route, handler) {
      assert.equal(route, '/clip/:id/file')
      captured.clip = handler
    },
  },
})
vm.runInContext(
  deletionGate + '\n' + rangeServer + '\n' + clipRoute,
  context,
  { filename: 'actual-clip-playback-components.js' }
)
assert.equal(typeof captured.availability, 'function')
assert.equal(typeof captured.clip, 'function')

class Response extends Writable {
  constructor() {
    super()
    this.statusCode = 200
    this.headers = {}
    this.chunks = []
    this.done = new Promise((resolve, reject) => {
      this.once('finish', resolve)
      this.once('error', reject)
    })
  }
  _write(chunk, encoding, callback) {
    this.chunks.push(Buffer.from(chunk))
    callback()
  }
  setHeader(name, value) {
    this.headers[name.toLowerCase()] = String(value)
  }
  status(code) {
    this.statusCode = code
    return this
  }
  json(data) {
    this.setHeader('Content-Type', 'application/json')
    this.end(JSON.stringify(data))
    return this
  }
  bytes() { return Buffer.concat(this.chunks) }
  data() { return JSON.parse(this.bytes().toString()) }
}

let clock
const file = (id, extension = '.m4a') => path.join(archiveDir, id + extension)
const retention = () => createRetention(db, () => clock)

beforeEach(() => {
  db.prepare('DELETE FROM clips').run()
  db.prepare('DELETE FROM recordings').run()
  for (const name of fs.readdirSync(archiveDir)) {
    fs.rmSync(path.join(archiveDir, name), { recursive: true, force: true })
  }
  clock = Date.now()
})

after(() => {
  db.close()
  fs.rmSync(directory, { recursive: true, force: true })
})

function seed() {
  const archived = new Date(clock).toISOString()
  db.prepare(`
    INSERT INTO recordings (id, name, title, state, archived_at)
    VALUES ('parent', 'parent.m4a', 'Parent', 'ready', ?)
  `).run(archived)
  db.prepare(`
    INSERT INTO clips
      (id, parent_recording_id, title, start_seconds, end_seconds,
       duration_seconds, status, format, archived_at)
    VALUES
      ('saved_clip', 'parent', 'Independent clip', 0, 10, 10,
       'completed', 'm4a', ?)
  `).run(archived)
  for (const extension of ['.m4a', '.aac', '.raw']) {
    fs.writeFileSync(file('parent', extension), 'parent-fixture-' + extension)
  }
  const bytes = Buffer.from('fixture-clip-bytes-0123456789')
  fs.writeFileSync(file('saved_clip'), bytes)
  return bytes
}

function purgeParent() {
  const deletion = retention().softDelete('space', 'parent')
  clock = Date.parse(deletion.purge_after)
  const results = createPurgeWorker({
    db, archiveDir, enabled: true,
    now: () => clock, isBusy: () => false,
  }).runOnce()
  assert.ok(results.some(r => r.kind === 'space' && r.action === 'purged'))
  assert.equal(db.prepare(
    "SELECT id FROM recordings WHERE id='parent'"
  ).get(), undefined)
  for (const extension of ['.m4a', '.aac', '.raw']) {
    assert.equal(fs.existsSync(file('parent', extension)), false)
  }
  assert.ok(fs.existsSync(file('saved_clip')))
}

function initData(userId = 7) {
  const params = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1000)),
    user: JSON.stringify({ id: userId, first_name: 'Test' }),
  })
  const text = [...params.entries()]
    .map(([key, value]) => `${key}=${value}`).sort().join('\n')
  const secret = crypto.createHmac('sha256', 'WebAppData')
    .update(process.env.TELEGRAM_BOT_TOKEN).digest()
  params.set('hash', crypto.createHmac('sha256', secret)
    .update(text).digest('hex'))
  return params.toString()
}

async function issue(init = initData()) {
  const res = new Response()
  await playback({
    method: 'POST',
    headers: { 'x-telegram-init-data': init },
    body: { kind: 'clip', id: 'saved_clip' },
  }, res)
  await res.done
  return res
}

async function signedUrl() {
  const res = await issue()
  assert.equal(res.statusCode, 200)
  assert.equal(res.headers['cache-control'], 'no-store')
  const url = new URL(res.data().url)
  assert.equal(url.pathname, '/api/space/clip/saved_clip/file')
  assert.equal(url.href.includes(process.env.RECORDER_RELAY_KEY), false)
  return url
}

async function request(url, range) {
  const res = new Response()
  const req = {
    method: 'GET',
    path: url.pathname.slice('/api'.length),
    query: Object.fromEntries(url.searchParams),
    headers: { 'x-forwarded-proto': 'https' },
    socket: { remoteAddress: '203.0.113.10' },
  }
  if (range) req.headers.range = range
  try {
    relayGuard(req, res, () => {
      req.path = req.path.slice('/space'.length)
      captured.availability(req, res, () => {
        const match = req.path.match(/^\/clip\/([A-Za-z0-9_-]+)\/file$/)
        assert.ok(match)
        req.params = { id: match[1] }
        Promise.resolve(captured.clip(req, res)).catch(error => res.destroy(error))
      })
    })
  } catch (error) {
    res.destroy(error)
  }
  await res.done
  return res
}

test('actual signed clip delivery survives parent row and file purging', async () => {
  const expected = seed()
  const before = db.prepare("SELECT * FROM clips WHERE id='saved_clip'").get()
  purgeParent()
  const res = await request(await signedUrl())
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.bytes(), expected)
  assert.equal(res.headers['content-type'], 'audio/mp4')
  assert.equal(res.headers['cache-control'], 'no-store')
  assert.equal(res.headers['accept-ranges'], 'bytes')
  const after = db.prepare("SELECT * FROM clips WHERE id='saved_clip'").get()
  assert.equal(after.archived_at, before.archived_at)
  assert.equal(after.deleted_at, null)
})

test('surviving clip supports actual byte-range delivery after parent purging', async () => {
  const expected = seed()
  purgeParent()
  const res = await request(await signedUrl(), 'bytes=2-8')
  assert.equal(res.statusCode, 206)
  assert.deepEqual(res.bytes(), expected.subarray(2, 9))
  assert.equal(res.headers['content-range'], `bytes 2-8/${expected.length}`)
  assert.equal(res.headers['content-length'], '7')
})

test('tampered clip signature is rejected before file delivery', async () => {
  seed()
  purgeParent()
  const url = await signedUrl()
  const signature = url.searchParams.get('signature')
  url.searchParams.set('signature',
    (signature[0] === 'a' ? 'b' : 'a') + signature.slice(1))
  const res = await request(url)
  assert.equal(res.statusCode, 401)
  assert.equal(res.headers['content-type'], 'application/json')
})

test('expired clip signature is rejected even when its HMAC is correct', async () => {
  seed()
  purgeParent()
  const url = await signedUrl()
  const expiry = String(Math.floor(Date.now() / 1000) - 1)
  url.searchParams.set('expires', expiry)
  url.searchParams.set('signature',
    crypto.createHmac('sha256', process.env.RECORDER_RELAY_KEY)
      .update(url.pathname + '\n' + expiry).digest('hex'))
  const res = await request(url)
  assert.equal(res.statusCode, 401)
})

test('a surviving clip pending deletion is blocked despite its valid signed URL', async () => {
  seed()
  purgeParent()
  const url = await signedUrl()
  retention().softDelete('clip', 'saved_clip')
  assert.ok(fs.existsSync(file('saved_clip')))
  const res = await request(url)
  assert.equal(res.statusCode, 410)
  assert.equal(res.headers['cache-control'], 'no-store')
  assert.match(res.data().error, /pending deletion/)
})

test('restoring the independent clip restores delivery without its parent', async () => {
  const expected = seed()
  purgeParent()
  const url = await signedUrl()
  retention().softDelete('clip', 'saved_clip')
  clock += 1000
  retention().restore('clip', 'saved_clip')
  const res = await request(url)
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.bytes(), expected)
  const clip = db.prepare("SELECT * FROM clips WHERE id='saved_clip'").get()
  assert.ok(clip.archived_at)
  assert.equal(clip.expires_at, null)
})

test('permanently purged clip is not served through its previously valid URL', async () => {
  seed()
  purgeParent()
  const url = await signedUrl()
  const deletion = retention().softDelete('clip', 'saved_clip')
  clock = Date.parse(deletion.purge_after)
  createPurgeWorker({
    db, archiveDir, enabled: true,
    now: () => clock, isBusy: () => false,
  }).runOnce()
  assert.equal(fs.existsSync(file('saved_clip')), false)
  const res = await request(url)
  assert.equal(res.statusCode, 404)
})

test('actual playback API rejects missing and unapproved Telegram identity', async () => {
  for (const identity of ['', initData(8)]) {
    const res = await issue(identity)
    assert.equal(res.statusCode, 401)
    assert.equal(res.data().url, undefined)
  }
})

test('a valid clip signature cannot be reused for another clip ID', async () => {
  seed()
  purgeParent()
  const url = await signedUrl()
  url.pathname = '/api/space/clip/other_clip/file'
  const res = await request(url)
  assert.equal(res.statusCode, 401)
})

