const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const source = fs.readFileSync(
  path.join(__dirname, '../public/manage.js'), 'utf8'
)

class Node {
  constructor(tag) {
    this.tag = tag
    this.children = []
    this.attributes = {}
    this.textContent = ''
    this.value = ''
    this.currentTime = 0
    this.duration = 100
    this.paused = true
    this.src = ''
  }
  append(...items) {
    for (const item of items) {
      this.children.push(item)
      item.parentNode = this
    }
  }
  replaceChildren(...items) {
    for (const child of this.children) child.parentNode = null
    this.children = []
    this.append(...items)
  }
  setAttribute(key, value) { this.attributes[key] = value }
  removeAttribute(key) {
    delete this.attributes[key]
    if (key === 'src') this.src = ''
  }
  remove() {
    if (this.parentNode) {
      this.parentNode.children = this.parentNode.children.filter(n => n !== this)
      this.parentNode = null
    }
  }
  querySelectorAll(selector) {
    const walk = node => [
      ...node.children,
      ...node.children.flatMap(walk),
    ]
    return walk(this).filter(node => node.tag === selector)
  }
  load() {}
  pause() {
    this.paused = true
    if (this.onpause) this.onpause()
  }
  async play() {
    this.paused = false
    if (this.onplay) this.onplay()
  }
}

async function setup({
  kind = 'clip', id = 'clip_test',
  initData = 'mock-init-data', failDelete = false, failShare = false,
} = {}) {
  const main = new Node('main')
  const all = () => {
    const walk = node => [node, ...node.children.flatMap(walk)]
    return walk(main)
  }
  const calls = []
  let confirms = 0
  const document = {
    createElement: tag => new Node(tag),
    querySelector: selector => selector === 'main' ? main :
      all().find(node => node.attributes.role === 'status'),
    documentElement: { contains: node => all().includes(node) },
  }

  const fetch = async (url, options) => {
    const body = options.body ? JSON.parse(options.body) : undefined
    calls.push({ url, method: options.method, body, headers: options.headers })
    if (url === '/api/playback') {
      if (failShare && calls.length > 1) {
        return {
          ok: false, status: 503,
          json: async () => ({ error: 'private credentials detail' }),
        }
      }
      return {
        ok: true,
        json: async () => ({ url: 'https://recorder.example/signed-audio' }),
      }
    }
    if (options.method === 'DELETE') {
      return {
        ok: !failDelete,
        status: failDelete ? 503 : 200,
        json: async () => failDelete
          ? { error: 'Deletion could not be confirmed.' }
          : { ok: true, purge_after: '2026-01-01T02:00:00.000Z' },
      }
    }
    if (options.method === 'POST' && url.endsWith('/archive')) {
      return {
        ok: true,
        json: async () => ({ ok: true, item: { archived_at: 'keep-date' } }),
      }
    }
    throw new Error('Unexpected mocked Manage request')
  }

  const params = new URLSearchParams({ manage: kind, id })
  await new vm.Script(source).runInNewContext({
    document,
    location: { search: '?' + params.toString() },
    window: { Telegram: { WebApp: {
      initData, ready() {}, expand() {},
    } } },
    URL, URLSearchParams, fetch, setTimeout, clearTimeout,
    confirm() {
      confirms++
      throw new Error('No confirmation prompt is permitted')
    },
  })

  const button = label => {
    const node = all().find(n => n.tag === 'button' && n.textContent === label)
    assert.ok(node, 'Missing button: ' + label)
    return node
  }
  return {
    main, all, calls, button,
    click: async label => button(label).onclick(),
    status: () => all().find(n => n.attributes.role === 'status').textContent,
    confirms: () => confirms,
  }
}

test('exact clip opens directly and has no redundant Archive button', async () => {
  const q = await setup()
  assert.deepEqual(q.calls[0].body, { kind: 'clip', id: 'clip_test' })
  assert.equal(q.calls[0].headers['x-telegram-init-data'], 'mock-init-data')
  assert.ok(q.all().some(n => n.tag === 'audio'))
  assert.ok(q.all().some(n => n.textContent === 'Delete'))
  const actions = q.button('Delete').parentNode
  assert.deepEqual(actions.children.map(n => n.textContent), ['Share', 'Archive', 'Delete'])
  assert.equal(q.all().some(n => n.tag === 'form'), false)
})

