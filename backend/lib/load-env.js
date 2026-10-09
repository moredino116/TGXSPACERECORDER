const fs = require('fs')
const path = require('path')

// Fill any unset variables from backend/.env. Existing process env wins,
// and values are never printed.
function loadEnv(envPath = path.join(__dirname, '..', '.env')) {
  if (!fs.existsSync(envPath)) return
  const text = fs.readFileSync(envPath, 'utf8').replace(/^\uFEFF/, '')
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq < 1) continue
    const key = trimmed.slice(0, eq).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
    if (process.env[key]) continue
    let value = trimmed.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    process.env[key] = value
  }
}

module.exports = { loadEnv }
