const { test } = require('node:test')
const assert = require('node:assert/strict')
const {
  parseClipRange,
  extractRecordInput,
  publicUrl,
  createRecorderBot,
  launchError,
} = require('../telegram-bot')


// Signed playback test fixtures v1
process.env.RECORDER_RELAY_KEY = 'isolated-test-key-not-a-production-secret'

function assertSignedPlayback(value, pathname) {
  const url = new URL(value)
  assert.equal(url.origin, 'https://recorder.example.com')
  assert.equal(url.pathname, pathname)
  const expiry = url.searchParams.get('expires')
  assert.match(expiry || '', /^\d+$/)
  const remaining = Number(expiry) - Math.floor(Date.now() / 1000)
  assert.ok(remaining > 86300 && remaining <= 86400)
  const expected = require('node:crypto')
    .createHmac('sha256', process.env.RECORDER_RELAY_KEY)
    .update(pathname + '\n' + expiry).digest('hex')
  assert.equal(url.searchParams.get('signature'), expected)
  assert.equal(value.includes(process.env.RECORDER_RELAY_KEY), false)
}

class FakeBot {
  constructor() {
    this.sent = []
    this.handlers = {}
    this.answers = []
  }
  on(event, fn) {
    this.handlers[event] = fn
  }
  sendMessage(chatId, text, extra) {
    this.sent.push({ chatId, text, extra })
    return Promise.resolve({ message_id: this.sent.length })
  }
  answerCallbackQuery(id) {
    this.answers.push(id)
    return Promise.resolve()
  }
}

function harness(request) {
  const bot = new FakeBot()
  const app = createRecorderBot({
    token: 'test-token',
    publicBaseUrl: 'https://recorder.example.com/',
    backendBaseUrl: 'http://127.0.0.1:3001',
    request,
    Bot: FakeBot,
    polling: false,
  })
  return { bot: app.bot, app }
}

test('launch refuses a missing allowlist and a private base URL', () => {
  const ok = { token: 'secret', publicBaseUrl: 'https://recorder.example.com', allowedUserIds: ['123'] }
  assert.equal(launchError(ok), null)
  assert.match(launchError({ ...ok, token: '' }), /TELEGRAM_BOT_TOKEN/)
  assert.match(launchError({ ...ok, publicBaseUrl: 'http://recorder.example.com' }), /public https/)
  assert.match(launchError({ ...ok, publicBaseUrl: 'https://localhost:3001' }), /public https/)
  assert.match(launchError({ ...ok, publicBaseUrl: 'https://127.0.0.1:3001' }), /public https/)
  assert.match(launchError({ ...ok, publicBaseUrl: 'https://192.168.1.20' }), /public https/)
  assert.match(launchError({ ...ok, allowedUserIds: [] }), /numeric Telegram/)
  assert.match(launchError({ ...ok, allowedUserIds: ['@LOWKEYEMS'] }), /numeric Telegram/)
})

test('parses a minute-second clip range', () => {
  assert.deepEqual(parseClipRange('1:30-4:00'), { start_seconds: 90, end_seconds: 240 })
  assert.deepEqual(parseClipRange('1:02:03-1:05:00'), { start_seconds: 3723, end_seconds: 3900 })
  assert.equal(parseClipRange('4:00-1:30'), null)
  assert.equal(parseClipRange('later'), null)
})

test('reads a Space link from a paste or /record', () => {
  const link = 'https://x.com/i/spaces/1ypKdkAbCdEfGh'
  assert.equal(extractRecordInput(`see ${link}.`), link)
  assert.equal(extractRecordInput(`/record ${link}`), link)
  assert.equal(extractRecordInput('/record'), null)
  assert.equal(extractRecordInput('hello'), null)
})

test('builds signed playback URLs without a trailing slash', () => {
  assertSignedPlayback(
    publicUrl('https://recorder.example.com/', '/api/space/preview/abc'),
    '/api/space/preview/abc'
  )
})

