module.exports = function health(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return res.status(405).json({ error: 'Method not allowed.' })
  }
  res.setHeader('Cache-Control', 'no-store')
  return res.status(200).json({ ok: true })
}
