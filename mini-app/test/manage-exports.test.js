const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { webcrypto } = require('node:crypto')

const source = fs.readFileSync(path.join(__dirname, '../public/manage-exports.js'), 'utf8')
const existingId = 'e' + 'a'.repeat(32)
function job(status = 'completed', extra = {}) {
  return {
    id: existingId, kind: 'clip', sourceId: 'clip1',
    preset: 'landscape720', status, ...extra,
  }
}
class Node {
  constructor(tag) {
    this.tag = tag
    this.children = []
    this.attributes = {}
    this.className = ''
    this.textContent = ''
    this.value = ''
    this.files = []
  }
  append(...nodes) {
    for (const node of nodes) {
      this.children.push(node)
      node.parentNode = this
    }
  }
  replaceChildren(...nodes) {
    for (const node of this.children) node.parentNode = null
    this.children = []
    this.append(...nodes)
  }
  setAttribute(name, value) { this.attributes[name] = value }
}
const png = Buffer.alloc(24)
Buffer.from([137,80,78,71,13,10,26,10]).copy(png)
png.write('IHDR', 12)
png.writeUInt32BE(1, 16)
png.writeUInt32BE(1, 20)

async function setup({
  jobs: initial = [], initData = 'mock-init',
  lostReceipt = false,
} = {}) {
  const main = new Node('main')
  const audio = new Node('audio')
  audio.src = 'https://recorder.example/selected-audio'
  const sharing = new Node('section')
  sharing.className = 'share-tools'
  main.append(audio, sharing)
  const walk = node => [node, ...node.children.flatMap(walk)]
  const jobs = initial.map(value => ({ ...value }))
  const byKey = new Map()
  const requests = []
  const timers = new Map()
  let timerId = 0
  const document = {
    querySelector: selector => selector === '.share-tools' ? sharing : null,
    createElement: tag => new Node(tag),
    documentElement: { contains: node => walk(main).includes(node) },
  }
  const fetch = async (url, options) => {
    const body = options.body ? JSON.parse(options.body) : undefined
    requests.push({ url, method: options.method, body, headers: options.headers })
    let data
    if (url.startsWith('/relay/space/exports/source/') && options.method === 'GET') {
      data = { ok: true, jobs: jobs.filter(value => value.status !== 'removed') }
    } else if (url === '/relay/space/exports' && options.method === 'POST') {
      let saved = byKey.get(body.requestKey)
      if (!saved) {
        saved = job('queued', {
          id: 'e' + String(jobs.length + 1).padStart(32, '0'),
          kind: body.kind, sourceId: body.sourceId, preset: body.preset,
        })
        byKey.set(body.requestKey, saved)
        jobs.push(saved)
      }
      if (lostReceipt) {
        lostReceipt = false
        throw new Error('Simulated lost receipt after acceptance')
      }
      data = { ok: true, job: saved }
    } else if (url === '/api/export-download') {
      data = {
        url: 'https://recorder.example/api/space/exports/' + body.id +
          '/file?expires=9999999999&signature=mock',
        expires: 9999999999,
      }
    } else if (options.method === 'DELETE') {
      const id = url.split('/').at(-1)
      const saved = jobs.find(value => value.id === id)
      assert.ok(saved)
      saved.status = 'removed'
      data = { ok: true, job: saved }
    } else {
      throw new Error('Unexpected mocked export request')
    }
    return { ok: true, json: async () => JSON.parse(JSON.stringify(data)) }
  }

  await new vm.Script(source).runInNewContext({
    document,
    location: { search: '?manage=clip&id=clip1' },
    window: { Telegram: { WebApp: { initData } }, addEventListener() {} },
    URL, URLSearchParams, AbortController, TextEncoder,
    crypto: webcrypto,
    btoa: text => Buffer.from(text, 'binary').toString('base64'),
    fetch,
    setTimeout: (fn, ms) => {
      const id = ++timerId
      timers.set(id, { fn, ms })
      return id
    },
    clearTimeout: id => timers.delete(id),
  })

  const all = () => walk(main)
  const button = label => {
    const found = all().find(n => n.tag === 'button' && n.textContent === label)
    assert.ok(found, 'Missing button: ' + label)
    return found
  }
  return {
    all, jobs, requests, audio, main,
    text: () => all().map(n => n.textContent).join('\n'),
    choose(bytes = png, size = bytes.length) {
      const input = all().find(n => n.attributes['aria-label'] === 'Export cover')
      input.files = [{
        size, type: 'image/png',
        arrayBuffer: async () => Uint8Array.from(bytes).buffer,
      }]
    },
    submit: () => all().find(n => n.tag === 'form').onsubmit({ preventDefault() {} }),
    click: label => button(label).onclick(),
    async poll() {
      const entry = [...timers.entries()].find(([, timer]) => timer.ms === 3000)
      assert.ok(entry, 'Missing scheduled status refresh')
      timers.delete(entry[0])
      await entry[1].fn()
    },
  }
}