test('selected-item header preserves the exact action and player control order', async () => {
  const q = await setup({ kind: 'space', id: 'space_test' })
  const audio = q.all().find(n => n.tag === 'audio')
  const content = audio.parentNode
  const form = content.children.find(n => n.tag === 'form')
  const heading = q.all().find(n => n.tag === 'h1').parentNode
  const actionRow = q.button('Delete').parentNode
  assert.equal(actionRow.parentNode, content)
  assert.deepEqual(actionRow.children.map(n => n.textContent), ['Play', 'Share', 'Delete'])
  const playerRow = q.button('Forward 30 sec').parentNode
  assert.deepEqual(playerRow.children.map(n => n.textContent), [
    'Play', 'Forward 30 sec', 'Forward 6 min', 'Rewind 15 sec',
  ])
  const slider = content.children.find(n => n.tag === 'input' && n.type === 'range')
  assert.ok(content.children.indexOf(slider) < content.children.indexOf(playerRow))
  assert.ok(content.children.indexOf(playerRow) < content.children.indexOf(form))
})

test('clip Delete submits once without a confirmation and shows Restore instructions', async () => {
  const q = await setup()
  const node = q.button('Delete')
  await Promise.all([node.onclick(), node.onclick()])
  const deletes = q.calls.filter(c => c.method === 'DELETE')
  assert.equal(deletes.length, 1)
  assert.equal(deletes[0].url, '/relay/space/clips/clip_test')
  assert.equal(q.confirms(), 0)
  assert.match(q.status(), /restore within two hours/i)
  assert.equal(q.all().some(n => n.tag === 'audio'), false)
})

test('Space Delete uses the exact recording deletion endpoint without confirmation', async () => {
  const q = await setup({ kind: 'space', id: 'space_test' })
  await q.click('Delete')
  const deletion = q.calls.find(c => c.method === 'DELETE')
  assert.equal(deletion.url, '/relay/space/archive/space_test')
  assert.equal(q.confirms(), 0)
})

test('Space view has no visible Archive action for the selected space', async () => {
  const q = await setup({ kind: 'space', id: 'space_test' })
  const spaceActions = q.button('Delete').parentNode
  assert.equal(spaceActions.children.some(n => n.textContent === 'Archive'), false)
})

test('failed deletion leaves the player available and reports unconfirmed deletion', async () => {
  const q = await setup({ failDelete: true })
  const audio = q.all().find(n => n.tag === 'audio')
  await q.click('Delete')
  assert.ok(q.all().includes(audio))
  assert.equal(audio.src, 'https://recorder.example/signed-audio')
  assert.match(q.status(), /Deletion could not be confirmed/)
  assert.equal(q.confirms(), 0)
})

test('Manage requires Telegram init data before making any request', async () => {
  const q = await setup({ initData: '' })
  assert.equal(q.calls.length, 0)
  assert.match(q.status(), /private Telegram chat/)
})


test('Refresh stays beside the selected-item heading and requests the same item', async () => {
  const q = await setup({ kind: 'space', id: 'selected_space' })
  const heading = q.all().find(n => n.tag === 'h1')
  assert.equal(q.button('Refresh audio').parentNode, heading.parentNode)
  assert.notEqual(q.button('Refresh audio').parentNode, q.button('Delete').parentNode)
  await q.click('Refresh audio')
  const requests = q.calls.filter(c => c.url === '/api/playback')
  assert.equal(requests.length, 2)
  for (const request of requests) {
    assert.deepEqual(request.body, { kind: 'space', id: 'selected_space' })
  }
})

test('forward controls jump thirty and three hundred sixty seconds and clamp at the end', async () => {
  const q = await setup()
  const audio = q.all().find(n => n.tag === 'audio')
  audio.duration = 1000
  await q.click('Forward 30 sec')
  assert.equal(audio.currentTime, 30)
  await q.click('Forward 6 min')
  assert.equal(audio.currentTime, 390)
  audio.currentTime = 990
  await q.click('Forward 30 sec')
  assert.equal(audio.currentTime, 1000)
  audio.currentTime = 900
  await q.click('Forward 6 min')
  assert.equal(audio.currentTime, 1000)
})

test('rewind subtracts fifteen seconds without seeking before zero', async () => {
  const q = await setup()
  const audio = q.all().find(n => n.tag === 'audio')
  audio.currentTime = 40
  await q.click('Rewind 15 sec')
  assert.equal(audio.currentTime, 25)
  audio.currentTime = 5
  await q.click('Rewind 15 sec')
  assert.equal(audio.currentTime, 0)
})

test('Play and Pause control the selected full item without creating a clip', async () => {
  const q = await setup({ kind: 'space', id: 'full_recording' })
  const audio = q.all().find(n => n.tag === 'audio')
  await q.click('Play')
  assert.equal(audio.paused, false)
  await q.click('Pause')
  assert.equal(audio.paused, true)
  assert.equal(q.calls.length, 1)
  assert.deepEqual(q.calls[0].body, {
    kind: 'space', id: 'full_recording',
  })
})