test('a reachable Space starts a recording and offers listen and stop', async () => {
  const calls = []
  const { bot } = harness(async (method, pathname, body) => {
    calls.push({ method, pathname, body })
    if (pathname === '/api/space/resolve') {
      return { status: 200, json: { ok: true, m3u8: 'https://audio.example/live.m3u8', title: 'Launch', live: true } }
    }
    return { status: 200, json: { id: 'job123', kind: 'live' } }
  })
  await bot.handlers.message({ chat: { id: 7 }, from: { id: 7 }, text: 'https://x.com/i/spaces/1ypKdkAbCdEfGh' })
  assert.equal(calls[1].pathname, '/api/space/download')
  assert.equal(calls[1].body.input, 'https://x.com/i/spaces/1ypKdkAbCdEfGh')
  assert.match(bot.sent[0].text, /Recording started/)
  const buttons = bot.sent[0].extra.reply_markup.inline_keyboard[0]
  assert.deepEqual(buttons.map(b => b.text), ['Listen so far', 'Stop & save', 'Delete'])
  assert.equal(buttons[0].web_app.url, 'https://recorder.example.com/?manage=space&id=job123')
  assert.equal(buttons[1].callback_data, 's:job123')
  assert.equal(buttons[2].callback_data, 'dk:space:job123')
})

test('an unreachable Space offers watch, and the button arms the monitor', async () => {
  const calls = []
  const { bot } = harness(async (method, pathname, body) => {
    calls.push({ method, pathname, body })
    if (pathname === '/api/space/resolve') return { status: 200, json: { ok: false, reason: 'Not live yet.' } }
    return { status: 200, json: { id: 'mon1', state: 'watching' } }
  })
  const link = 'https://x.com/i/spaces/1ypKdkAbCdEfGh'
  await bot.handlers.message({ chat: { id: 7 }, from: { id: 7 }, text: `/record ${link}` })
  assert.match(bot.sent[0].text, /Watch for it/)
  const data = bot.sent[0].extra.reply_markup.inline_keyboard[0][0].callback_data
  await bot.handlers.callback_query({ id: 'cb', from: { id: 7 }, message: { chat: { id: 7 } }, data })
  assert.equal(calls.at(-1).pathname, '/api/space/monitor')
  assert.equal(calls.at(-1).body.input, link)
  assert.match(bot.sent.at(-1).text, /Watching/)
})

test('/status reports an active job from the backend', async () => {
  const { bot } = harness(async (method, pathname) => {
    return { status: 200, json: { ok: true,
      active: [{ id: 'job123', item_kind: 'space', title: 'Launch', state: 'downloading', duration_seconds: 95 }] } }
  })
  await bot.handlers.message({ chat: { id: 7 }, from: { id: 7 }, text: '/status' })
  assert.match(bot.sent[0].text, /downloading/)
  assert.match(bot.sent[0].text, /1:35/)
  const buttons = bot.sent[0].extra.reply_markup.inline_keyboard[0]
  assert.deepEqual(buttons.map(b => b.text), ['Listen so far', 'Stop & save', 'Delete'])
})

test('stop and legacy direct Delete preserve recorder routes', async () => {
  const calls = []
  const { bot } = harness(async (method, pathname) => {
    calls.push({ method, pathname })
    return { status: 200, json: { ok: true, purge_after: '2030-01-01T02:00:00.000Z' } }
  })
  await bot.handlers.callback_query({ id: 'cb1', from: { id: 7 }, message: { chat: { id: 7 } }, data: 's:job123' })
  await bot.handlers.callback_query({ id: 'cb2', from: { id: 7 }, message: { chat: { id: 7 } }, data: 'd:rec1' })
  await bot.handlers.callback_query({ id: 'cb3', from: { id: 7 }, message: { chat: { id: 7 } }, data: 'y:rec1' })
  assert.deepEqual(calls[0], { method: 'POST', pathname: '/api/space/stop/job123' })
  assert.match(bot.sent[1].text, /Deletion scheduled with a two-hour hold/)
  assert.equal(bot.sent[1].extra, undefined)
  assert.deepEqual(calls[1], { method: 'DELETE', pathname: '/api/space/archive/rec1' })
  assert.deepEqual(calls[2], { method: 'DELETE', pathname: '/api/space/archive/rec1' })
  assert.match(bot.sent.at(-1).text, /Use \/restore to recover it/)
})

