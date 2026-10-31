'use strict'
// Manage-controls acceptance suite for the mfer Mini App layout v2.
// Runs manage.js against a minimal DOM shim in Node; no browser required.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'public', 'manage.js'), 'utf8')
const CSS = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.css'), 'utf8')

class El {
  constructor(tag) {
    this.tag = tag
    this.tagName = tag.toUpperCase()
    this.children = []
    this.parentNode = null
    this.attributes = {}
    this._text = ''
    this.value = ''
    this.disabled = false
    this.hidden = false
    this.className = ''
    this.style = {}
    this.currentTime = 0
    this.duration = NaN
    this.paused = true
    const cls = {
      add: (...names) => { this.className = [...new Set((this.className.split(/\s+/).filter(Boolean)).concat(names))].join(' ') },
      contains: name => this.className.split(/\s+/).includes(name),
    }
    this.classList = cls
    this.classList.add(tag)
  }
  get textContent() { return this._text }
  set textContent(v) { this._text = String(v); this.children = this.children.filter(c => c instanceof El) }
  append(...kids) {
    for (const k of kids) {
      if (k instanceof El) { k.parentNode = this; this.children.push(k) }
      else if (k != null) this._text += String(k)
    }
  }
  remove() { this.parentNode?.children && (this.parentNode.children = this.parentNode.children.filter(c => c !== this)) }
  replaceChildren() { this.children = []; this._text = '' }
  setAttribute(name, value) { this.attributes[name] = String(value) }
  getAttribute(name) { return this.attributes[name] }
  removeAttribute(name) { delete this.attributes[name] }
  contains(node) { let cur = node; while (cur) { if (cur === this) return true; cur = cur.parentNode } return false }
  querySelectorAll(sel) {
    const tag = String(sel).toLowerCase()
    const out = []
    const walk = n => { for (const c of n.children) { if (c instanceof El) { if (c.tag === tag) out.push(c); walk(c) } } }
    walk(this)
    return out
  }
  // audio element behavior
  play() { this.paused = false; if (this.onplay) this.onplay(); return Promise.resolve() }
  pause() { this.paused = true; if (this.onpause) this.onpause() }
  load() {}
}

function jsonResponse(body, ok = true, status = 200) {
  return { ok, status, json: async () => body }
}

async function setup(opts = {}) {
  const kind = opts.kind || 'clip'
  const id = opts.id || 'selected_clip'
  const calls = []

  const documentElement = new El('html')
  const document = {
    documentElement,
    querySelector: sel => sel === 'main' ? main : null,
    createElement: tag => new El(tag),
  }
  const main = new El('main')
  documentElement.append(main)

  const fetchMock = async (url, init = {}) => {
    const body = init.body === undefined ? undefined : JSON.parse(init.body)
    calls.push({ url, method: init.method || 'GET', body })
    if (url === '/api/playback') return jsonResponse({ url: 'https://media.example.test/selected.mp3' })
    if (url === '/api/share') {
      if (opts.failShare) return jsonResponse({ error: 'Signing service unavailable.' }, false, 500)
      if (body && body.download) return jsonResponse({ url: 'https://media.example.test/download.mp3' })
      return jsonResponse({ ok: true, link: 'https://share.example.test/s/abc123' })
    }
    if ((init.method || 'GET') === 'DELETE') {
      if (opts.failDelete) return jsonResponse({ error: 'Deletion could not be confirmed.' }, false, 500)
      return jsonResponse({ ok: true })
    }
    if (url.endsWith('/archive')) return jsonResponse({ ok: true, item: {} })
    if (url.endsWith('/clips') && (init.method || 'GET') === 'POST') {
      return jsonResponse({ id: 'clip_new', status: 'completed' })
    }
    return jsonResponse({ ok: true })
  }

  const context = {
    document,
    location: { search: `?manage=${kind}&id=${id}` },
    window: { Telegram: opts.noInitData ? {} : { WebApp: { initData: 'init-data-test', ready() {}, expand() {} } } },
    fetch: fetchMock,
    confirm: () => { throw new Error('confirm() must not be used in layout v2') },
    URL, URLSearchParams, setTimeout, console,
  }
  context.globalThis = context
  vm.createContext(context)
  vm.runInContext(SOURCE, context, { filename: 'manage.js' })
  for (let i = 0; i < 6; i++) await new Promise(r => setTimeout(r, 0))

  const attached = () => {
    const out = []
    const walk = n => { out.push(n); for (const c of n.children) if (c instanceof El) walk(c) }
    walk(documentElement)
    return out
  }
  const q = {
    main,
    calls,
    all: attached,
    button: text => attached().find(n => n.tag === 'button' && n.textContent === text),
    click: async text => { const b = attached().find(n => n.tag === 'button' && n.textContent === text); assert.ok(b, `missing button: ${text}`); await b.onclick() },
    status: () => attached().find(n => n.tag === 'p' && n.attributes.role === 'status' && n.parentNode === main)?.textContent,
    audio: () => attached().find(n => n.tag === 'audio'),
  }
  return q
}