test('unknown duration prevents forward seeking and slider seeking remains bounded', async () => {
  const q = await setup()
  const audio = q.all().find(n => n.tag === 'audio')
  for (const duration of [NaN, Infinity, 0]) {
    audio.duration = duration
    audio.currentTime = 0
    await q.click('Forward 30 sec')
    assert.equal(audio.currentTime, 0)
    await q.click('Forward 6 min')
    assert.equal(audio.currentTime, 0)
    assert.match(q.status(), /duration is not available/)
  }
  audio.duration = 100
  const slider = q.all().find(n => n.tag === 'input' && n.type === 'range')
  slider.value = '10000'
  slider.oninput()
  assert.equal(audio.currentTime, 100)
  slider.value = '-20'
  slider.oninput()
  assert.equal(audio.currentTime, 0)
})

test('playback controls precede seek/time and actions stay in the header', async () => {
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
  assert.ok(index(slider) < index(time))
  assert.ok(index(time) < index(controls))
  assert.ok(index(controls) < index(form))
  assert.equal(actions.parentNode, content)
  assert.deepEqual(actions.children.map(n => n.textContent), ['Play', 'Share', 'Delete'])
})


test('Manage view receives the scoped mfer theme class', async () => {
  const q = await setup()
  assert.ok(q.main.className.split(/\s+/).includes('manage-view'))
})

test('Play, Archive, and Delete retain their semantic colors through playback', async () => {
  const q = await setup({ kind: 'space', id: 'space_test' })
  assert.equal(q.button('Play').attributes['data-tone'], 'primary')
  assert.equal(q.button('Archive').attributes['data-tone'], 'gold')
  assert.equal(q.button('Delete').attributes['data-tone'], 'danger')
  assert.equal(q.button('Forward 6 min').attributes['data-tone'], 'neutral')
  await q.click('Play')
  assert.equal(q.button('Pause').attributes['data-tone'], 'primary')
})

