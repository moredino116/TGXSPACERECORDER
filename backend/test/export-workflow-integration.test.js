const test = require('node:test')
const { after } = test
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { Writable } = require('node:stream')
const { execFileSync } = require('node:child_process')

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'export-workflow-'))
const archiveDir = path.join(directory, 'archive')
const exportDir = path.join(directory, 'exports')
fs.mkdirSync(archiveDir)
fs.mkdirSync(exportDir)

process.env.DATABASE_PATH = path.join(directory, 'disposable.db')
process.env.TELEGRAM_BOT_TOKEN = 'isolated-workflow-token'
process.env.TELEGRAM_ALLOWED_USER_IDS = '7,8'
process.env.RECORDER_RELAY_KEY = 'isolated-workflow-relay-key'
process.env.ORACLE_ORIGIN = 'https://recorder.example.test'

const { migrate, getDb } = require('../lib/db')
const { attachExportRoutes } = require('../lib/export-jobs')
const { createRetention } = require('../lib/retention')
const { createPurgeWorker } = require('../lib/retention-purge')
const relayGuard = require('../relay-guard')
const relay = require('../../mini-app/api/relay')
const signer = require('../../mini-app/api/export-download')
migrate()
const db = getDb()

let service
const originalFetch = globalThis.fetch
after(() => {
  service?.close()
  globalThis.fetch = originalFetch
  db.close()
  fs.rmSync(directory, { recursive: true, force: true })
})

const ffmpeg = process.env.TEST_FFMPEG_PATH
assert.ok(ffmpeg && fs.existsSync(ffmpeg))
const env = {
  PATH: process.env.PATH || '/usr/bin:/bin',
  LANG: 'C', TMPDIR: directory,
}
const audio = path.join(archiveDir, 'clip1.m4a')
const cover = path.join(directory, 'cover.png')

execFileSync(ffmpeg, [
  '-hide_banner', '-loglevel', 'error', '-nostdin',
  '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono',
  '-t', '1', '-c:a', 'aac', '-threads', '1', audio,
], { timeout: 10000, env, stdio: 'pipe' })
execFileSync(ffmpeg, [
  '-hide_banner', '-loglevel', 'error', '-nostdin',
  '-f', 'lavfi', '-i', 'color=c=0x00e5d1:s=320x180',
  '-frames:v', '1', '-threads', '1', cover,
], { timeout: 10000, env, stdio: 'pipe' })

const hash = file => crypto.createHash('sha256')
  .update(fs.readFileSync(file)).digest('hex')
const audioHash = hash(audio)
let clock = Date.now()
const archived = new Date(clock).toISOString()

db.prepare(`
  INSERT INTO recordings(id,name,state,archived_at)
  VALUES ('parent','parent.m4a','ready',?)
`).run(archived)
db.prepare(`
  INSERT INTO clips
    (id,parent_recording_id,title,start_seconds,end_seconds,
     duration_seconds,status,format,archived_at)
  VALUES ('clip1','parent','Synthetic clip',0,1,1,'completed','m4a',?)
`).run(archived)
fs.copyFileSync(audio, path.join(archiveDir, 'parent.m4a'))

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
  status(code) { this.statusCode = code; return this }
  setHeader(name, value) {
    this.headers[name.toLowerCase()] = String(value)
    return this
  }
  json(value) {
    this.setHeader('Content-Type', 'application/json')
    this.end(JSON.stringify(value))
    return this
  }
  send(value) {
    this.end(Buffer.isBuffer(value) ? value : String(value))
    return this
  }
  download(file, name) {
    this.setHeader('Content-Disposition', 'attachment; filename="' + name + '"')
    fs.createReadStream(file).on('error', error => this.destroy(error)).pipe(this)
    return this
  }
  bytes() { return Buffer.concat(this.chunks) }
  data() { return JSON.parse(this.bytes().toString()) }
}

