const { authorize, forward, queryOf, readBody, safeId } = require('../../lib/relay')

module.exports = async function clips(req, res) {
  const auth = authorize(req)
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error })

  if (req.method === 'GET' || req.method === 'HEAD') {
    const parent = String(queryOf(req).recording_id || '')
    if (parent) {
      if (!safeId(parent)) return res.status(400).json({ error: 'A recording id is required.' })
      return forward(req, res, { method: 'GET', path: `/api/relay/recordings/${parent}/clips` })
    }
    return forward(req, res, { method: 'GET', path: '/api/relay/clips' })
  }

  if (req.method === 'POST') {
    const body = readBody(req)
    if (!body || !safeId(body.recording_id)) return res.status(400).json({ error: 'A recording id is required.' })
    return forward(req, res, {
      method: 'POST',
      path: '/api/relay/clip',
      body: {
        recording_id: body.recording_id,
        title: typeof body.title === 'string' ? body.title.slice(0, 200) : undefined,
        start_seconds: body.start_seconds,
        end_seconds: body.end_seconds,
        enhance: body.enhance !== false,
      },
    })
  }

  if (req.method === 'DELETE') {
    const id = String(queryOf(req).id || '')
    if (!safeId(id)) return res.status(400).json({ error: 'A clip id is required.' })
    return forward(req, res, { method: 'DELETE', path: `/api/relay/clips/${id}` })
  }

  return res.status(405).json({ error: 'Method not allowed.' })
}
