// When a request arrives on the public recorder hostname, only playback,
// the archive smoke-test, and the key-checked relay routes stay open.
// Localhost keeps the full API for the recorder UI and the Telegram bot.

const PUBLIC_READS = [
  /^\/api\/space\/archive$/,
  /^\/api\/space\/preview\/[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/,
  /^\/api\/space\/file\/[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/,
  /^\/api\/space\/clip\/[A-Za-z0-9][A-Za-z0-9_-]{0,63}\/file$/,
]

function isPrivateHost(host) {
  return (
    host === 'localhost' ||
    host.endsWith('.local') ||
    host === '0.0.0.0' ||
    host === '::1' ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(host)
  )
}

function hostOf(raw) {
  try {
    const url = new URL(String(raw || ''))
    if (url.protocol !== 'https:') return ''
    const host = url.hostname.toLowerCase()
    if (!host || isPrivateHost(host)) return ''
    return host
  } catch {
    return ''
  }
}

function configuredPublicHosts(env = process.env) {
  const hosts = new Set()
  for (const raw of [env.RECORDER_ORIGIN, env.TELEGRAM_PUBLIC_BASE_URL]) {
    const host = hostOf(raw)
    if (host) hosts.add(host)
  }
  return hosts
}

function requestHost(req) {
  const raw = req.headers?.host || req.headers?.Host || ''
  return String(raw).split(':')[0].toLowerCase()
}

function publicAccess(req, env = process.env) {
  const hosts = configuredPublicHosts(env)
  if (!hosts.size || !hosts.has(requestHost(req))) return 'allow'
  const path = req.path || '/'
  const method = String(req.method || 'GET').toUpperCase()
  if (path === '/api/relay' || path.startsWith('/api/relay/')) return 'allow'
  if ((method === 'GET' || method === 'HEAD') && PUBLIC_READS.some((pattern) => pattern.test(path))) {
    return 'allow'
  }
  if (path === '/api' || path.startsWith('/api/')) return 'deny'
  return 'allow'
}

function publicHostGuard(req, res, next) {
  if (publicAccess(req) === 'deny') {
    return res.status(401).json({ error: 'Trusted relay authorization required.' })
  }
  next()
}

module.exports = { publicAccess, publicHostGuard, configuredPublicHosts }
