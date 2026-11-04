const fs = require('node:fs')
const path = require('node:path')
// Export artifact purge integration v1
const {
  sourceHasExportWork, planSourceExportCleanup,
} = require('./export-artifacts')

function createPurgeWorker({
  db,
  archiveDir,
  exportDir = path.join(path.dirname(path.resolve(archiveDir)), 'exports'),
  isBusy,
  now = () => Date.now(),
  enabled = false,
}) {
  if (typeof isBusy !== 'function') {
    throw new Error('A live-job busy check is required')
  }
  const root = path.resolve(archiveDir)

  function timestamp(value) {
    if (!value) return null
    const text = String(value)
    const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text)
      ? text.replace(' ', 'T') + 'Z'
      : text
    const result = Date.parse(normalized)
    return Number.isFinite(result) ? result : null
  }

  function runOnce() {
    const results = []
    db.exec('BEGIN IMMEDIATE')
    try {
      for (const [kind, table, stateColumn, terminalStates, extensions] of [
        ['space', 'recordings', 'state', ['ready', 'error'],
          ['.m4a', '.aac', '.raw']],
        ['clip', 'clips', 'status', ['completed', 'failed'], ['.m4a']],
      ]) {
        const rows = db.prepare(
          `SELECT * FROM ${table} WHERE deleted_at IS NOT NULL`
        ).all()

        for (const row of rows) {
          const deadline = timestamp(row.purge_after)
          const deleted = timestamp(row.deleted_at)
          if (deadline === null || deleted === null) continue
          if (deadline - deleted < 7200000 || deadline > now()) continue
          if (!/^[A-Za-z0-9_-]{1,100}$/.test(row.id)) continue
          if (!terminalStates.includes(row[stateColumn])) continue
          if (isBusy(kind, row.id) ||
              sourceHasExportWork(db, kind, row.id)) continue

          if (!enabled) {
            results.push({ kind, id: row.id, action: 'would-purge' })
            continue
          }

          try {
            const cleanExports = planSourceExportCleanup(
              db, exportDir, kind, row.id
            )
            for (const extension of extensions) {
              const file = path.join(root, row.id + extension)
              try {
                fs.unlinkSync(file)
              } catch (error) {
                if (error.code !== 'ENOENT') throw error
              }
            }
            cleanExports()
            db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(row.id)
            results.push({ kind, id: row.id, action: 'purged' })
          } catch (error) {
            results.push({
              kind, id: row.id, action: 'retry',
              error: String(error.message || error),
            })
          }
        }
      }
      db.exec('COMMIT')
      return results
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }

  return { runOnce }
}

module.exports = { createPurgeWorker }