const registered = []
const router = {}
for (const method of ['GET', 'POST', 'DELETE']) {
  router[method.toLowerCase()] = (route, ...handlers) => {
    const keys = []
    const parts = route.split('/').map(part => {
      if (part.startsWith(':')) {
        keys.push(part.slice(1))
        return '([^/]+)'
      }
      return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    })
    registered.push({
      method, keys, pattern: new RegExp('^' + parts.join('/') + '$'), handlers,
    })
  }
}
service = attachExportRoutes(router, {
  getDb: () => db, archiveDir, exportDir,
  ffmpegPath: ffmpeg, rendererTimeoutMs: 10000,
  isBusy: () => false,
})

async function stack(handlers, req, res, index = 0) {
  const handler = handlers[index]
  if (!handler) return
  let continuation
  const result = handler(req, res, () => {
    continuation = stack(handlers, req, res, index + 1)
    return continuation
  })
  await result
  if (continuation && continuation !== result) await continuation
}

async function backend(value, options = {}) {
  const url = new URL(String(value))
  assert.equal(url.origin, process.env.ORACLE_ORIGIN)
  assert.ok(url.pathname.startsWith('/api/space/exports'))
  const res = new Response()
  const req = {
    method: options.method || 'GET',
    path: url.pathname.slice('/api'.length),
    query: Object.fromEntries(url.searchParams),
    headers: {
      'x-forwarded-proto': 'https',
      ...Object.fromEntries(Object.entries(options.headers || {})
        .map(([key, value]) => [key.toLowerCase(), value])),
    },
    socket: { remoteAddress: '203.0.113.10' },
    body: options.body ? JSON.parse(options.body) : undefined,
  }
  try {
    await relayGuard(req, res, async () => {
      req.path = url.pathname.slice('/api/space'.length)
      const route = registered.find(item =>
        item.method === req.method && item.pattern.test(req.path))
      if (!route) return res.status(404).json({ error: 'No matching test route' })
      const match = req.path.match(route.pattern)
      req.params = Object.fromEntries(route.keys.map(
        (key, index) => [key, decodeURIComponent(match[index + 1])]
      ))
      return stack(route.handlers, req, res)
    })
  } catch (error) {
    res.destroy(error)
  }
  await res.done
  return res
}

globalThis.fetch = async (url, options) => {
  const result = await backend(url, options)
  const bytes = result.bytes()
  return {
    ok: result.statusCode >= 200 && result.statusCode < 300,
    status: result.statusCode,
    headers: { get: name => result.headers[name.toLowerCase()] || null },
    json: async () => JSON.parse(bytes.toString()),
    arrayBuffer: async () =>
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  }
}

function identity(userId = 7) {
  const params = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1000)),
    user: JSON.stringify({ id: userId }),
  })
  const text = [...params.entries()].map(
    ([key, value]) => key + '=' + value).sort().join('\n')
  const secret = crypto.createHmac('sha256', 'WebAppData')
    .update(process.env.TELEGRAM_BOT_TOKEN).digest()
  params.set('hash', crypto.createHmac('sha256', secret)
    .update(text).digest('hex'))
  return params.toString()
}

async function throughRelay(method, pathname, body, user = 7) {
  const res = new Response()
  await relay({
    method, query: { path: pathname }, body,
    headers: { 'x-telegram-init-data': identity(user) },
  }, res)
  await res.done
  return res
}
async function signed(id, user = 7) {
  const res = new Response()
  await signer({
    method: 'POST', body: { id },
    headers: { 'x-telegram-init-data': identity(user) },
  }, res)
  await res.done
  return res
}

