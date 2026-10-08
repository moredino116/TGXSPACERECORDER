const { authorize, forward, queryOf, readBody, safeId } = require('../../lib/relay')

module.exports = async function monitor(req, res) {
  const auth = authorize(req)
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error })

  if (req.method === 'GET' || req.method === 'HEAD') {
    const id = String(queryOf(req).id || '')
    if (!safeId(id)) return res.status(400).json({ error: 'A monitor id is required.' })
    return forward(req, res, { method: 'GET', path: `/api/relay/monitor/${id}` })
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.' })
  const body = readBody(req)
  if (!body) return res.status(400).json({ error: 'A Space link or ID is required.' })

  if (body.cancel === true) {
    const id = String(body.id || '')
    if (!safeId(id)) return res.status(400).json({ error: 'A monitor id is required.' })
    return forward(req, res, { method: 'POST', path: `/api/relay/monitor/${id}/cancel` })
  }

  const input = typeof body.input === 'string' ? body.input.trim() : ''
  if (!input || input.length > 500) return res.status(400).json({ error: 'A Space link or ID is required.' })
  return forward(req, res, {
    method: 'POST',
    path: '/api/relay/monitor',
    body: { input, enhance: body.enhance !== false },
  })
}
