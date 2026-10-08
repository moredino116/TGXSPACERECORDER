const { authorize, forward, queryOf, safeId } = require('../../lib/relay')

module.exports = async function archive(req, res) {
  const auth = authorize(req)
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error })

  if (req.method === 'GET' || req.method === 'HEAD') {
    return forward(req, res, { method: 'GET', path: '/api/relay/archive' })
  }
  if (req.method === 'DELETE') {
    const id = String(queryOf(req).id || '')
    if (!safeId(id)) return res.status(400).json({ error: 'A recording id is required.' })
    return forward(req, res, { method: 'DELETE', path: `/api/relay/archive/${id}` })
  }
  return res.status(405).json({ error: 'Method not allowed.' })
}