const submitForm = (form, q) => form.onsubmit({ preventDefault() {} })

const selectionFields = q => {
  const form = q.all().find(n => n.tag === 'form')
  const inputs = form.querySelectorAll('input')
  return { start: inputs[1], end: inputs[2] }
}

test('exact clip opens directly and has no redundant Archive button', async () => {
  const q = await setup()
  assert.equal(q.all().find(n => n.tag === 'h1').textContent, 'Manage clip')
  assert.equal(q.all().some(n => /^Archive/.test(n.textContent)), false)
  assert.equal(q.all().some(n => n.tag === 'form'), false)
})

test('selected-item header preserves the exact action and player control order', async () => {
  const q = await setup({ kind: 'space', id: 'space_test' })
  const audio = q.all().find(n => n.tag === 'audio')
  const content = audio.parentNode
  const form = content.children.find(n => n.tag === 'form')
  const heading = q.all().find(n => n.tag === 'h1').parentNode
  const actionRow = q.button('Delete').parentNode

  assert.equal(actionRow.parentNode, heading)
  assert.deepEqual(actionRow.children.map(n => n.textContent), [
    'Archive', 'Delete', 'Share',
  ])
  const playerRow = q.button('Forward 30 sec').parentNode
  assert.deepEqual(playerRow.children.map(n => n.textContent), [
    'Forward 30 sec', 'Play', 'Rewind 15 sec',
  ])
  assert.ok(content.children.indexOf(playerRow) < content.children.indexOf(
    content.children.find(n => n.tag === 'input' && n.type === 'range')
  ))
  assert.ok(content.children.indexOf(form) > content.children.indexOf(playerRow))
})

test('clip Delete submits once without a confirmation and shows Restore instructions', async () => {
  const q = await setup()
  const del = q.button('Delete')
  await Promise.all([del.onclick(), del.onclick()])
  const deletes = q.calls.filter(c => c.method === 'DELETE')
  assert.equal(deletes.length, 1)
  assert.equal(deletes[0].url, '/relay/space/clips/selected_clip')
  assert.equal(q.status(), 'Deletion scheduled. Use /restore within two hours.')
})

test('Space Delete uses the exact recording deletion endpoint without confirmation', async () => {
  const q = await setup({ kind: 'space', id: 'space_test' })
  await q.click('Delete')
  const deletes = q.calls.filter(c => c.method === 'DELETE')
  assert.equal(deletes.length, 1)
  assert.equal(deletes[0].url, '/relay/space/archive/space_test')
  assert.equal(q.status(), 'Deletion scheduled. Use /restore within two hours.')
})

test('Archive Space keeps the selected player loaded', async () => {
  const q = await setup({ kind: 'space', id: 'space_test' })
  const audio = q.audio()
  const before = audio.src
  await q.click('Archive')
  assert.equal(audio.src, before)
  assert.equal(q.status(), 'Archived. Active capture has not been stopped.')
  const archives = q.calls.filter(c => c.method === 'POST' && c.url.endsWith('/archive'))
  assert.equal(archives.length, 1)
  assert.equal(archives[0].url, '/relay/space/recordings/space_test/archive')
})

test('failed deletion leaves the player available and reports unconfirmed deletion', async () => {
  const q = await setup({ failDelete: true })
  const audio = q.audio()
  const before = audio.src
  await q.click('Delete')
  assert.match(q.status(), /Deletion could not be confirmed/)
  assert.equal(audio.src, before)
  assert.ok(q.button('Play'))
  assert.ok(q.button('Forward 30 sec'))
})

test('Manage requires Telegram init data before making any request', async () => {
  const q = await setup({ noInitData: true })
  assert.equal(q.status(), 'Open this item from the bot in a private Telegram chat.')
  assert.equal(q.calls.length, 0)
})

