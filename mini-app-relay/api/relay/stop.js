const { authorize, forward, readBody, safeId } = require('../../lib/relay')

module.exports = async function stop(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.' })
  const auth = authorize(req)
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error })
  const body = readBody(req)
  const id = String(body?.id || '')
  if (!safeId(id)) return res.status(400).json({ error: 'A recording id is required.' })
  return forward(req, res, { method: 'POST', path: `/api/relay/stop/${id}` })
}