test('/archive offers exact Manage and Delete; legacy clip creation remains supported', async () => {
  const calls = []
  const { bot } = harness(async (method, pathname, body) => {
    calls.push({ method, pathname, body })
    if (pathname === '/api/space/archive') {
      return { status: 200, json: [{ id: 'rec1', title: 'Launch', kind: 'live', duration_seconds: 600, size_bytes: 4096 }] }
    }
    return { status: 200, json: { id: 'clip1', title: 'Launch clip' } }
  })
  await bot.handlers.message({ chat: { id: 7, type: 'private' }, from: { id: 7 }, text: '/archive' })
  const row = bot.sent[0].extra.reply_markup.inline_keyboard[0]
  assert.equal(row[0].text, 'Manage')
  const manage = new URL(row[0].web_app.url)
  assert.equal(manage.searchParams.get('manage'), 'space')
  assert.equal(manage.searchParams.get('id'), 'rec1')
  assert.equal(row.length, 2)
  assert.equal(row[1].text, 'Delete')
  assert.equal(row[1].callback_data, 'dk:space:rec1')
  await bot.handlers.callback_query({ id: 'cb', from: { id: 7 }, message: { chat: { id: 7 } }, data: 'c:rec1' })
  await bot.handlers.message({ chat: { id: 7 }, from: { id: 7 }, text: '1:30-4:00' })
  const clipCall = calls.at(-1)
  assert.equal(clipCall.pathname, '/api/space/recordings/rec1/clips')
  assert.equal(clipCall.body.start_seconds, 90)
  assert.equal(clipCall.body.end_seconds, 240)
  assert.match(bot.sent.at(-1).text, /https:\/\/recorder\.example\.com\/api\/space\/clip\/clip1\/file\?play=1/)
})

test('/clips offers exact clip Manage and Delete', async () => {
  const { bot } = harness(async () => ({
    status: 200,
    json: [{ id: 'clip9', title: 'Intro', parent_title: 'Launch', duration_seconds: 30 }],
  }))
  await bot.handlers.message({ chat: { id: 7, type: 'private' }, from: { id: 7 }, text: '/clips' })
  const buttons = bot.sent[0].extra.reply_markup.inline_keyboard[0]
  assert.deepEqual(buttons.map(b => b.text), ['Manage', 'Delete'])
  const url = new URL(buttons[0].web_app.url)
  assert.equal(url.searchParams.get('manage'), 'clip')
  assert.equal(url.searchParams.get('id'), 'clip9')
  assert.equal(buttons[1].callback_data, 'dk:clip:clip9')
  assert.equal(bot.sent[0].text.includes('https://'), false)
})

test('poll announces a watched recording and a saved file link', async () => {
  let statusHits = 0
  const { bot, app } = harness(async (method, pathname) => {
    if (pathname === '/api/space/monitor/mon1') {
      return { status: 200, json: { state: 'recording', jobId: 'job9', title: 'Launch' } }
    }
    if (pathname === '/api/space/status/job9') {
      statusHits += 1
      if (statusHits === 1) return { status: 200, json: { state: 'downloading', recordedSecs: 1, sizeBytes: 10, name: 'Launch.m4a' } }
      return { status: 200, json: { state: 'ready', name: 'Launch.m4a' } }
    }
    throw new Error(`unexpected ${method} ${pathname}`)
  })
  app.monitors.set('mon1', { id: 'mon1', chatId: 7, title: 'Launch', jobId: null })
  await app.pollOnce()
  assert.match(bot.sent[0].text, /Recording started/)
  assert.deepEqual(bot.sent[0].extra.reply_markup.inline_keyboard[0].map(b => b.text),
    ['Listen so far', 'Stop & save', 'Delete'])
  await app.pollOnce()
  assert.match(bot.sent[1].text, /Recording Confirmed: Launch/)
  assert.equal(bot.sent[1].text.includes('https://'), false)
  assert.equal(app.active.size, 0)
})