test('Refresh stays beside the selected-item heading and requests the same item', async () => {
  const q = await setup({ kind: 'space', id: 'space_test' })
  const heading = q.all().find(n => n.tag === 'h1').parentNode
  assert.equal(q.button('Refresh audio').parentNode, heading)
  const playbackCalls = () => q.calls.filter(c => c.url === '/api/playback')
  assert.equal(playbackCalls().length, 1)
  await q.click('Refresh audio')
  assert.equal(playbackCalls().length, 2)
  assert.deepEqual(playbackCalls()[1].body, { kind: 'space', id: 'space_test' })
})

test('forward control jumps thirty seconds and clamps at the end', async () => {
  const q = await setup()
  const audio = q.audio()
  audio.duration = 1000
  await q.click('Forward 30 sec')
  assert.equal(audio.currentTime, 30)
  audio.currentTime = 990
  await q.click('Forward 30 sec')
  assert.equal(audio.currentTime, 1000)
})

test('rewind subtracts fifteen seconds without seeking before zero', async () => {
  const q = await setup()
  const audio = q.audio()
  audio.duration = 1000
  audio.currentTime = 20
  await q.click('Rewind 15 sec')
  assert.equal(audio.currentTime, 5)
  audio.currentTime = 5
  await q.click('Rewind 15 sec')
  assert.equal(audio.currentTime, 0)
})

test('Play and Pause control the selected full item without creating a clip', async () => {
  const q = await setup()
  const audio = q.audio()
  const before = q.calls.length
  await q.click('Play')
  assert.equal(audio.paused, false)
  assert.equal(q.button('Pause').textContent, 'Pause')
  await q.click('Pause')
  assert.equal(audio.paused, true)
  assert.equal(q.button('Play').textContent, 'Play')
  assert.equal(q.calls.length, before)
})

test('unknown duration prevents forward seeking and slider seeking remains bounded', async () => {
  const q = await setup()
  const audio = q.audio()
  for (const duration of [NaN, Infinity, 0]) {
    audio.duration = duration
    audio.currentTime = 0
    await q.click('Forward 30 sec')
    assert.equal(audio.currentTime, 0)
    assert.match(q.status(), /duration is not available/)
  }
  audio.duration = 100
  audio.ondurationchange()
  const slider = q.all().find(n => n.tag === 'input' && n.type === 'range')
  assert.equal(slider.max, '100')
  slider.value = '200'
  slider.oninput()
  assert.equal(audio.currentTime, 100)
})

test('playback controls precede seek/time and header actions', async () => {
  const q = await setup({ kind: 'space', id: 'space_test' })
  const audio = q.all().find(n => n.tag === 'audio')
  const content = audio.parentNode
  const slider = content.children.find(n => n.tag === 'input' && n.type === 'range')
  const time = content.children.find(n => n.tag === 'p')
  const controls = q.button('Play').parentNode
  const heading = q.all().find(n => n.tag === 'h1').parentNode
  const actions = q.button('Delete').parentNode
  const form = content.children.find(n => n.tag === 'form')
  const index = node => content.children.indexOf(node)
  assert.ok(index(controls) < index(slider))
  assert.ok(index(slider) < index(time))
  assert.ok(index(time) < index(form))
  assert.equal(actions.parentNode, heading)
  assert.deepEqual(actions.children.map(n => n.textContent), [
    'Archive', 'Delete', 'Share',
  ])
})

test('Manage view receives the scoped mfer theme class', async () => {
  const q = await setup()
  assert.ok(q.main.classList.contains('manage-view'))
  assert.ok(q.main.classList.contains('mfer'))
})

test('Play, Archive, and Delete retain their semantic colors through playback', async () => {
  const q = await setup({ kind: 'space', id: 'space_test' })
  assert.equal(q.button('Play').attributes['data-tone'], 'primary')
  assert.equal(q.button('Archive').attributes['data-tone'], 'gold')
  assert.equal(q.button('Delete').attributes['data-tone'], 'danger')
  await q.click('Play')
  assert.equal(q.button('Pause').attributes['data-tone'], 'primary')
})

test('theme contains the exact supplied mfer palette', () => {
  for (const hex of ['#ece1cd', '#f7f1e4', '#e2d5bd', '#3b3629', '#8a7f68',
    '#c9bda0', '#2f6f6a', '#a97e2f', '#a63d2f', '#6f6752']) {
    assert.ok(CSS.includes(hex), `palette value missing: ${hex}`)
  }
})

