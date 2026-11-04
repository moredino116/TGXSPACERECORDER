const test = require('node:test')
const assert = require('node:assert/strict')
const { createRecorderBot } = require('../telegram-bot')

const url = 'https://x.com/i/spaces/1rxmqpPayldxy?s=20'

function setup({ connected = false } = {}) {
  const calls = []
  const sent = []
  class FakeBot {
    on() {}
    async sendMessage(chatId, text, extra) {
      sent.push({ chatId, text, extra })
    }
  }
  const app = createRecorderBot({
    token: 'test-only',
    relayKey: 'staging-test-only-not-a-production-key',
    publicBaseUrl: 'https://recorder.example',
    miniAppBaseUrl: 'https://mini.example',
    allowedUserIds: ['42'],
    Bot: FakeBot,
    request: async (method, path, body, options) => {
      calls.push({ method, path, body, options })
      if (path === '/api/space/resolve') {
        if (connected && body.accessMode !== 'connected_account') {
          return { status: 200, json: {
            ok: false,
            code: 'x_access_denied',
            canTryConnectedAccount: true,
            reason: 'Account-assisted lookup required.',
          } }
        }
        return { status: 200, json: {
          ok: true, title: 'Mock Space', live: true,
          m3u8: 'https://media.example/mock.m3u8',
        } }
      }
      if (path === '/api/x-connections') {
        return { status: 200, json: [{ id: 'x_test', status: 'active' }] }
      }
      if (path === '/api/space/download') {
        return { status: 200, json: { id: 'mock_job' } }
      }
      throw new Error('Unexpected mocked endpoint: ' + path)
    },
  })
  return { app, calls, sent }
}

function message(extra = {}) {
  return {
    from: { id: 42 },
    chat: { id: 42, type: 'private' },
    ...extra,
  }
}

function hidden(text = '/record Open') {
  return message({
    text,
    entities: [{
      type: 'text_link', url,
      offset: text.indexOf('Open'), length: 4,
    }],
  })
}

test('actual handler records a hidden record-command link', async () => {
  const q = setup()
  await q.app.onMessage(hidden())
  const downloads = q.calls.filter(c => c.path === '/api/space/download')
  assert.equal(downloads.length, 1)
  assert.equal(downloads[0].body.input, url)
  assert.equal(q.app.active.size, 1)
})

test('actual handler accepts a caption-only hidden link', async () => {
  const q = setup()
  await q.app.onMessage(message({
    caption: 'Open',
    caption_entities: [{ type: 'text_link', url, offset: 0, length: 4 }],
  }))
  assert.equal(
    q.calls.filter(c => c.path === '/api/space/download').length, 1
  )
})

test('hidden link preserves owner headers and connected access through download', async () => {
  const q = setup({ connected: true })
  await q.app.onMessage(hidden())
  assert.equal(q.calls.length, 4)
  for (const call of q.calls) {
    assert.equal(call.options.headers['x-relay-user'], '42')
    assert.equal(
      call.options.headers['x-relay-key'],
      'staging-test-only-not-a-production-key'
    )
  }
  const download = q.calls.find(c => c.path === '/api/space/download')
  assert.equal(download.body.accessMode, 'connected_account')
  assert.equal(download.body.xConnectionId, 'x_test')
})

test('two different Space links cause no backend requests', async () => {
  const q = setup()
  await q.app.onMessage(message({
    text: url + '\nhttps://x.com/i/spaces/1qxoNYovYEzJv',
  }))
  assert.equal(q.calls.length, 0)
  assert.equal(q.app.active.size, 0)
  assert.match(q.sent[0].text, /one X Space link/i)
})

test('unauthorized hidden-link message causes no backend requests', async () => {
  const q = setup()
  await q.app.onMessage({
    ...hidden(),
    from: { id: 77 },
    chat: { id: 77, type: 'private' },
  })
  assert.equal(q.calls.length, 0)
  assert.equal(q.app.active.size, 0)
  assert.match(q.sent[0].text, /private/i)
})

test('help command with a hidden link does not start recording', async () => {
  const q = setup()
  await q.app.onMessage(hidden('/help Open'))
  assert.equal(q.calls.length, 0)
  assert.equal(q.app.active.size, 0)
})