test('/process lists active first with exact-item Manage and Delete', async () => {
  const calls = []
  const { bot } = harness(async (method, pathname) => {
    calls.push({ method, pathname })
    return {
      status: 200,
      json: {
        ok: true,
        active: [{
          id: 'active1', item_kind: 'space', title: 'Live first',
          state: 'downloading', duration_seconds: 90,
        }],
        completed: [{
          id: 'done1', item_kind: 'space', title: 'Finished second',
          state: 'ready', duration_seconds: 180,
        }],
      },
    }
  })
  await bot.handlers.message({
    chat: { id: 7, type: 'private' }, from: { id: 7 }, text: '/process',
  })
  assert.deepEqual(calls, [{ method: 'GET', pathname: '/api/space/process' }])
  assert.equal(bot.sent.length, 2)
  assert.match(bot.sent[1].text, /Finished second/)
  assert.equal(bot.sent[1].text.includes('Live first'), false)
  const buttons = bot.sent[1].extra.reply_markup.inline_keyboard[0]
  assert.deepEqual(buttons.map(button => button.text), ['Manage', 'Delete', 'Archive'])
  assert.equal(buttons[1].callback_data, 'dk:space:done1')
  assert.equal(buttons[2].callback_data, 'ak:space:done1')
  const url = new URL(buttons[0].web_app.url)
  assert.equal(url.origin, 'https://recorder.example.com')
  assert.equal(url.searchParams.get('manage'), 'space')
  assert.equal(url.searchParams.get('id'), 'done1')
})

test('mini-app links use their own origin while audio retains recorder origin', async () => {
  const app = createRecorderBot({
    token: 'test-token',
    publicBaseUrl: 'https://recorder.example.com',
    miniAppBaseUrl: 'https://mini.example.com',
    Bot: FakeBot,
    polling: false,
    allowedUserIds: ['7'],
    request: async (method, path) => {
      if (path === '/api/space/process') {
        return { status: 200, json: {
          ok: true,
          active: [{
            id: 'live1', item_kind: 'space', title: 'Live',
            state: 'downloading', duration_seconds: 30,
          }],
          completed: [],
        } }
      }
      if (path === '/api/space/archive') {
        return { status: 200, json: [{
          id: 'rec1', title: 'Saved', kind: 'live',
          duration_seconds: 60, size_bytes: 100,
        }] }
      }
      if (path === '/api/space/clips') {
        return { status: 200, json: [{ id: 'clip9', title: 'Clip' }] }
      }
      if (method === 'POST' && path === '/api/space/recordings/rec1/clips') {
        return { status: 200, json: { id: 'clip1', title: 'Clip' } }
      }
      throw new Error(`Unexpected request: ${method} ${path}`)
    },
  })
  const message = text => ({
    chat: { id: 7, type: 'private' }, from: { id: 7 }, text,
  })
  await app.onMessage(message('/process'))
  assert.equal(app.bot.sent.at(-1).text, 'No completed unarchived recordings in Process.')

  await app.onMessage(message('/app'))
  assert.equal(
    app.bot.sent.at(-1).extra.reply_markup.inline_keyboard[0][0].web_app.url,
    'https://mini.example.com/'
  )

  await app.onMessage(message('/archive'))
  const archived = app.bot.sent.at(-1).extra.reply_markup.inline_keyboard[0][0]
  assert.equal(new URL(archived.web_app.url).origin, 'https://mini.example.com')
  assert.equal(new URL(archived.web_app.url).searchParams.get('id'), 'rec1')

  await app.onMessage(message('/clips'))
  const clip = app.bot.sent.at(-1).extra.reply_markup.inline_keyboard[0][0]
  assert.equal(new URL(clip.web_app.url).origin, 'https://mini.example.com')
  assert.equal(new URL(clip.web_app.url).searchParams.get('manage'), 'clip')
  assert.equal(new URL(clip.web_app.url).searchParams.get('id'), 'clip9')

  await app.onCallback({
    id: 'legacy-clip', from: { id: 7 },
    message: { chat: { id: 7 } }, data: 'c:rec1',
  })
  await app.onMessage(message('1:30-4:00'))
  const audio = app.bot.sent.at(-1).text.match(
    /https:\/\/recorder\.example\.com\/\S+/
  )
  assert.ok(audio)
  assertSignedPlayback(audio[0], '/api/space/clip/clip1/file')
})


