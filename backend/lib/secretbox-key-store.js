// Durable session key provider v1. No database or environment-file imports.
const crypto = require('node:crypto')
function createDurableKeyProvider({ dbQuery, env = {}, keyCache = new Map() }) {
  function checked(row) {
    if (!row || typeof row.version !== 'string' || !row.version ||
        typeof row.key_hex !== 'string' || !/^[a-f0-9]{64}$/i.test(row.key_hex)) {
      throw new Error('Invalid persisted key')
    }
    const key = Buffer.from(row.key_hex, 'hex')
    keyCache.set(row.version, key)
    return { version: row.version, key }
  }
  return async function getActiveKey() {
    if (env.X_CONN_ENC_KEY) {
      if (!keyCache.has('env')) {
        keyCache.set('env', crypto.createHash('sha256')
          .update(String(env.X_CONN_ENC_KEY)).digest())
      }
      return { version: 'env', key: keyCache.get('env') }
    }
    try {
      const found = await dbQuery(
        'SELECT version, key_hex FROM app_keys ORDER BY created_at DESC LIMIT 1'
      )
      if (!Array.isArray(found?.rows)) throw new Error('Invalid storage response')
      if (found.rows.length) return checked(found.rows[0])
      const candidate = crypto.randomBytes(32)
      await dbQuery(
        'INSERT INTO app_keys (version, key_hex) VALUES ($1, $2) ON CONFLICT (version) DO NOTHING',
        ['v1', candidate.toString('hex')]
      )
      const confirmed = await dbQuery(
        'SELECT key_hex FROM app_keys WHERE version = $1', ['v1']
      )
      if (!Array.isArray(confirmed?.rows) || confirmed.rows.length !== 1) {
        throw new Error('Persistence not confirmed')
      }
      return checked({ version: 'v1', key_hex: confirmed.rows[0].key_hex })
    } catch {
      const error = new Error('Session credential storage is temporarily unavailable.')
      error.code = 'X_SESSION_KEY_UNAVAILABLE'
      throw error
    }
  }
}
module.exports = { createDurableKeyProvider }