test('clip form interprets entered times without imposing example defaults', async () => {
  const q = await setup({ kind: 'space', id: 'space_test' })
  const { start, end } = selectionFields(q)
  assert.equal(start.value, '')
  start.value = '90'
  end.value = '150'
  await submitForm(q.all().find(n => n.tag === 'form'), q)
  const clipJob = q.calls.find(c => c.method === 'POST' && c.url.endsWith('/clips'))
  assert.deepEqual(clipJob.body, {
    title: '', start_seconds: 90, end_seconds: 150, enhance: false,
  })
})

test('Preview selection plays from Start without submitting a render job', async () => {
  const q = await setup({ kind: 'space', id: 'space_test' })
  const audio = q.audio()
  audio.duration = 1000
  const { start, end } = selectionFields(q)
  start.value = '30'
  end.value = '60'
  await q.click('Preview selection')
  assert.equal(audio.paused, false)
  assert.equal(audio.currentTime, 30)
  assert.equal(q.calls.filter(c => c.url.endsWith('/clips')).length, 0)
})

test('preview pauses and clamps at its selected endpoint', async () => {
  const q = await setup({ kind: 'space', id: 'space_test' })
  const audio = q.audio()
  audio.duration = 1000
  const { start, end } = selectionFields(q)
  start.value = '30'
  end.value = '60'
  await q.click('Preview selection')
  audio.currentTime = 60
  audio.ontimeupdate()
  assert.equal(audio.paused, true)
})

test('preview refuses a selection beyond available audio', async () => {
  const q = await setup({ kind: 'space', id: 'space_test' })
  const audio = q.audio()
  audio.duration = 100
  const { start, end } = selectionFields(q)
  start.value = '30'
  end.value = '200'
  await q.click('Preview selection')
  assert.equal(audio.paused, true)
  const result = q.all().find(n => n.tag === 'p' && n.parentNode.tag === 'form' && n.attributes.role === 'status')
  assert.equal(result.textContent, 'That selection is beyond the available audio.')
})

test('preview refuses unknown duration without starting audio', async () => {
  const q = await setup({ kind: 'space', id: 'space_test' })
  const audio = q.audio()
  audio.duration = NaN
  const { start, end } = selectionFields(q)
  start.value = '30'
  end.value = '60'
  await q.click('Preview selection')
  assert.equal(audio.paused, true)
  const result = q.all().find(n => n.tag === 'p' && n.parentNode.tag === 'form' && n.attributes.role === 'status')
  assert.equal(result.textContent, 'The duration is not available yet, so preview cannot start.')
})

test('editing the selection cancels its active preview', async () => {
  const q = await setup({ kind: 'space', id: 'space_test' })
  const audio = q.audio()
  audio.duration = 1000
  const { start, end } = selectionFields(q)
  start.value = '30'
  end.value = '60'
  await q.click('Preview selection')
  assert.equal(audio.paused, false)
  end.value = '90'
  end.oninput()
  assert.equal(audio.paused, true)
})

test('ordinary Play resumes full-item playback rather than retaining a preview bound', async () => {
  const q = await setup({ kind: 'space', id: 'space_test' })
  const audio = q.audio()
  audio.duration = 1000
  const { start, end } = selectionFields(q)
  start.value = '30'
  end.value = '60'
  await q.click('Preview selection')
  audio.currentTime = 60
  audio.ontimeupdate()
  assert.equal(audio.paused, true)
  await q.click('Play')
  assert.equal(audio.paused, false)
  audio.currentTime = 70
  audio.ontimeupdate()
  assert.equal(audio.paused, false)
})

test('invalid selection cannot start a preview or submit a clip job', async () => {
  const q = await setup({ kind: 'space', id: 'space_test' })
  const audio = q.audio()
  audio.duration = 1000
  const { start, end } = selectionFields(q)
  start.value = '60'
  end.value = '30'
  await q.click('Preview selection')
  assert.equal(audio.paused, true)
  await submitForm(q.all().find(n => n.tag === 'form'), q)
  assert.equal(q.calls.filter(c => c.url.endsWith('/clips')).length, 0)
})

