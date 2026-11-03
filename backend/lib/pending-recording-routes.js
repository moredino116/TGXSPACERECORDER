const { xConnectionOwnerGuard } = require('./x-connection-owner')
const { createPendingRecordingStore } = require('./pending-recording-store')
const { createPendingRecordingRetry } = require('./pending-recording-retry')

async function localForward(req, method, pathname, body) {
  if (!(method === 'POST' &&
        ['/api/space/resolve', '/api/space/download'].includes(pathname)) &&
      !(method === 'GET' &&
        /^\/api\/space\/status\/[A-Za-z0-9_-]{1,100}$/.test(pathname))) {
    throw new Error('Unsupported internal action')
  }
  const port = req.socket?.localPort
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Recorder listener unavailable')
  }
  const response = await fetch('http://127.0.0.1:' + port + pathname, {
    method,
    signal: AbortSignal.timeout(15000),
    headers: {
      'content-type': 'application/json',
      'x-relay-key': req.headers['x-relay-key'],
      'x-relay-user': req.xConnectionOwner.user,
    },
    ...(method === 'GET' ? {} : { body: JSON.stringify(body) }),
  })
  return {
    status: response.status,
    json: await response.json().catch(() => null),
  }
}

function attachPendingRecordingRoutes(router, {
  getDb, forward = localForward,
}) {
  let store
  function getStore() {
    if (!store) store = createPendingRecordingStore(getDb())
    return store
  }
  function publicRequest(row) {
    return {
      ok: true, requestId: row.id, spaceId: row.space_id,
      state: row.state, jobId: row.job_id || null,
    }
  }
  function safe(fn) {
    return async (req, res) => {
      try {
        return await fn(req, res)
      } catch {
        return res.status(503).json({
          ok: false, code: 'request_storage_unavailable',
          error: 'Saved request status could not be confirmed.',
        })
      }
    }
  }

  router.get('/requests', xConnectionOwnerGuard, safe(async (req, res) => {
    const rows = getStore().listRecordingRequests(req.xConnectionOwner.user)
    return res.json({ ok: true, requests: rows.map(publicRequest) })
  }))

  router.post('/requests/:id/complete', xConnectionOwnerGuard, safe(async (req, res) => {
    const user = req.xConnectionOwner.user
    const row = getStore().get(req.params.id, user)
    if (!row) {
      return res.status(404).json({ ok: false, code: 'request_unavailable' })
    }
    if (row.state === 'completed') return res.json({ ok: true })
    if (row.state !== 'recording' ||
        !/^[A-Za-z0-9_-]{1,100}$/.test(row.job_id || '')) {
      return res.status(409).json({ ok: false, code: 'request_not_recording' })
    }
    const status = await forward(
      req, 'GET', '/api/space/status/' + row.job_id
    )
    if (status.status !== 200 ||
        !['ready', 'error'].includes(status.json?.state)) {
      return res.status(409).json({ ok: false, code: 'job_not_terminal' })
    }
    const completed = getStore().finishTracking(row.id, user, row.job_id)
    if (!completed) {
      return res.status(409).json({ ok: false, code: 'request_changed' })
    }
    return res.json({ ok: true })
  }))

  router.post('/requests', xConnectionOwnerGuard, safe(async (req, res) => {
    const user = req.xConnectionOwner.user
    const spaceId = req.body?.spaceId
    if (typeof spaceId !== 'string' ||
        !/^[A-Za-z0-9]{10,64}$/.test(spaceId)) {
      return res.status(400).json({ ok: false, code: 'invalid_space' })
    }
    return res.json(publicRequest(getStore().enqueue({
      ownerId: user, chatId: user, spaceId,
    })))
  }))

  router.get('/requests/:id', xConnectionOwnerGuard, safe(async (req, res) => {
    const row = getStore().get(req.params.id, req.xConnectionOwner.user)
    if (!row) {
      return res.status(404).json({ ok: false, code: 'request_unavailable' })
    }
    return res.json(publicRequest(row))
  }))

  router.post('/requests/:id/resume', xConnectionOwnerGuard, safe(async (req, res) => {
    const retry = createPendingRecordingRetry({
      store: getStore(),
      getConnection: async (id, user) => getDb().prepare(`
        SELECT id, workspace_id, user_id, status
        FROM x_connections
        WHERE id=? AND workspace_id=? AND user_id=?
      `).get(id, 'telegram:' + user, user) || null,
      resolve: ({ ownerId, ...body }) =>
        forward(req, 'POST', '/api/space/resolve', body),
      start: ({ ownerId, body }) =>
        forward(req, 'POST', '/api/space/download', body),
    })
    const result = await retry.resume({
      ownerId: req.xConnectionOwner.user,
      requestId: req.params.id,
      connectionId: req.body?.connectionId,
    })
    return res.status(result.status).json(result.json)
  }))
}

module.exports = { attachPendingRecordingRoutes }