test('archived clip cards route Manage and Delete to the clip, not its parent', async () => {
  const { bot } = harness(async () => ({
    status: 200, json: [{
      id: 'clip2', item_kind: 'clip', title: 'Independent clip',
      duration_seconds: 30, size_bytes: 100,
    }],
  }))
  await bot.handlers.message({
    chat: { id: 7, type: 'private' }, from: { id: 7 }, text: '/archive',
  })
  const buttons = bot.sent[0].extra.reply_markup.inline_keyboard[0]
  assert.deepEqual(buttons.map(b => b.text), ['Manage', 'Delete'])
  const url = new URL(buttons[0].web_app.url)
  assert.equal(url.searchParams.get('manage'), 'clip')
  assert.equal(url.searchParams.get('id'), 'clip2')
  assert.equal(buttons[1].callback_data, 'dk:clip:clip2')
})

for (const kind of ['space', 'clip']) {
  for (const prefix of ['dk', 'yk']) {
    test(`${prefix} ${kind} deletes directly using the exact item endpoint`, async () => {
      const calls = []
      const { bot } = harness(async (method, pathname) => {
        calls.push({ method, pathname })
        return { status: 200, json: {
          ok: true, purge_after: '2030-01-01T02:00:00.000Z',
        } }
      })
      await bot.handlers.callback_query({
        id: 'delete', from: { id: 7 },
        message: { chat: { id: 7 } }, data: `${prefix}:${kind}:item1`,
      })
      assert.deepEqual(calls, [{
        method: 'DELETE',
        pathname: kind === 'clip'
          ? '/api/space/clips/item1' : '/api/space/archive/item1',
      }])
      assert.equal(bot.sent.length, 1)
      assert.equal(bot.sent[0].extra, undefined)
      assert.match(bot.sent[0].text, /Deletion scheduled with a two-hour hold/)
      assert.match(bot.sent[0].text, /2030-01-01T02:00:00.000Z/)
    })
  }
}

test('overlapping Telegram Delete callbacks submit only once', async () => {
  const calls = []
  const { bot } = harness(async (method, pathname) => {
    calls.push({ method, pathname })
    return { status: 200, json: {
      ok: true, purge_after: '2030-01-01T02:00:00.000Z',
    } }
  })
  const query = {
    from: { id: 7 }, message: { chat: { id: 7 } }, data: 'dk:clip:clip1',
  }
  await Promise.all([
    bot.handlers.callback_query({ ...query, id: 'first' }),
    bot.handlers.callback_query({ ...query, id: 'second' }),
  ])
  assert.equal(calls.length, 1)
  assert.equal(bot.sent.length, 1)
})

test('Telegram does not announce deletion without a verified hold response', async () => {
  for (const json of [
    { ok: true },
    { ok: true, purge_after: 'not-a-date' },
    { ok: false, purge_after: '2030-01-01T02:00:00.000Z' },
  ]) {
    const { bot } = harness(async () => ({ status: 200, json }))
    await bot.handlers.callback_query({
      id: 'unverified', from: { id: 7 },
      message: { chat: { id: 7 } }, data: 'dk:clip:clip1',
    })
    assert.match(bot.sent.at(-1).text, /hold could not be verified/)
    assert.doesNotMatch(bot.sent.at(-1).text, /Deletion scheduled/)
  }
})

test('Telegram Delete request failure does not expose exception details', async () => {
  const { bot } = harness(async () => {
    throw new Error('sensitive internal credential details')
  })
  await bot.handlers.callback_query({
    id: 'failure', from: { id: 7 },
    message: { chat: { id: 7 } }, data: 'dk:clip:clip1',
  })
  assert.match(bot.sent.at(-1).text, /hold could not be verified/)
  assert.doesNotMatch(bot.sent.at(-1).text, /sensitive|credential/)
})

test('malformed typed and legacy Delete callbacks never reach the backend', async () => {
  let calls = 0
  const { bot } = harness(async () => { calls++; return {} })
  for (const data of [
    'dk:clip:../outside', 'dk:unknown:item1',
    'yk:space:item1:extra', 'd:item1:extra', 'y:../outside',
  ]) {
    await bot.handlers.callback_query({
      id: data, from: { id: 7 }, message: { chat: { id: 7 } }, data,
    })
    assert.match(bot.sent.at(-1).text, /Invalid Delete action/)
  }
  assert.equal(calls, 0)
})

