const { authorize, forward, queryOf, safeId } = require('../../lib/relay')

module.exports = async function status(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return res.status(405).json({ error: 'Method not allowed.' })
  }
  const auth = authorize(req)
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error })
  const id = String(queryOf(req).id || '')
  if (!safeId(id)) return res.status(400).json({ error: 'A recording id is required.' })
  return forward(req, res, { method: 'GET', path: `/api/relay/status/${id}` })
}