test('real relay queue FFmpeg signer and file delivery work together for an independent clip', async () => {
  // Purge the parent first; only the clip should be needed thereafter.
  const retention = createRetention(db, () => clock)
  const parentDelete = retention.softDelete('space', 'parent')
  clock = Date.parse(parentDelete.purge_after)
  const purge = () => createPurgeWorker({
    db, archiveDir, exportDir,
    enabled: true, now: () => clock, isBusy: () => false,
  }).runOnce()
  purge()
  assert.equal(db.prepare("SELECT id FROM recordings WHERE id='parent'").get(), undefined)
  assert.ok(fs.existsSync(audio))
  const clipBefore = db.prepare("SELECT * FROM clips WHERE id='clip1'").get()

  const payload = {
    requestKey: 'native-workflow-1',
    kind: 'clip', sourceId: 'clip1', preset: 'landscape720',
    coverBase64: fs.readFileSync(cover).toString('base64'),
  }
  const submitted = await throughRelay('POST', 'space/exports', payload)
  assert.equal(submitted.statusCode, 202)
  assert.equal(submitted.headers['cache-control'], 'no-store')
  const id = submitted.data().job.id
  const repeated = await throughRelay('POST', 'space/exports', payload)
  assert.equal(repeated.data().job.id, id)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM media_exports').get().count, 1)

  let status
  const deadline = Date.now() + 45000
  do {
    const response = await throughRelay('GET', 'space/exports/' + id)
    assert.equal(response.statusCode, 200)
    status = response.data().job.status
    if (status === 'completed' || status === 'failed') break
    await new Promise(resolve => setTimeout(resolve, 100))
  } while (Date.now() < deadline)
  assert.equal(status, 'completed', 'Native queued rendering must complete')

  assert.equal(hash(audio), audioHash)
  assert.deepEqual(db.prepare("SELECT * FROM clips WHERE id='clip1'").get(), clipBefore)

  const denied = await signed(id, 8)
  assert.equal(denied.statusCode, 404)
  assert.equal(denied.data().url, undefined)

  const authorization = await signed(id)
  assert.equal(authorization.statusCode, 200)
  const url = new URL(authorization.data().url)
  assert.equal(url.pathname, '/api/space/exports/' + id + '/file')
  const delivered = await backend(url)
  assert.equal(delivered.statusCode, 200)
  assert.equal(delivered.headers['content-type'], 'video/mp4')
  assert.match(delivered.headers['content-disposition'], /^attachment;/)
  assert.equal(delivered.headers['cache-control'], 'no-store')
  assert.deepEqual(delivered.bytes(), fs.readFileSync(path.join(exportDir, id + '.mp4')))

  const received = path.join(directory, 'received.mp4')
  fs.writeFileSync(received, delivered.bytes())
  execFileSync(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    '-threads', '1', '-protocol_whitelist', 'file',
    '-i', received, '-map', '0:v:0', '-map', '0:a:0',
    '-threads', '1', '-f', 'null', '-',
  ], { timeout: 10000, env, stdio: 'pipe' })

  const tampered = new URL(url)
  const signature = tampered.searchParams.get('signature')
  tampered.searchParams.set('signature',
    (signature[0] === 'a' ? 'b' : 'a') + signature.slice(1))
  assert.equal((await backend(tampered)).statusCode, 401)

  const expiry = new URL(url)
  const expiredAt = String(Math.floor(Date.now() / 1000) - 1)
  expiry.searchParams.set('expires', expiredAt)
  expiry.searchParams.set('signature', crypto.createHmac(
    'sha256', process.env.RECORDER_RELAY_KEY
  ).update(expiry.pathname + '\n' + expiredAt).digest('hex'))
  assert.equal((await backend(expiry)).statusCode, 401)

  retention.softDelete('clip', 'clip1')
  assert.equal((await backend(url)).statusCode, 404)
  assert.ok(fs.existsSync(path.join(exportDir, id + '.mp4')))
  clock += 1000
  retention.restore('clip', 'clip1')
  assert.deepEqual((await backend(url)).bytes(), delivered.bytes())

  const removed = await throughRelay('DELETE', 'space/exports/' + id)
  assert.equal(removed.statusCode, 200)
  assert.equal(removed.data().job.status, 'removed')
  assert.equal((await backend(url)).statusCode, 404)
  assert.equal(hash(audio), audioHash)

  const deletion = retention.softDelete('clip', 'clip1')
  clock = Date.parse(deletion.purge_after)
  assert.ok(purge().some(item => item.kind === 'clip' && item.action === 'purged'))
  assert.equal(fs.existsSync(audio), false)
  assert.equal(db.prepare('SELECT id FROM media_exports WHERE id=?').get(id), undefined)
})