test('non-private collection cards use an exact-item URL rather than web_app', async () => {
  const { bot } = harness(async () => ({
    status: 200, json: [{ id: 'clip2', item_kind: 'clip', title: 'Clip' }],
  }))
  await bot.handlers.message({
    chat: { id: 7, type: 'group' }, from: { id: 7 }, text: '/archive',
  })
  const button = bot.sent.at(-1).extra.reply_markup.inline_keyboard[0][0]
  assert.equal(button.web_app, undefined)
  const url = new URL(button.url)
  assert.equal(url.searchParams.get('manage'), 'clip')
  assert.equal(url.searchParams.get('id'), 'clip2')
})

test('an unauthorized Telegram user cannot invoke direct Delete', async () => {
  let calls = 0
  const app = createRecorderBot({
    token: 'test-token',
    publicBaseUrl: 'https://recorder.example.com',
    allowedUserIds: ['7'], Bot: FakeBot, polling: false,
    request: async () => { calls++; return {} },
  })
  await app.onCallback({
    id: 'unauthorized', from: { id: 8 },
    message: { chat: { id: 8 } }, data: 'dk:clip:clip1',
  })
  assert.equal(calls, 0)
})


test('Markdown URL label and destination resolve to one clean Space input', () => {
  const url = 'https://x.com/i/spaces/1wGWjleBngeKQ'
  assert.equal(extractRecordInput(`/record [${url}](${url})`), url)
})

test('Markdown text labels and angle-wrapped destinations are supported', () => {
  const url = 'https://x.com/i/spaces/1wGWjleBngeKQ'
  assert.equal(extractRecordInput(`/record [Join Space](${url})`), url)
  assert.equal(extractRecordInput(`/record [Join Space](<${url}>)`), url)
  assert.equal(extractRecordInput('/record 1wGWjleBngeKQ'), '1wGWjleBngeKQ')
})

test('Markdown conflicting Space references and misleading external destinations are rejected', () => {
  const first = 'https://x.com/i/spaces/1wGWjleBngeKQ'
  const second = 'https://x.com/i/spaces/1ypKdkAbCdEfGh'
  assert.equal(extractRecordInput(`/record [${first}](${second})`), null)
  assert.equal(extractRecordInput(`/record ${first} ${second}`), null)
  assert.equal(extractRecordInput(`/record [${first}](https://example.com/)`), null)
})

test('same Space repeated with different tracking queries is not ambiguous', () => {
  const first = 'https://x.com/i/spaces/1wGWjleBngeKQ?s=20'
  const second = 'https://x.com/i/spaces/1wGWjleBngeKQ'
  assert.equal(extractRecordInput(`/record ${first} ${second}`), first)
})

test('actual bot handler accepts the reported Markdown link without a Usage response', async () => {
  const url = 'https://x.com/i/spaces/1wGWjleBngeKQ'
  for (const text of [
    `/record [${url}](${url})`,
    `/record [Join Space](${url})`,
  ]) {
    const calls = []
    const { bot } = harness(async (method, pathname, body) => {
      calls.push({ method, pathname, body })
      if (pathname === '/api/space/resolve') {
        return { status: 200, json: {
          ok: true, live: true,
          title: 'Not a crybaby space',
          m3u8: 'https://media.example/isolated-test.m3u8',
        } }
      }
      if (pathname === '/api/space/download') {
        return { status: 200, json: { id: 'mock_markdown_job' } }
      }
      throw new Error('Unexpected mocked request')
    })
    await bot.handlers.message({
      chat: { id: 7, type: 'private' },
      from: { id: 7 },
      text,
    })
    const starts = calls.filter(call =>
      call.method === 'POST' && call.pathname === '/api/space/download')
    assert.equal(starts.length, 1)
    assert.ok(String(starts[0].body.input).includes('1wGWjleBngeKQ'))
    assert.ok(bot.sent.some(message => /Recording started/.test(message.text)))
    assert.equal(bot.sent.some(message => /Usage:/.test(message.text)), false)
  }
})

test('actual bot handler never submits conflicting Markdown Space targets', async () => {
  let calls = 0
  const { bot } = harness(async () => {
    calls++
    throw new Error('Conflicting input must not reach the backend')
  })
  await bot.handlers.message({
    chat: { id: 7, type: 'private' },
    from: { id: 7 },
    text: '/record [https://x.com/i/spaces/1wGWjleBngeKQ](https://x.com/i/spaces/1ypKdkAbCdEfGh)',
  })
  assert.equal(calls, 0)
})