test('refresh cancels preview while retaining the selected recording', async () => {
  const q = await setup({ kind: 'space', id: 'space_test' })
  const audio = q.audio()
  audio.duration = 1000
  const { start, end } = selectionFields(q)
  start.value = '30'
  end.value = '60'
  await q.click('Preview selection')
  const src = audio.src
  await q.click('Refresh audio')
  assert.equal(audio.paused, true)
  assert.equal(audio.src, src)
  assert.equal(q.status(), '')
})

test('audio download preparation targets the selected clip without changing playback', async () => {
  const q = await setup({ kind: 'clip', id: 'selected_clip' })
  const audio = q.audio()
  const original = audio.src
  await q.click('Share')
  await q.click('Prepare audio download')
  assert.equal(q.calls.length, 2)
  assert.deepEqual(q.calls[1].body, {
    kind: 'clip', id: 'selected_clip', download: true, title: '', message: '',
  })
  assert.equal(audio.src, original)
  assert.equal(audio.paused, true)
})

test('deleting the selected item also removes its sharing controls', async () => {
  const q = await setup()
  await q.click('Delete')
  assert.equal(q.all().some(n => n.textContent === 'Prepare sharing links'), false)
  assert.equal(q.all().some(n => n.textContent === 'Prepare audio download'), false)
})

test('Share starts collapsed and reveals sharing choices', async () => {
  const q = await setup()
  const sharing = q.all().find(n => n.className === 'share-tools')
  assert.equal(sharing.hidden, true)
  assert.equal(q.button('Share').attributes['aria-expanded'], 'false')
  await q.click('Share')
  assert.equal(sharing.hidden, false)
  assert.equal(q.button('Share').attributes['aria-expanded'], 'true')
})

test('sharing fields do not issue a request until preparation is requested', async () => {
  const q = await setup()
  assert.ok(q.all().some(n => n.attributes['aria-label'] === 'Share title'))
  assert.ok(q.all().some(n => n.attributes['aria-label'] === 'Share message'))
  assert.equal(q.calls.length, 1)
})

test('sharing preparation preserves the selected clip and encoded editable message', async () => {
  const q = await setup({ kind: 'clip', id: 'selected_clip' })
  await q.click('Share')
  const title = q.all().find(n => n.attributes['aria-label'] === 'Share title')
  const message = q.all().find(n => n.attributes['aria-label'] === 'Share message')
  title.value = 'A & B ? # clip'
  message.value = 'Listen & discuss'
  await q.click('Prepare sharing links')
  assert.deepEqual(q.calls[1].body, {
    kind: 'clip', id: 'selected_clip',
    title: 'A & B ? # clip', message: 'Listen & discuss',
  })
  assert.equal(message.value, 'Listen & discuss')
  const email = q.all().find(n => n.textContent === 'Open email draft')
  assert.ok(email.href.includes(encodeURIComponent('Listen & discuss')))
})

test('email subject strips line breaks rather than allowing extra header lines', async () => {
  const q = await setup()
  await q.click('Share')
  q.all().find(n => n.attributes['aria-label'] === 'Share title').value =
    'Title\r\nBcc: somebody@example.com'
  await q.click('Prepare sharing links')
  const email = new URL(q.all().find(n => n.textContent === 'Open email draft').href)
  assert.equal(email.searchParams.get('subject'), 'Title Bcc: somebody@example.com')
})

test('sharing preparation failure shows no external draft links or internal error details', async () => {
  const q = await setup({ failShare: true })
  await q.click('Share')
  await q.click('Prepare sharing links')
  assert.ok(q.all().some(n =>
    n.textContent === 'Sharing links could not be prepared. Refresh the selected item and retry.'))
  assert.equal(q.all().some(n => n.textContent === 'Open email draft'), false)
  assert.equal(q.all().some(n => n.textContent.includes('Signing service unavailable')), false)
})

test('overlapping sharing preparation submits only one signing request', async () => {
  const q = await setup()
  await q.click('Share')
  const prepare = q.button('Prepare sharing links')
  await Promise.all([prepare.onclick(), prepare.onclick()])
  assert.equal(q.calls.length, 2)
})

test('deletion removes prepared sharing links along with the selected player', async () => {
  const q = await setup()
  await q.click('Share')
  await q.click('Prepare sharing links')
  assert.ok(q.all().some(n => n.textContent === 'Choose Telegram chat'))
  await q.click('Delete')
  assert.equal(q.all().some(n => n.textContent === 'Choose Telegram chat'), false)
})
