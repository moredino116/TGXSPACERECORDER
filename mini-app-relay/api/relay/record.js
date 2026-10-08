const { authorize, forward, readBody } = require('../../lib/relay')

module.exports = async function record(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.' })
  const auth = authorize(req)
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error })

  const body = readBody(req)
  const input = typeof body?.input === 'string' ? body.input.trim() : ''
  if (!input || input.length > 500) return res.status(400).json({ error: 'A Space link or ID is required.' })

  const payload = { input }
  if (body.enhance === false) payload.enhance = false
  return forward(req, res, { method: 'POST', path: '/api/relay/record', body: payload })
}
