const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const publicDir = path.join(__dirname, '../public')
const source = fs.readFileSync(
  path.join(publicDir, 'manage-connection.js'), 'utf8'
)

class Node {
  constructor(tag) {
    this.tag = tag
    this.children = []
    this.attributes = {}
    this.textContent = ''
    this.className = ''
  }
  append(...nodes) {
    for (const node of nodes) {
      this.children.push(node)
      node.parentNode = this
    }
  }
  insertBefore(node, reference) {
    if (!reference) return this.append(node)
    const index = this.children.indexOf(reference)
    assert.ok(index >= 0)
    this.children.splice(index, 0, node)
    node.parentNode = this
  }
  replaceChildren(...nodes) {
    for (const node of this.children) node.parentNode = null
    this.children = []
    this.append(...nodes)
  }
  setAttribute(name, value) { this.attributes[name] = value }
}

async function setup({
  data = [], fail = false, initData = 'mock-init',
  search = '?manage=space&id=selected_item',
  script = source,
} = {}) {
  const main = new Node('main')
  const heading = new Node('h1')
  const player = new Node('audio')
  main.append(heading, player)
  const calls = []
  const walk = node => [node, ...node.children.flatMap(walk)]
  const document = {
    querySelector: selector => selector === 'main' ? main :
      walk(main).find(n => n.attributes.role === 'status'),
    createElement: tag => new Node(tag),
    createTextNode: text => {
      const node = new Node('#text')
      node.textContent = text
      return node
    },
  }
  await new vm.Script(script).runInNewContext({
    document, location: { search },
    window: { Telegram: { WebApp: {
      initData, ready() {}, expand() {},
    } } },
    URLSearchParams, AbortController, setTimeout, clearTimeout,
    fetch: async (url, options) => {
      calls.push({ url, method: options.method, headers: options.headers })
      if (fail) throw new Error('private internal exception')
      return { ok: true, json: async () => data }
    },
  })
  return {
    main, player, heading, calls,
    all: () => walk(main),
    text: () => walk(main).map(n => n.textContent).join('\n'),
  }
}

test('no saved connection offers Connect X without removing the selected player', async () => {
  const q = await setup()
  assert.match(q.text(), /X access: Not connected/)
  assert.ok(q.all().some(n => n.textContent === 'Connect X'))
  assert.equal(q.player.parentNode, q.main)
  assert.equal(q.main.children[0], q.heading)
  assert.equal(q.main.children[1].className, 'connection-row')
  assert.match(q.text(), /private recorder-owned sign-in browser/)
  assert.doesNotMatch(q.text(), /session import, not interactive X sign-in/)
})

test('saved active status displays only the redacted account identity', async () => {
  const q = await setup({ data: [{
    id: 'x1', status: 'active', x_handle: 'test_account',
    cookie: 'must-never-appear', encrypted_credentials: 'also-private',
  }] })
  assert.match(q.text(), /Connected: @test_account/)
  assert.ok(q.all().some(n => n.textContent === 'Manage connection'))
  assert.doesNotMatch(q.text(), /must-never-appear|also-private/)
})

test('invalid, expired, or revoked saved access requires reconnection', async () => {
  for (const fields of [
    { status: 'reauth_required' },
    { status: 'invalid' },
    { status: 'active', expires_at: '2000-01-01T00:00:00.000Z' },
    { status: 'active', expires_at: 'invalid-date' },
    { status: 'active', revoked_at: '2020-01-01T00:00:00.000Z' },
  ]) {
    const q = await setup({ data: [{ id: 'x1', ...fields }] })
    assert.match(q.text(), /Reconnect required/)
    assert.ok(q.all().some(n => n.textContent === 'Reconnect X'))
  }
})

test('status failures do not claim Not connected or block the player', async () => {
  const q = await setup({ fail: true })
  assert.match(q.text(), /Status unavailable/)
  assert.doesNotMatch(q.text(), /X access: Not connected|private internal/)
  assert.equal(q.player.parentNode, q.main)
  assert.ok(q.all().some(n => n.textContent === 'Check again'))
})

test('malformed connection lists remain unverified rather than selecting an account', async () => {
  for (const data of [{}, [null], [{ id: '../bad', status: 'active' }]]) {
    const q = await setup({ data })
    assert.match(q.text(), /Status unavailable/)
    assert.doesNotMatch(q.text(), /Connected:/)
  }
})

test('multiple connections do not silently select one', async () => {
  const q = await setup({ data: [
    { id: 'x1', status: 'active' },
    { id: 'x2', status: 'active' },
  ] })
  assert.match(q.text(), /Account selection required/)
  assert.doesNotMatch(q.text(), /Connected:/)
})

test('connection link preserves exact clip context and makes only a read request', async () => {
  const q = await setup({ search: '?manage=clip&id=saved_clip' })
  const link = q.all().find(n => n.tag === 'a')
  const params = new URLSearchParams(link.href.slice(1))
  assert.equal(params.get('connect'), 'x')
  assert.equal(params.get('return_kind'), 'clip')
  assert.equal(params.get('return_id'), 'saved_clip')
  // Compare VM-origin request fields without comparing object prototypes.
  assert.equal(q.calls.length, 1)
  assert.equal(q.calls[0].url, '/relay/x-connections')
  assert.equal(q.calls[0].method, 'GET')
  assert.deepEqual(Object.keys(q.calls[0].headers), ['x-telegram-init-data'])
  assert.equal(q.calls[0].headers['x-telegram-init-data'], 'mock-init')
})

test('missing Telegram identity causes no connection lookup', async () => {
  const q = await setup({ initData: '' })
  assert.equal(q.calls.length, 0)
  assert.equal(q.main.children.length, 2)
})

test('account setup returns to the exact selected clip without starting a recording', async () => {
  const script = fs.readFileSync(path.join(publicDir, 'connect.js'), 'utf8')
  const q = await setup({
    script,
    search: '?connect=x&return_kind=clip&return_id=saved_clip',
  })
  const back = q.all().find(n => n.textContent === 'Back to selected item')
  assert.ok(back)
  const params = new URLSearchParams(back.href.slice(1))
  assert.equal(params.get('manage'), 'clip')
  assert.equal(params.get('id'), 'saved_clip')
  assert.equal(q.calls.length, 1)
  assert.equal(q.calls[0].method, 'GET')
  assert.equal(q.calls[0].url, '/relay/x-connections')
})

test('root mini-app entry has no recording form or dashboard script', () => {
  const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8')
  assert.doesNotMatch(html, /<form\b|id=["']list["']|src=["']app\.js["']/)
  for (const name of ['manage.js', 'connect-browser.js', 'manage-connection.js']) {
    assert.ok(html.includes('src="' + name + '"'))
  }
  assert.match(html, /Send Space links to the bot/)
  assert.doesNotMatch(html, /src=["']connect\.js["']/)
})
