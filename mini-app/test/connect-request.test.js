const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const source = fs.readFileSync(
  path.join(__dirname, '../public/connect.js'), 'utf8'
)

class Node {
  constructor(tag) {
    this.tag = tag
    this.children = []
    this.attributes = {}
    this.textContent = ''
    this.value = ''
    this.checked = false
  }
  append(...items) { this.children.push(...items) }
  replaceChildren(...items) { this.children = [...items] }
  setAttribute(key, value) { this.attributes[key] = value }
}

async function setup({
  request = 'pending_test',
  connected = false,
  state = 'waiting_connection',
  retryFails = false,
  initData = 'mock-init-data',
} = {}) {
  const main = new Node('main')
  const all = () => {
    const walk = node => [node, ...node.children.flatMap(walk)]
    return walk(main)
  }
  const calls = []
  const document = {
    createElement: tag => new Node(tag),
    createTextNode: text => Object.assign(new Node('#text'), { textContent: text }),
    querySelector: selector => selector === 'main' ? main :
      all().find(n => n.attributes.role === 'status'),
  }
  const fetch = async (url, options) => {
    const body = options.body ? JSON.parse(options.body) : undefined
    calls.push({ url, method: options.method, body, headers: options.headers })
    let data
    let ok = true
    if (url === '/relay/x-connections') {
      data = connected ? [{ id: 'x_owned', status: 'active' }] : []
    } else if (url === '/relay/x-connections/complete' ||
               url === '/relay/x-connections/x_owned/reconnect') {
      data = { ok: true, connection: { id: 'x_owned', status: 'active' } }
    } else if (url === '/relay/space/requests/pending_test') {
      data = {
        ok: true, requestId: 'pending_test', state,
        jobId: state === 'recording' ? 'mock_job' : null,
      }
    } else if (url === '/relay/space/requests/pending_test/resume') {
      if (retryFails) {
        ok = false
        data = { ok: false, code: 'submission_uncertain' }
      } else {
        state = 'recording'
        data = { ok: true, requestId: 'pending_test', jobId: 'mock_job' }
      }
    } else {
      throw new Error('Unexpected mocked browser request')
    }
    return { ok, json: async () => data }
  }

  const params = new URLSearchParams({ connect: 'x' })
  if (request !== null) params.set('request', request)
  await new vm.Script(source).runInNewContext({
    document,
    location: { search: '?' + params.toString() },
    window: { Telegram: { WebApp: {
      initData, ready() {}, expand() {},
    } } },
    URLSearchParams, AbortController, setTimeout, clearTimeout, fetch,
  })

  async function saveSession() {
    const form = all().find(n => n.tag === 'form')
    assert.ok(form)
    all().find(n => n.type === 'password').value = 'mock-session-only'
    all().find(n => n.type === 'checkbox').checked = true
    await form.onsubmit({ preventDefault() {} })
  }
  async function click(label) {
    const button = all().find(n => n.tag === 'button' && n.textContent === label)
    assert.ok(button, 'Expected button: ' + label)
    await button.onclick()
  }
  const status = () => all().find(n => n.attributes.role === 'status').textContent
  return { calls, saveSession, click, status }
}

test('successful session save retries the saved request once', async () => {
  const q = await setup()
  await q.saveSession()
  const resumes = q.calls.filter(c => c.url.endsWith('/resume'))
  assert.equal(resumes.length, 1)
  assert.deepEqual(resumes[0].body, { connectionId: 'x_owned' })
  assert.equal(resumes[0].headers['x-telegram-init-data'], 'mock-init-data')
  assert.match(q.status(), /Recording job confirmed: mock_job/)
  await q.click('Resume saved recording request')
  assert.equal(q.calls.filter(c => c.url.endsWith('/resume')).length, 1)
})

test('ordinary connection setup without a request does not retry recording', async () => {
  const q = await setup({ request: null })
  await q.saveSession()
  assert.equal(q.calls.some(c => c.url.includes('space/requests')), false)
})

test('existing active connection requires explicit resume on page opening', async () => {
  const q = await setup({ connected: true })
  assert.equal(q.calls.length, 1)
  await q.click('Resume saved recording request')
  assert.equal(q.calls.filter(c => c.url.endsWith('/resume')).length, 1)
})

test('already recording request displays its saved job without resubmitting', async () => {
  const q = await setup({ connected: true, state: 'recording' })
  await q.click('Resume saved recording request')
  assert.equal(q.calls.some(c => c.url.endsWith('/resume')), false)
  assert.match(q.status(), /mock_job/)
})

test('uncertain submission is not automatically submitted again', async () => {
  const q = await setup({ connected: true, state: 'submitting' })
  await q.click('Resume saved recording request')
  assert.equal(q.calls.some(c => c.url.endsWith('/resume')), false)
  assert.match(q.status(), /uncertain outcome/)
})

test('retry failure is not mislabeled as a failed session connection', async () => {
  const q = await setup({ retryFails: true })
  await q.saveSession()
  assert.match(q.status(), /Recording retry was not confirmed/)
  assert.doesNotMatch(q.status(), /^Connection was not confirmed/)
})

test('invalid request link stops before making requests', async () => {
  const q = await setup({ request: '../invalid' })
  assert.equal(q.calls.length, 0)
  assert.match(q.status(), /Invalid saved request link/)
})

test('missing Telegram init data prevents network requests', async () => {
  const q = await setup({ initData: '' })
  assert.equal(q.calls.length, 0)
  assert.match(q.status(), /Open account setup from the bot/)
})

