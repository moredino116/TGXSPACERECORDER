const test = require('node:test')
const assert = require('node:assert/strict')
const { resolveWithSavedSession } = require('../lib/telegram-x-fallback')
const { createRecorderBot } = require('../telegram-bot')

const rejected = {
  status: 200,
  json: {
    ok: false, code: 'x_authentication_rejected',
    canTryConnectedAccount: true,
  },
}

for (const [label, body] of [
  ['public success', { ok: true, m3u8: 'https://example.invalid/audio.m3u8' }],
  ['rate limit', { ok: false, code: 'x_rate_limited' }],
  ['network failure', { ok: false, code: 'x_unavailable' }],
  ['ambiguous empty lookup', { ok: false, code: 'space_lookup_empty' }],
]) {
  test(label + ' does not enumerate saved accounts', async () => {
    const calls = []
    const result = await resolveWithSavedSession({
      input: '1234567890',
      call: async (...args) => {
        calls.push(args)
        return { status: 200, json: body }
      },
    })
    assert.equal(calls.length, 1)
    assert.deepEqual(result.access, {})
  })
}

test('eligible failure retries once with the single active connection', async () => {
  const calls = []
  const result = await resolveWithSavedSession({
    input: '1234567890',
    call: async (...args) => {
      calls.push(args)
      if (calls.length === 1) return rejected
      if (calls.length === 2) {
        return { status: 200, json: [{ id: 'mine', status: 'active' }] }
      }
      return { status: 200, json: { ok: true, m3u8: 'test-only' } }
    },
  })
  assert.equal(calls.length, 3)
  assert.deepEqual(calls[2][2], {
    input: '1234567890', accessMode: 'connected_account',
    xConnectionId: 'mine',
  })
  assert.equal(result.access.xConnectionId, 'mine')
})

test('missing or inactive connection requests setup without a retry', async () => {
  for (const rows of [[], [{ id: 'mine', status: 'reauth_required' }]]) {
    let count = 0
    const result = await resolveWithSavedSession({
      input: '1234567890',
      call: async () => ++count === 1
        ? rejected : { status: 200, json: rows },
    })
    assert.equal(result.needsConnection, true)
    assert.equal(count, 2)
  }
})

test('multiple connections and failed listing never select an account', async () => {
  for (const listed of [
    { status: 200, json: [
      { id: 'one', status: 'active' }, { id: 'two', status: 'active' },
    ] },
    { status: 503, json: {} },
  ]) {
    let count = 0
    const result = await resolveWithSavedSession({
      input: '1234567890',
      call: async () => ++count === 1 ? rejected : listed,
    })
    assert.equal(result.stop, true)
    assert.equal(count, 2)
    assert.deepEqual(result.access, {})
  }
})

test('non-private flow never enumerates saved connections', async () => {
  let count = 0
  const result = await resolveWithSavedSession({
    input: '1234567890', allowConnected: false,
    call: async () => { count++; return rejected },
  })
  assert.equal(count, 1)
  assert.equal(result.needsConnection, true)
})

class FakeBot {
  constructor() { this.sent = [] }
  on() {}
  async sendMessage(chatId, text, extra) {
    this.sent.push({ chatId, text, extra })
  }
}

function makeBot(request) {
  return createRecorderBot({
    token: 'test-only', relayKey: 'test-only',
    publicBaseUrl: 'https://recorder.example',
    miniAppBaseUrl: 'https://mini.example',
    allowedUserIds: ['42'], Bot: FakeBot, request,
  })
}

test('actual bot forwards owner identity and connection selection into download', async () => {
  process.env.RECORDER_RELAY_KEY = 'test-playback-only'
  const calls = []
  let resolutions = 0
  const app = makeBot(async (method, path, body, options) => {
    calls.push({ method, path, body, options })
    if (path === '/api/x-connections') {
      return { status: 200, json: [{ id: 'mine', status: 'active' }] }
    }
    if (path === '/api/space/resolve') {
      if (++resolutions === 1) return rejected
      return { status: 200, json: {
        ok: true, title: 'Test',
        m3u8: 'https://example.invalid/audio.m3u8',
      } }
    }
    if (path === '/api/space/download') {
      return { status: 200, json: { id: 'job1' } }
    }
    throw new Error('Unexpected test request')
  })
  await app.onMessage({
    text: '/record 1234567890',
    from: { id: 42 }, chat: { id: 42, type: 'private' },
  })
  const download = calls.find(row => row.path === '/api/space/download')
  assert(download)
  assert.equal(download.body.accessMode, 'connected_account')
  assert.equal(download.body.xConnectionId, 'mine')
  assert(calls.every(row => row.options.headers['x-relay-user'] === '42'))
  assert.equal(app.active.size, 1)
})

test('connectx offers the mini-app only in a private chat', async () => {
  const app = makeBot(async () => {
    throw new Error('connectx must not call the backend')
  })
  await app.onMessage({
    text: '/connectx', from: { id: 42 },
    chat: { id: 42, type: 'private' },
  })
  const button = app.bot.sent[0].extra.reply_markup.inline_keyboard[0][0]
  assert.equal(button.web_app.url, 'https://mini.example/?connect=x')
  await app.onMessage({
    text: '/connectx', from: { id: 42 },
    chat: { id: -123, type: 'group' },
  })
  assert.equal(app.bot.sent[1].extra, undefined)
  assert(app.bot.sent[1].text.includes('private chat'))
})
