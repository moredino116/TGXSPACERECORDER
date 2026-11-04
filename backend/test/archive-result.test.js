const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createRecorderBot } = require('../telegram-bot')
const { createSavedRequestTracker } =
  require('../lib/telegram-saved-request-tracker')
const { archiveUnconfirmed, completionText } = require('../lib/capture-result')

const source = fs.readFileSync(
  path.join(__dirname, '../routes/space.js'), 'utf8'
)
function extract(name) {
  const match = new RegExp(
    '^(?:async\\s+)?function\\s+' + name + '\\s*\\(', 'm'
  ).exec(source)
  assert.ok(match)
  const end = source.indexOf('\n}\n', match.index) + 2
  return source.slice(match.index, end)
}

async function archive(failures) {
  let attempts = 0
  const waits = []
  const errors = []
  const fn = vm.runInNewContext('(' + extract('archiveInsert') + ')', {
    require: require('node:module').createRequire(
      path.join(__dirname, '../routes/space.js')
    ),
    dbQuery: async () => {
      attempts++
      if (attempts <= failures) throw new Error('private database detail')
    },
    sleep: async ms => waits.push(ms),
    console: { error: (...args) => errors.push(args.join(' ')) },
  })
  const job = {
    id: 'mock_job', name: 'Mock', file: '/virtual/mock.m4a',
    recordedSecs: 12, sizeBytes: 100,
  }
  const result = await fn(job)
  return { result, job, attempts, waits, errors }
}

test('successful archive write reports indexed', async () => {
  const q = await archive(0)
  assert.equal(q.result, true)
  assert.equal(q.job.archiveStatus, 'indexed')
  assert.equal(q.attempts, 1)
})

test('transient archive failures retry within a bounded attempt count', async () => {
  const q = await archive(2)
  assert.equal(q.result, true)
  assert.equal(q.job.archiveStatus, 'indexed')
  assert.equal(q.attempts, 3)
  assert.deepEqual(q.waits, [250, 500])
})

test('persistent archive failure is explicit and does not expose database details', async () => {
  const q = await archive(10)
  assert.equal(q.result, false)
  assert.equal(q.attempts, 3)
  assert.equal(q.job.archiveStatus, 'failed')
  assert.equal(q.job.archiveError, 'archive_index_failed')
  assert.equal(q.job.file, '/virtual/mock.m4a')
  assert.equal(q.errors.join(' ').includes('private database detail'), false)
})

test('completion wording distinguishes partial and processing-fallback audio', () => {
  assert.match(completionText({ captureWarning: 'capture_interrupted' }), /partial/)
  assert.match(completionText({ captureWarning: 'processing_failed' }), /processing failed/)
  assert.match(completionText({ gaps: 2 }), /gaps/)
  assert.equal(completionText({}), 'Saved.')
})

test('archive confirmation guard preserves compatibility with legacy status', () => {
  assert.equal(archiveUnconfirmed({ archiveStatus: 'pending' }), true)
  assert.equal(archiveUnconfirmed({ archiveStatus: 'failed' }), true)
  assert.equal(archiveUnconfirmed({ archiveStatus: 'indexed' }), false)
  assert.equal(archiveUnconfirmed({}), false)
})

function botFixture(status) {
  const sent = []
  class FakeBot {
    on() {}
    async sendMessage(chatId, text) { sent.push(text) }
  }
  const app = createRecorderBot({
    token: 'test-only', relayKey: 'test-only-relay-key',
    publicBaseUrl: 'https://recorder.example',
    miniAppBaseUrl: 'https://mini.example',
    allowedUserIds: ['42'], Bot: FakeBot,
    request: async (method, route) => {
      if (route === '/api/space/resolve') return {
        status: 200, json: {
          ok: true, title: 'Mock', m3u8: 'https://media.example/mock.m3u8',
        },
      }
      if (route === '/api/space/download') return {
        status: 200, json: { id: 'mock_job' },
      }
      if (route === '/api/space/status/mock_job') return {
        status: 200, json: { state: 'ready', name: 'Mock', ...status },
      }
      throw new Error('Unexpected mocked action')
    },
  })
  return { app, sent }
}

test('ordinary bot keeps an unindexed job tracked and warns only once', async () => {
  const q = botFixture({ archiveStatus: 'failed' })
  await q.app.onMessage({
    text: '/record https://x.com/i/spaces/1rxmqpPayldxy',
    from: { id: 42 }, chat: { id: 42, type: 'private' },
  })
  await q.app.pollOnce()
  await q.app.pollOnce()
  assert.equal(q.app.active.size, 1)
  assert.equal(q.sent.filter(text => text.includes('indexing is not confirmed')).length, 1)
  assert.equal(q.sent.some(text => text.startsWith('Saved.')), false)
})

test('ordinary bot labels an indexed partial result accurately', async () => {
  const q = botFixture({
    archiveStatus: 'indexed', captureWarning: 'capture_interrupted',
  })
  await q.app.onMessage({
    text: '/record https://x.com/i/spaces/1rxmqpPayldxy',
    from: { id: 42 }, chat: { id: 42, type: 'private' },
  })
  await q.app.pollOnce()
  assert.equal(q.app.active.size, 0)
  assert.ok(q.sent.some(text => text.startsWith('Saved partial audio:')))
})

test('resumed-job tracker does not acknowledge an unindexed ready file', async () => {
  const active = new Map()
  const sent = []
  let acknowledgements = 0
  const tracker = createSavedRequestTracker({
    active, ownerIds: ['42'],
    send: async (chat, text) => sent.push(text),
    fileUrl: () => 'https://recorder.example/mock',
    clipLabel: value => value,
    call: async (method, route) => {
      if (route === '/api/space/requests') return {
        status: 200, json: { ok: true, requests: [{
          requestId: 'pending_test', jobId: 'mock_job',
          state: 'recording', spaceId: '1rxmqpPayldxy',
        }] },
      }
      if (route === '/api/space/status/mock_job') return {
        status: 200, json: { state: 'ready', archiveStatus: 'failed' },
      }
      acknowledgements++
      throw new Error('Completion acknowledgement must not run')
    },
  })
  await tracker.poll()
  await tracker.poll()
  assert.equal(acknowledgements, 0)
  assert.equal(active.size, 1)
  assert.equal(sent.length, 1)
  assert.match(sent[0], /indexing is not confirmed/)
})

test('reconciliation preservation guard still returns before destructive operations', async () => {
  const reconcile = vm.runInNewContext('(' + extract('reconcileGroup') + ')', {
    console: { log() {} },
  })
  await reconcile({ id: 'backup_test', groupId: 'group_test' })
})

