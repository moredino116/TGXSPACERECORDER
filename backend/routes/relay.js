const express = require('express')
const { requireRelay } = require('../middleware/verify-relay')

function safeId(id) {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(String(id || ''))
}

function publicBase() {
  return String(process.env.TELEGRAM_PUBLIC_BASE_URL || process.env.RECORDER_ORIGIN || '').replace(/\/+$/, '')
}

function playbackLinks(id) {
  const base = publicBase()
  if (!base || !safeId(id)) return {}
  return {
    previewUrl: `${base}/api/space/preview/${id}`,
    fileUrl: `${base}/api/space/file/${id}`,
  }
}

function clipLink(id) {
  const base = publicBase()
  if (!base || !safeId(id)) return {}
  return { clipUrl: `${base}/api/space/clip/${id}/file?play=1` }
}

function readInput(body) {
  const input = String(body?.input || '').trim()
  if (!input || input.length > 500) return null
  return input
}

function sendJson(res, status, json) {
  res.status(status).json(json == null ? { error: 'Empty recorder response.' } : json)
}

async function defaultCall(method, pathname, body) {
  const port = Number(process.env.BACKEND_PORT || process.env.PORT || 3001)
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    headers: {
      Accept: 'application/json',
      ...(body == null ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body == null ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  let json = null
  if (text) {
    try {
      json = JSON.parse(text)
    } catch {
      json = { error: text.slice(0, 300) }
    }
  }
  return { status: response.status, json }
}

function createRelayRouter({ call = defaultCall, guard = requireRelay } = {}) {
  const router = express.Router()
  router.use(guard)

  async function forward(res, method, pathname, body, map) {
    try {
      const upstream = await call(method, pathname, body)
      const json = map ? map(upstream.json) : upstream.json
      sendJson(res, upstream.status || 502, json)
    } catch {
      res.status(502).json({ error: 'The recorder could not be reached.' })
    }
  }

  router.get('/archive', (_req, res) =>
    forward(res, 'GET', '/api/space/archive', null, (json) => {
      if (!Array.isArray(json)) return json
      return json.map((row) => {
        if (!row || typeof row !== 'object') return row
        const rest = { ...row }
        delete rest.x_connection_id
        return { ...rest, ...playbackLinks(row.id) }
      })
    })
  )

  router.delete('/archive/:id', (req, res) => {
    if (!safeId(req.params.id)) return res.status(400).json({ error: 'A recording id is required.' })
    return forward(res, 'DELETE', `/api/space/archive/${req.params.id}`)
  })

  router.get('/status/:id', (req, res) => {
    if (!safeId(req.params.id)) return res.status(400).json({ error: 'A recording id is required.' })
    return forward(res, 'GET', `/api/space/status/${req.params.id}`, null, (json) => {
      if (!json || typeof json !== 'object' || Array.isArray(json)) return json
      return { ...json, ...playbackLinks(req.params.id) }
    })
  })

  router.post('/stop/:id', (req, res) => {
    if (!safeId(req.params.id)) return res.status(400).json({ error: 'A recording id is required.' })
    return forward(res, 'POST', `/api/space/stop/${req.params.id}`)
  })

  router.post('/record', async (req, res) => {
    const input = readInput(req.body)
    if (!input) return res.status(400).json({ error: 'A Space link or ID is required.' })
    const enhance = req.body?.enhance !== false
    try {
      const resolved = await call('POST', '/api/space/resolve', { input })
      const found = resolved.json || {}
      if (!found.ok || !found.m3u8) {
        return res.status(422).json({
          error: found.reason || found.error || 'That Space is not ready to record yet.',
          title: found.title || null,
        })
      }
      const started = await call('POST', '/api/space/download', {
        m3u8: found.m3u8,
        name: found.title || 'Space',
        title: found.title || null,
        source: 'relay',
        input,
        enhance,
      })
      const job = started.json || {}
      if (!job.id) {
        return res.status(started.status || 502).json({ error: job.error || 'Could not start the recording.' })
      }
      return res.status(201).json({
        id: job.id,
        title: found.title || null,
        live: !!found.live,
        state: 'downloading',
        ...playbackLinks(job.id),
      })
    } catch {
      return res.status(502).json({ error: 'The recorder could not be reached.' })
    }
  })

  router.post('/monitor', (req, res) => {
    const input = readInput(req.body)
    if (!input) return res.status(400).json({ error: 'A Space link or ID is required.' })
    return forward(res, 'POST', '/api/space/monitor', {
      input,
      name: typeof req.body?.name === 'string' ? req.body.name.slice(0, 200) : undefined,
      enhance: req.body?.enhance !== false,
    })
  })

  router.get('/monitor/:id', (req, res) => {
    if (!safeId(req.params.id)) return res.status(400).json({ error: 'A monitor id is required.' })
    return forward(res, 'GET', `/api/space/monitor/${req.params.id}`, null, (json) => {
      if (!json || typeof json !== 'object' || Array.isArray(json)) return json
      return { ...json, ...(json.jobId ? playbackLinks(json.jobId) : {}) }
    })
  })

  router.post('/monitor/:id/cancel', (req, res) => {
    if (!safeId(req.params.id)) return res.status(400).json({ error: 'A monitor id is required.' })
    return forward(res, 'POST', `/api/space/monitor/${req.params.id}/cancel`)
  })

  router.get('/clips', (_req, res) =>
    forward(res, 'GET', '/api/space/clips', null, (json) => {
      if (!Array.isArray(json)) return json
      return json.map((row) => (row && typeof row === 'object' ? { ...row, ...clipLink(row.id) } : row))
    })
  )

  router.get('/recordings/:id/clips', (req, res) => {
    if (!safeId(req.params.id)) return res.status(400).json({ error: 'A recording id is required.' })
    return forward(res, 'GET', `/api/space/recordings/${req.params.id}/clips`, null, (json) => {
      if (!Array.isArray(json)) return json
      return json.map((row) => (row && typeof row === 'object' ? { ...row, ...clipLink(row.id) } : row))
    })
  })

  router.post('/clip', (req, res) => {
    const id = req.body?.recording_id
    if (!safeId(id)) return res.status(400).json({ error: 'A recording id is required.' })
    return forward(res, 'POST', `/api/space/recordings/${id}/clips`, {
      title: req.body?.title,
      start_seconds: req.body?.start_seconds,
      end_seconds: req.body?.end_seconds,
      enhance: req.body?.enhance !== false,
    }, (json) => {
      if (!json || typeof json !== 'object' || Array.isArray(json)) return json
      return { ...json, ...clipLink(json.id) }
    })
  })

  router.delete('/clips/:id', (req, res) => {
    if (!safeId(req.params.id)) return res.status(400).json({ error: 'A clip id is required.' })
    return forward(res, 'DELETE', `/api/space/clips/${req.params.id}`)
  })

  return router
}

module.exports = createRelayRouter()
module.exports.createRelayRouter = createRelayRouter
module.exports.safeId = safeId
