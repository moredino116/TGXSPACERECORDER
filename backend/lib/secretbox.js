// Encryption-at-rest for X account credentials.
//
// Uses AES-256-GCM (authenticated encryption). The key comes from an
// environment-managed secret when available (X_CONN_ENC_KEY / a KMS-injected
// value); otherwise the app generates a random key once and persists it in the
// `app_keys` table so encrypted connections survive restarts. Every ciphertext
// records which key version sealed it (`credential_key_version`), so keys can be
// rotated without losing access to older connections.
//
// SECURITY NOTES / LIMITATIONS (documented honestly):
//  - In a production multi-tenant deployment you should provide X_CONN_ENC_KEY
//    from a real KMS/secret manager so the key never lives beside the ciphertext.
//  - The generated-key fallback keeps the key in the same database as the
//    ciphertext, which is convenient for this single-tenant studio but is NOT
//    equivalent to KMS-backed separation. Set X_CONN_ENC_KEY to upgrade.

const crypto = require('crypto')
const { dbQuery } = require('./db')

const ALGO = 'aes-256-gcm'
const keyCache = new Map() // version -> Buffer(32)

function deriveFromEnv(secret) {
  // Accept any-length env secret; derive a stable 32-byte key.
  return crypto.createHash('sha256').update(String(secret)).digest()
}

// Durable session key provider v1
const durableActiveKey = require('./secretbox-key-store').createDurableKeyProvider({
  dbQuery, env: process.env, keyCache,
})
async function getActiveKey() {
  return durableActiveKey()
}

async function getKeyByVersion(version) {
  if (keyCache.has(version)) return keyCache.get(version)
  if (version === 'env' && process.env.X_CONN_ENC_KEY) {
    const k = deriveFromEnv(process.env.X_CONN_ENC_KEY)
    keyCache.set('env', k)
    return k
  }
  const { rows } = await dbQuery('SELECT key_hex FROM app_keys WHERE version = $1', [version])
  if (!rows[0]) throw new Error('Encryption key version not found: ' + version)
  const k = Buffer.from(rows[0].key_hex, 'hex')
  keyCache.set(version, k)
  return k
}

// Encrypt a UTF-8 string. Returns { ciphertext, keyVersion }. `ciphertext` is a
// self-describing "ivHex:tagHex:dataHex" string.
async function encryptSecret(plaintext) {
  const { version, key } = await getActiveKey()
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv(ALGO, key, iv)
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return {
    ciphertext: `${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`,
    keyVersion: version,
  }
}

async function decryptSecret(ciphertext, keyVersion) {
  const key = await getKeyByVersion(keyVersion)
  const [ivHex, tagHex, dataHex] = String(ciphertext).split(':')
  if (!ivHex || !tagHex || !dataHex) throw new Error('Malformed ciphertext')
  const decipher = crypto.createDecipheriv(ALGO, key, Buffer.from(ivHex, 'hex'))
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'))
  const dec = Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()])
  return dec.toString('utf8')
}

// Whether a KMS/env-managed key is in use (for surfacing security posture).
function usingManagedKey() {
  return !!process.env.X_CONN_ENC_KEY
}

module.exports = { encryptSecret, decryptSecret, usingManagedKey }