test('theme contains the exact supplied mfer palette', () => {
  const css = fs.readFileSync(path.join(__dirname, '../public/app.css'), 'utf8')
  const values = new Map(
    [...css.matchAll(/--([A-Za-z0-9_-]+)\s*:\s*(#[A-Fa-f0-9]{6})/g)]
      .map(match => [match[1], match[2].toLowerCase()])
  )
  const expected = {
    black: '#000000', bg: '#080808',
    surface: '#0f0f0f', surface2: '#141414', surface3: '#1a1a1a',
    border: '#222222', teal: '#00e5d1', teal2: '#00b8a9',
    magenta: '#ff2d78', magenta2: '#c4005f',
    gold: '#ffd700', gold2: '#b89a00',
    grey: '#444444', grey2: '#2a2a2a',
    text: '#e8e8e8', muted: '#888888', faint: '#444444',
  }
  for (const [name, value] of Object.entries(expected)) {
    assert.equal(values.get(name), value, name)
  }
})


function setSelection(q, startValue, endValue, duration = 4000) {
  const audio = q.all().find(n => n.tag === 'audio')
  audio.duration = duration
  const start = q.all().find(n => n.placeholder === ':00')
  const end = q.all().find(n => n.placeholder === '00:30')
  start.value = startValue
  end.value = endValue
  start.oninput()
  end.oninput()
  return { audio, start, end }
}

test('clip form interprets entered times without imposing example defaults', async () => {
  const q = await setup({ kind: 'space' })
  assert.equal(q.all().find(n => n.placeholder === ':00').value, '')
  assert.equal(q.all().find(n => n.placeholder === '00:30').value, '')
  assert.equal(q.button('Preview').disabled, true)
  setSelection(q, '30:00', '31:00')
  assert.ok(q.all().some(n =>
    n.textContent === 'Interpreted selection: 30:00 → 31:00'))
  assert.ok(q.all().some(n => n.textContent === 'Clip duration: 1:00'))
  assert.equal(q.button('Preview').disabled, false)
})

test('Preview plays from Start without submitting a render job', async () => {
  const q = await setup({ kind: 'space' })
  const { audio } = setSelection(q, '10', '20')
  await q.click('Preview')
  assert.equal(audio.currentTime, 10)
  assert.equal(audio.paused, false)
  assert.equal(q.calls.length, 1)
  assert.equal(q.calls[0].url, '/api/playback')
  assert.equal(q.button('Preview').attributes['data-tone'], 'primary')
})

test('preview pauses and clamps at its selected endpoint', async () => {
  const q = await setup({ kind: 'space' })
  const { audio } = setSelection(q, '10', '20')
  await q.click('Preview')
  audio.currentTime = 20.8
  audio.ontimeupdate()
  assert.equal(audio.paused, true)
  assert.equal(audio.currentTime, 20)
  assert.ok(q.all().some(n => n.textContent === 'Preview finished.'))
})

test('preview refuses a selection beyond available audio', async () => {
  const q = await setup({ kind: 'space' })
  const { audio } = setSelection(q, '90', '120', 100)
  assert.equal(q.button('Preview').disabled, true)
  await q.click('Preview')
  assert.equal(audio.paused, true)
  assert.ok(q.all().some(n =>
    n.textContent === 'Selection exceeds available audio.'))
  assert.equal(q.calls.length, 1)
})

test('preview refuses unknown duration without starting audio', async () => {
  const q = await setup({ kind: 'space' })
  const { audio } = setSelection(q, '10', '20', Infinity)
  assert.equal(q.button('Preview').disabled, true)
  await q.click('Preview')
  assert.equal(audio.paused, true)
  assert.ok(q.all().some(n =>
    n.textContent === 'Audio duration is not available yet.'))
})

test('editing the selection cancels its active preview', async () => {
  const q = await setup({ kind: 'space' })
  const { audio, end } = setSelection(q, '10', '20')
  await q.click('Preview')
  end.value = '25'
  end.oninput()
  assert.equal(audio.paused, true)
  assert.ok(q.all().some(n =>
    n.textContent === 'Selection changed. Preview again to hear the new range.'))
})

test('ordinary Play resumes full-item playback rather than retaining a preview bound', async () => {
  const q = await setup({ kind: 'space' })
  const { audio } = setSelection(q, '10', '20')
  await q.click('Preview')
  await q.click('Pause')
  await q.click('Play')
  audio.currentTime = 35
  audio.ontimeupdate()
  assert.equal(audio.paused, false)
  assert.equal(audio.currentTime, 35)
  assert.equal(q.calls.length, 1)
})

test('invalid selection cannot start a preview or submit a clip job', async () => {
  const q = await setup({ kind: 'space' })
  const { audio } = setSelection(q, '1:99', '2:10')
  await q.click('Preview')
  const form = q.all().find(n => n.tag === 'form')
  await form.onsubmit({ preventDefault() {} })
  assert.equal(audio.paused, true)
  assert.equal(q.calls.length, 1)
})

test('refresh cancels preview while retaining the selected recording', async () => {
  const q = await setup({ kind: 'space', id: 'selected_recording' })
  const { audio } = setSelection(q, '10', '20')
  await q.click('Preview')
  await q.click('Refresh audio')
  audio.currentTime = 35
  audio.ontimeupdate()
  assert.equal(audio.currentTime, 35)
  const requests = q.calls.filter(c => c.url === '/api/playback')
  assert.equal(requests.length, 2)
  for (const request of requests) {
    assert.deepEqual(request.body, {
      kind: 'space', id: 'selected_recording',
    })
  }
})


test('audio download preparation targets the selected clip without changing playback', async () => {
  const q = await setup({ kind: 'clip', id: 'selected_clip' })
  const audio = q.all().find(n => n.tag === 'audio')
  const original = audio.src
  await q.click('Prepare audio download')
  assert.equal(q.calls.length, 2)
  assert.deepEqual(q.calls[1].body, {
    kind: 'clip', id: 'selected_clip', download: true,
  })
  assert.equal(audio.src, original)
  const link = q.all().find(n => n.tag === 'a' && n.textContent === 'Download audio')
  assert.ok(link)
  assert.equal(new URL(link.href).protocol, 'https:')
})

test('deleting the selected item also removes its sharing controls', async () => {
  const q = await setup({ kind: 'clip' })
  assert.ok(q.all().some(n => n.textContent === 'Prepare audio download'))
  await q.click('Delete')
  assert.equal(q.all().some(n => n.textContent === 'Prepare audio download'), false)
})


test('sharing fields do not issue a request until preparation is requested', async () => {
  const q = await setup()
  assert.ok(q.all().some(n => n.attributes['aria-label'] === 'Share title'))
  assert.ok(q.all().some(n => n.attributes['aria-label'] === 'Share message'))
  assert.equal(q.calls.length, 1)
  assert.equal(q.calls[0].url, '/api/playback')
  assert.equal(q.all().some(n => n.textContent === 'Choose Telegram chat'), false)
})

test('sharing preparation preserves the selected clip and encoded editable message', async () => {
  const q = await setup({ kind: 'clip', id: 'selected_clip' })
  const title = q.all().find(n => n.attributes['aria-label'] === 'Share title')
  const message = q.all().find(n => n.attributes['aria-label'] === 'Share message')
  title.value = 'A & B ? # clip'
  message.value = 'Listen & discuss'
  const audio = q.all().find(n => n.tag === 'audio')
  const original = audio.src

  await q.click('Prepare sharing links')
  assert.equal(q.calls.length, 2)
  assert.deepEqual(q.calls[1].body, { kind: 'clip', id: 'selected_clip' })
  assert.equal(audio.src, original)

  const copy = q.all().find(n =>
    n.attributes['aria-label'] === 'Copyable playback link')
  assert.equal(copy.readOnly, true)
  assert.equal(copy.value, 'https://recorder.example/signed-audio')

  const email = new URL(q.all().find(n => n.textContent === 'Open email draft').href)
  assert.equal(email.protocol, 'mailto:')
  assert.equal(email.pathname, '')
  assert.equal(email.searchParams.get('subject'), 'A & B ? # clip')
  assert.ok(email.searchParams.get('body').includes('Listen & discuss'))
  assert.ok(email.searchParams.get('body').includes(copy.value))

  const telegram = new URL(q.all().find(n =>
    n.textContent === 'Choose Telegram chat').href)
  assert.equal(telegram.origin, 'https://t.me')
  assert.equal(telegram.pathname, '/share/url')
  assert.equal(telegram.searchParams.get('url'), copy.value)
  assert.ok(telegram.searchParams.get('text').includes('A & B ? # clip'))
  assert.ok(telegram.searchParams.get('text').includes('Listen & discuss'))
})

test('email subject strips line breaks rather than allowing extra header lines', async () => {
  const q = await setup()
  q.all().find(n => n.attributes['aria-label'] === 'Share title').value =
    'Title\r\nBcc: somebody@example.com'
  await q.click('Prepare sharing links')
  const email = new URL(q.all().find(n => n.textContent === 'Open email draft').href)
  assert.doesNotMatch(email.searchParams.get('subject'), /[\r\n]/)
  assert.equal(email.searchParams.has('bcc'), false)
})

test('sharing preparation failure shows no external draft links or internal error details', async () => {
  const q = await setup({ failShare: true })
  await q.click('Prepare sharing links')
  assert.ok(q.all().some(n =>
    n.textContent === 'Sharing links could not be prepared. Refresh the selected item and retry.'))
  assert.equal(q.all().some(n => n.textContent === 'Open email draft'), false)
  assert.equal(q.all().some(n => n.textContent === 'Choose Telegram chat'), false)
  assert.equal(q.all().some(n => /private credentials detail/.test(n.textContent)), false)
})

test('overlapping sharing preparation submits only one signing request', async () => {
  const q = await setup()
  const prepare = q.button('Prepare sharing links')
  await Promise.all([prepare.onclick(), prepare.onclick()])
  assert.equal(q.calls.length, 2)
})

test('deletion removes prepared sharing links along with the selected player', async () => {
  const q = await setup()
  await q.click('Prepare sharing links')
  assert.ok(q.all().some(n => n.textContent === 'Choose Telegram chat'))
  await q.click('Delete')
  assert.equal(q.all().some(n => n.textContent === 'Choose Telegram chat'), false)
  assert.equal(q.all().some(n => n.textContent === 'Open email draft'), false)
})


test('Share starts collapsed, toggles both ways, and names its controlled panel', async () => {
  const q = await setup()
  const sharing = q.all().find(n => n.className === 'share-tools')
  const toggle = q.button('Share')
  assert.equal(sharing.hidden, true)
  assert.equal(toggle.attributes['aria-expanded'], 'false')
  assert.equal(toggle.attributes['aria-controls'], sharing.id)
  const calls = q.calls.length
  await q.click('Share')
  assert.equal(sharing.hidden, false)
  assert.equal(toggle.attributes['aria-expanded'], 'true')
  await q.click('Share')
  assert.equal(sharing.hidden, true)
  assert.equal(toggle.attributes['aria-expanded'], 'false')
  assert.equal(q.calls.length, calls)
})

test('clip action row is Share Archive Delete', async () => {
  const q = await setup({ kind: 'clip' })
  const actions = q.button('Delete').parentNode
  assert.deepEqual(actions.children.map(n => n.textContent), ['Share', 'Archive', 'Delete'])
})

test('confirmed deletion removes header controls as well as player and sharing', async () => {
  const q = await setup()
  await q.click('Delete')
  for (const label of ['Refresh audio', 'Delete', 'Share']) {
    assert.equal(q.all().some(n => n.tag === 'button' && n.textContent === label), false)
  }
})
