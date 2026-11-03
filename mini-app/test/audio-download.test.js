const test = require('node:test')
const { beforeEach, after } = test
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const playback = require('../api/playback')

const names = [
  'TELEGRAM_BOT_TOKEN', 'TELEGRAM_ALLOWED_USER_IDS',
  'RECORDER_RELAY_KEY', 'ORACLE_ORIGIN',
]
const saved = Object.fromEntries(names.map(name => [name, process.env[name]]))

beforeEach(() => {
  process.env.TELEGRAM_BOT_TOKEN = 'isolated-download-token'
  process.env.TELEGRAM_ALLOWED_USER_IDS = '7'
  process.env.RECORDER_RELAY_KEY = 'isolated-download-relay-key'
  process.env.ORACLE_ORIGIN = 'https://recorder.example.com'
})
after(() => {
  for (const name of names) {
    if (saved[name] === undefined) delete process.env[name]
    else process.env[name] = saved[name]
  }
})

function identity(userId = 7) {
  const params = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1000)),
    user: JSON.stringify({ id: userId }),
  })
  const text = [...params.entries()]
    .map(([key, value]) => `${key}=${value}`).sort().join('\n')
  const secret = crypto.createHmac('sha256', 'WebAppData')
    .update(process.env.TELEGRAM_BOT_TOKEN).digest()
  params.set('hash', crypto.createHmac('sha256', secret)
    .update(text).digest('hex'))
  return params.toString()
}

async function issue(body, init = identity(), method = 'POST') {
  const res = {
    statusCode: 200, headers: {},
    setHeader(name, value) { this.headers[name.toLowerCase()] = value },
    status(code) { this.statusCode = code; return this },
    json(data) { this.data = data; return this },
  }
  await playback({
    method, body, headers: { 'x-telegram-init-data': init },
  }, res)
  return res
}

for (const kind of ['space', 'clip']) {
  test(kind + ' download is signed for its exact file endpoint', async () => {
    const res = await issue({ kind, id: 'selected_item', download: true })
    assert.equal(res.statusCode, 200)
    const url = new URL(res.data.url)
    const pathname = kind === 'clip'
      ? '/api/space/clip/selected_item/file'
      : '/api/space/file/selected_item'
    assert.equal(url.pathname, pathname)
    assert.equal(url.searchParams.has('play'), false)
    assert.equal(url.searchParams.get('download'), '1')
    const expected = crypto.createHmac('sha256', process.env.RECORDER_RELAY_KEY)
      .update(pathname + '\n' + url.searchParams.get('expires')).digest('hex')
    assert.equal(url.searchParams.get('signature'), expected)
    assert.equal(url.href.includes(process.env.RECORDER_RELAY_KEY), false)
    assert.equal(res.headers['cache-control'], 'no-store')
  })

  test(kind + ' ordinary playback retains its original endpoint and play mode', async () => {
    const res = await issue({ kind, id: 'selected_item' })
    assert.equal(res.statusCode, 200)
    const url = new URL(res.data.url)
    assert.equal(url.pathname, kind === 'clip'
      ? '/api/space/clip/selected_item/file'
      : '/api/space/preview/selected_item')
    assert.equal(url.searchParams.get('play'), '1')
    assert.equal(url.searchParams.has('download'), false)
  })
}

test('download signing rejects missing or unapproved identity', async () => {
  for (const init of ['', identity(8)]) {
    const res = await issue({ kind: 'clip', id: 'item', download: true }, init)
    assert.equal(res.statusCode, 401)
    assert.equal(res.data.url, undefined)
  }
})

test('download flag must be a boolean', async () => {
  for (const download of ['true', 1, null, {}, []]) {
    const res = await issue({ kind: 'clip', id: 'item', download })
    assert.equal(res.statusCode, 400)
    assert.equal(res.data.url, undefined)
  }
})

test('download signing rejects traversal and unknown item kinds', async () => {
  for (const body of [
    { kind: 'clip', id: '../outside', download: true },
    { kind: 'other', id: 'item', download: true },
  ]) {
    const res = await issue(body)
    assert.equal(res.statusCode, 400)
    assert.equal(res.data.url, undefined)
  }
})

test('download signing rejects non-POST requests', async () => {
  const res = await issue(
    { kind: 'clip', id: 'item', download: true }, identity(), 'GET'
  )
  assert.equal(res.statusCode, 405)
  assert.equal(res.data.url, undefined)
})


const vm = require('node:vm')
const fs = require('node:fs')
const path = require('node:path')

function actualFileHandler(route) {
  const source = fs.readFileSync(
    path.join(__dirname, '../../backend/routes/space.js'), 'utf8'
  )
  const marker = "router.get('" + route + "',"
  const start = source.indexOf(marker)
  assert.ok(start >= 0, 'Missing file handler')
  assert.equal(source.indexOf(marker, start + marker.length), -1)
  const end = source.indexOf('\n})', start)
  assert.ok(end >= 0)

  let handler
  const context = vm.createContext({
    path,
    fs: { existsSync: () => true },
    jobs: new Map(),
    DL_DIR: '/simulated-download-fixture',
    dbQuery: async () => ({ rows: [] }),
    serveWithRange() {
      throw new Error('Download must not use inline range playback')
    },
    router: {
      get(actualRoute, fn) {
        assert.equal(actualRoute, route)
        handler = fn
      },
    },
  })
  vm.runInContext(source.slice(start, end + '\n})'.length), context)
  assert.equal(typeof handler, 'function')
  return handler
}

for (const kind of ['space', 'clip']) {
  test(kind + ' signed download selects the actual file handler attachment branch', async () => {
    const signed = await issue({
      kind, id: 'selected_item', download: true,
    })
    assert.equal(signed.statusCode, 200)
    const url = new URL(signed.data.url)
    const handler = actualFileHandler(
      kind === 'clip' ? '/clip/:id/file' : '/file/:id'
    )

    let disposition
    let selectedFile
    const response = {
      download(file) {
        disposition = 'attachment'
        selectedFile = file
        return this
      },
      sendFile() {
        disposition = 'inline'
        return this
      },
      status() { return this },
      json() { throw new Error('Unexpected missing-file response') },
    }

    await handler({
      params: { id: 'selected_item' },
      query: Object.fromEntries(url.searchParams),
      headers: {},
    }, response)

    assert.equal(disposition, 'attachment')
    assert.equal(path.basename(selectedFile), 'selected_item.m4a')
  })
}

