const { test } = require('node:test')
const assert = require('node:assert/strict')
const express = require('express')
const { createRelayRouter } = require('../routes/relay')

const KEY = 'test-relay-key'

async function withRelay(call, fn) {
  const previous = {
    key: process.env.RECORDER_RELAY_KEY,
    base: process.env.TELEGRAM_PUBLIC_BASE_URL,
  }
  process.env.RECORDER_RELAY_KEY = KEY
  process.env.TELEGRAM_PUBLIC_BASE_URL = 'https://recorder.example.com'
  const app = express()
  app.use(express.json())
  app.use('/api/relay', createRelayRouter({ call }))
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening))
  })
  try {
    await fn(`http://127.0.0.1:${server.address().port}`)
  } finally {
    if (previous.key == null) delete process.env.RECORDER_RELAY_KEY
    else process.env.RECORDER_RELAY_KEY = previous.key
    if (previous.base == null) delete process.env.TELEGRAM_PUBLIC_BASE_URL
    else process.env.TELEGRAM_PUBLIC_BASE_URL = previous.base
    await new Promise((resolve) => server.close(resolve))
  }
}

function headers(extra = {}) {
  return { 'content-type': 'application/json', 'x-recorder-relay-key': KEY, ...extra }
}

test('archive requires the relay key and adds playback links', async () => {
  let calls = 0
  await withRelay(async () => {
    calls += 1
    return {
      status: 200,
      json: [{ id: 'rec1', title: 'Hello', x_connection_id: 'conn-1', duration_seconds: 12 }],
    }
  }, async (base) => {
    const denied = await fetch(`${base}/api/relay/archive`)
    assert.equal(denied.status, 401)
    assert.equal(calls, 0)

    const wrong = await fetch(`${base}/api/relay/archive`, { headers: { 'x-recorder-relay-key': 'nope' } })
    assert.equal(wrong.status, 401)
    assert.equal(calls, 0)

    const allowed = await fetch(`${base}/api/relay/archive`, { headers: headers() })
    assert.equal(allowed.status, 200)
    const body = await allowed.json()
    assert.equal(body[0].x_connection_id, undefined)
    assert.equal(body[0].previewUrl, 'https://recorder.example.com/api/space/preview/rec1')
    assert.equal(body[0].fileUrl, 'https://recorder.example.com/api/space/file/rec1')
    assert.equal(calls, 1)
  })
})

test('record resolves then starts, and does not leak the stream URL or connection fields', async () => {
  const calls = []
  await withRelay(async (method, pathname, body) => {
    calls.push({ method, pathname, body })
    if (pathname === '/api/space/resolve') {
      return { status: 200, json: { ok: true, m3u8: 'https://audio.example/a.m3u8', title: 'Live', live: true } }
    }
    return { status: 200, json: { id: 'job1', kind: 'live' } }
  }, async (base) => {
    const response = await fetch(`${base}/api/relay/record`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        input: 'https://x.com/i/spaces/1ypKdkExample',
        accessMode: 'connected_account',
        xConnectionId: 'conn-1',
        cookie: 'nope',
      }),
    })
    assert.equal(response.status, 201)
    const body = await response.json()
    assert.equal(body.id, 'job1')
    assert.equal(body.m3u8, undefined)
    assert.equal(body.previewUrl, 'https://recorder.example.com/api/space/preview/job1')
  })
  assert.equal(calls.length, 2)
  assert.equal(calls[0].body.accessMode, undefined)
  assert.equal(calls[0].body.xConnectionId, undefined)
  assert.equal(calls[0].body.cookie, undefined)
  assert.equal(calls[1].pathname, '/api/space/download')
  assert.equal(calls[1].body.m3u8, 'https://audio.example/a.m3u8')
  assert.equal(calls[1].body.accessMode, undefined)
  assert.equal(calls[1].body.source, 'relay')
})

test('a Space that is not ready does not start a download', async () => {
  const calls = []
  await withRelay(async (method, pathname) => {
    calls.push(pathname)
    return { status: 200, json: { ok: false, reason: 'Not live yet' } }
  }, async (base) => {
    const response = await fetch(`${base}/api/relay/record`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ input: 'https://x.com/i/spaces/1ypKdkExample' }),
    })
    assert.equal(response.status, 422)
    assert.deepEqual(await response.json(), { error: 'Not live yet', title: null })
  })
  assert.deepEqual(calls, ['/api/space/resolve'])
})

test('clip and stop reject ids that are not recorder ids', async () => {
  let calls = 0
  await withRelay(async () => {
    calls += 1
    return { status: 200, json: { ok: true } }
  }, async (base) => {
    const clip = await fetch(`${base}/api/relay/clip`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ recording_id: '../etc', start_seconds: 1, end_seconds: 5 }),
    })
    assert.equal(clip.status, 400)
    const stop = await fetch(`${base}/api/relay/stop/has.dot`, { method: 'POST', headers: headers() })
    assert.equal(stop.status, 400)
  })
  assert.equal(calls, 0)
})

test('clip forwards a safe recording id and adds a playback link', async () => {
  const calls = []
  await withRelay(async (method, pathname, body) => {
    calls.push({ method, pathname, body })
    return { status: 200, json: { id: 'c123', status: 'completed', title: 'Clip' } }
  }, async (base) => {
    const response = await fetch(`${base}/api/relay/clip`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ recording_id: 'rec1', title: 'Open', start_seconds: 90, end_seconds: 120 }),
    })
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.clipUrl, 'https://recorder.example.com/api/space/clip/c123/file?play=1')
  })
  assert.equal(calls[0].pathname, '/api/space/recordings/rec1/clips')
  assert.equal(calls[0].body.title, 'Open')
  assert.equal(calls[0].body.start_seconds, 90)
})
