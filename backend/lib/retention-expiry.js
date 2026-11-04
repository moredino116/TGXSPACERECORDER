const { createRetention } = require('./retention')

function createExpiryWorker({
  db, isBusy, now = () => Date.now(), enabled = false,
}) {
  if (typeof isBusy !== 'function') {
    throw new Error('A live-job busy check is required')
  }

  function runOnce() {
    const results = []
    const retention = createRetention(db, now)
    for (const [kind, table, column, state] of [
      ['space', 'recordings', 'state', 'ready'],
      ['clip', 'clips', 'status', 'completed'],
    ]) {
      const rows = db.prepare(
        `SELECT id, expires_at FROM ${table}
         WHERE archived_at IS NULL AND deleted_at IS NULL
         AND expires_at IS NOT NULL AND ${column} = ?`
      ).all(state)

      for (const row of rows) {
        let value = String(row.expires_at)
        if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) {
          value = value.replace(' ', 'T') + 'Z'
        }
        const expiry = Date.parse(value)
        if (!Number.isFinite(expiry) || expiry > now()) continue
        if (isBusy(kind, row.id)) continue
        if (!enabled) {
          results.push({ kind, id: row.id, action: 'would-schedule' })
          continue
        }
        const item = retention.softDelete(kind, row.id)
        results.push({
          kind, id: row.id, action: 'scheduled',
          purge_after: item.purge_after,
        })
      }
    }
    return results
  }

  return { runOnce }
}

module.exports = { createExpiryWorker }
