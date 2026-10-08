const { test } = require('node:test')
const assert = require('node:assert/strict')
const http = require('http')
const express = require('express')
const { publicAccess, publicHostGuard } = require('../lib/public-host')

const env = {
  RECORDER_ORIGIN: 'https://recorder.example.com',
  TELEGRAM_PUBLIC_BASE_URL: 'https://recorder.example.com',
}

test('public hostname blocks recorder control and leaves playback open', () => {
  assert.equal(publicAccess({ headers: { host: 'recorder.example.com' }, method: 'GET', path: '/api/space/archive' }, env), 'allow')
  assert.equal(publicAccess({ headers: { host: 'recorder.example.com' }, method: 'GET', path: '/api/space/preview/abc123' }, env), 'allow')
  assert.equal(publicAccess({ headers: { host: 'recorder.example.com' }, method: 'GET', path: '/api/space/file/abc123' }, env), 'allow')
  assert.equal(publicAccess({ headers: { host: 'recorder.example.com' }, method: 'GET', path: '/api/space/clip/c123/file' }, env), 'allow')
  assert.equal(publicAccess({ headers: { host: 'recorder.example.com' }, method: 'POST', path: '/api/relay/record' }, env), 'allow')
  assert.equal(publicAccess({ headers: { host: 'recorder.example.com' }, method: 'POST', path: '/api/space/download' }, env), 'deny')
  assert.equal(publicAccess({ headers: { host: 'recorder.example.com' }, method: 'DELETE', path: '/api/space/archive/abc' }, env), 'deny')
  assert.equal(publicAccess({ headers: { host: 'recorder.example.com' }, method: 'GET', path: '/api/x-connections' }, env), 'deny')
  assert.equal(publicAccess({ headers: { host: 'recorder.example.com' }, method: 'GET', path: '/api/space/preview/../admin' }, env), 'deny')
})

test('localhost and a private origin keep the local API available', () => {
  assert.equal(publicAccess({ headers: { host: '127.0.0.1:3001' }, method: 'POST', path: '/api/space/download' }, env), 'allow')
  assert.equal(
    publicAccess(
      { headers: { host: '127.0.0.1:3001' }, method: 'POST', path: '/api/space/download' },
      { TELEGRAM_PUBLIC_BASE_URL: 'https://127.0.0.1:3001' }
    ),
    'allow'
  )
  assert.equal(publicAccess({ headers: { host: 'recorder.example.com' }, method: 'POST', path: '/api/space/download' }, {}), 'allow')
})

test('guard returns the relay error for a public control request', async () => {
  const app = express()
  app.use((req, _res, next) => {
    process.env.RECORDER_ORIGIN = 'https://recorder.example.com'
    process.env.TELEGRAM_PUBLIC_BASE_URL = 'https://recorder.example.com'
    next()
  })
  app.use(publicHostGuard)
  app.post('/api/space/download', (_req, res) => res.json({ ok: true }))
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening))
  })
  try {
    const response = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: server.address().port,
          path: '/api/space/download',
          method: 'POST',
          headers: { Host: 'recorder.example.com', 'Content-Type': 'application/json' },
        },
        (res) => {
          const chunks = []
          res.on('data', (chunk) => chunks.push(chunk))
          res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }))
        }
      )
      req.on('error', reject)
      req.end('{}')
    })
    assert.equal(response.status, 401)
    assert.deepEqual(JSON.parse(response.body), { error: 'Trusted relay authorization required.' })
  } finally {
    delete process.env.RECORDER_ORIGIN
    delete process.env.TELEGRAM_PUBLIC_BASE_URL
    await new Promise((resolve) => server.close(resolve))
  }
})
