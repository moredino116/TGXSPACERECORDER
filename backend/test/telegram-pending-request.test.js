const test = require('node:test')
const assert = require('node:assert/strict')
const { createRecorderBot } = require('../telegram-bot')

function setup(saveWorks) {
  const calls = []
  const sent = []
  class FakeBot {
    on() {}
    async sendMessage(chatId, text, extra) { sent.push({ text, extra }) }
  }
  const app = createRecorderBot({
    token: 'test-only',
    relayKey: 'test-only-relay-key',
    publicBaseUrl: 'https://recorder.example',
    miniAppBaseUrl: 'https://mini.example',
    allowedUserIds: ['42'],
    Bot: FakeBot,
    request: async (method, path, body, options) => {
      calls.push({ path, body, options })
      if (path === '/api/space/resolve') return {
        status: 200, json: {
          ok: false, code: 'x_access_denied',
          canTryConnectedAccount: true,
        },
      }
      if (path === '/api/x-connections') return { status: 200, json: [] }
      if (path === '/api/space/requests') return saveWorks
        ? { status: 200, json: { ok: true, requestId: 'pending_test' } }
        : { status: 503, json: { ok: false } }
      throw new Error('Unexpected backend action')
    },
  })
  return { app, calls, sent }
}

const message = {
  text: '/record https://x.com/i/spaces/1rxmqpPayldxy',
  from: { id: 42 }, chat: { id: 42, type: 'private' },
}

test('bot saves the owned request before offering its connection link', async () => {
  const q = setup(true)
  await q.app.onMessage(message)
  const saved = q.calls.find(c => c.path === '/api/space/requests')
  assert.equal(saved.body.spaceId, '1rxmqpPayldxy')
  assert.equal(saved.options.headers['x-relay-user'], '42')
  const link = q.sent.at(-1).extra.reply_markup.inline_keyboard[0][0].web_app.url
  assert.equal(new URL(link).searchParams.get('request'), 'pending_test')
  assert.equal(q.calls.some(c => c.path === '/api/space/download'), false)
})

test('failed persistence does not offer a misleading retry link', async () => {
  const q = setup(false)
  await q.app.onMessage(message)
  assert.match(q.sent.at(-1).text, /Could not confirm the saved recording request/)
  assert.equal(q.sent.at(-1).extra, undefined)
  assert.equal(q.calls.some(c => c.path === '/api/space/download'), false)
})