test('export UI mounts inside sharing and initially requests only the selected source list', async () => {
  const q = await setup()
  assert.equal(q.audio.parentNode, q.main)
  assert.equal(q.audio.src, 'https://recorder.example/selected-audio')
  assert.equal(q.requests.length, 1)
  assert.equal(q.requests[0].method, 'GET')
  assert.equal(q.requests[0].url, '/relay/space/exports/source/clip/clip1')
  assert.ok(q.all().some(n => n.attributes['aria-label'] === 'Export cover'))
})

test('cover submission sends the selected source preset and stable bounded request key', async () => {
  const q = await setup()
  q.choose()
  await q.submit()
  const post = q.requests.find(r => r.method === 'POST')
  assert.equal(post.url, '/relay/space/exports')
  assert.equal(post.body.kind, 'clip')
  assert.equal(post.body.sourceId, 'clip1')
  assert.equal(post.body.preset, 'landscape720')
  assert.equal(post.body.coverBase64, png.toString('base64'))
  assert.match(post.body.requestKey, /^export_[a-f0-9]{64}$/)
  assert.ok(q.text().includes('Server confirmed export'))
})

test('lost receipt retry reuses its request key instead of creating duplicate work', async () => {
  const q = await setup({ lostReceipt: true })
  q.choose()
  await q.submit()
  assert.ok(q.text().includes('submission was not confirmed'))
  await q.submit()
  const posts = q.requests.filter(r => r.method === 'POST')
  assert.equal(posts.length, 2)
  assert.equal(posts[0].body.requestKey, posts[1].body.requestKey)
  assert.equal(q.jobs.length, 1)
})

test('missing oversized and unsupported covers do not submit export jobs', async () => {
  for (const variant of ['missing', 'oversized', 'invalid']) {
    const q = await setup()
    if (variant === 'oversized') q.choose(png, 1048577)
    if (variant === 'invalid') q.choose(Buffer.from('not an image'))
    await q.submit()
    assert.equal(q.requests.some(r => r.method === 'POST'), false)
  }
})

test('status polling displays server states without submitting another render', async () => {
  const q = await setup({ jobs: [job('queued')] })
  assert.ok(q.text().includes('Queued on server'))
  q.jobs[0].status = 'rendering'
  await q.poll()
  assert.ok(q.text().includes('Rendering on server.'))
  q.jobs[0].status = 'completed'
  await q.poll()
  assert.ok(q.text().includes('MP4 completed.'))
  assert.equal(q.requests.some(r => r.method === 'POST'), false)
})

test('MP4 preparation uses the owner-verified signing API and preserves the selected audio', async () => {
  const q = await setup({ jobs: [job()] })
  await q.click('Prepare MP4 download')
  const signing = q.requests.find(r => r.url === '/api/export-download')
  assert.deepEqual(signing.body, { id: existingId })
  const link = q.all().find(n => n.tag === 'a' && n.textContent === 'Download MP4')
  assert.equal(new URL(link.href).pathname, '/api/space/exports/' + existingId + '/file')
  assert.equal(q.audio.src, 'https://recorder.example/selected-audio')
})

test('export removal targets only the generated export and refreshes its list', async () => {
  const q = await setup({ jobs: [job()] })
  await q.click('Remove generated MP4')
  const removal = q.requests.find(r => r.method === 'DELETE')
  assert.equal(removal.url, '/relay/space/exports/' + existingId)
  assert.equal(q.jobs[0].status, 'removed')
  assert.equal(q.audio.src, 'https://recorder.example/selected-audio')
})

test('an explicit failed-job retry uses a stable new-attempt key', async () => {
  const q = await setup({ jobs: [job('failed')] })
  await q.click('Retry with cover')
  q.choose()
  await q.submit()
  await q.submit()
  const posts = q.requests.filter(r => r.method === 'POST')
  assert.match(posts[0].body.requestKey, new RegExp('^retry_' + existingId + '_[a-f0-9]{32}$'))
  assert.equal(posts[0].body.requestKey, posts[1].body.requestKey)
  assert.equal(q.jobs.length, 2)
})

test('missing Telegram identity prevents export controls and requests', async () => {
  const q = await setup({ initData: '' })
  assert.equal(q.requests.length, 0)
  assert.equal(q.all().some(n => n.tag === 'form'), false)
})

test('mismatched source metadata is not displayed as a downloadable export', async () => {
  const q = await setup({ jobs: [job('completed', { sourceId: 'another_clip' })] })
  assert.ok(q.text().includes('could not be confirmed'))
  assert.equal(q.all().some(n => n.textContent === 'Prepare MP4 download'), false)
})

test('mini-app entry loads the export interface after the player scripts', () => {
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8')
  assert.ok(html.includes('src="manage-exports.js"'))
  assert.ok(html.indexOf('src="manage.js"') < html.indexOf('src="manage-exports.js"'))
})

