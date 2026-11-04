const HOLD_MS = 2 * 60 * 60 * 1000

function createRetention(db, now = () => Date.now()) {
  function tableFor(kind) {
    if (kind === 'space') return 'recordings'
    if (kind === 'clip') return 'clips'
    throw new Error('Invalid item kind')
  }

  function transaction(fn) {
    db.exec('BEGIN IMMEDIATE')
    try {
      const result = fn()
      db.exec('COMMIT')
      return result
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }

  function read(table, id) {
    const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id)
    if (!row) throw new Error('Item not found')
    return row
  }

  function timestamp(value) {
    if (!value) return null
    const text = String(value)
    const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text)
      ? text.replace(' ', 'T') + 'Z'
      : text
    const result = Date.parse(normalized)
    if (!Number.isFinite(result)) throw new Error('Invalid retention timestamp')
    return result
  }

  function softDelete(kind, id) {
    const table = tableFor(kind)
    return transaction(() => {
      const row = read(table, id)
      if (row.deleted_at) return row
      const time = now()
      const expiry = timestamp(row.expires_at)
      const remaining = row.archived_at || expiry === null
        ? null
        : Math.max(0, Math.ceil((expiry - time) / 1000))

      db.prepare(
        `UPDATE ${table}
         SET deleted_at = ?, purge_after = ?,
             retention_remaining_seconds = ?
         WHERE id = ?`
      ).run(
        new Date(time).toISOString(),
        new Date(time + HOLD_MS).toISOString(),
        remaining,
        id
      )
      return read(table, id)
    })
  }

  function restore(kind, id) {
    const table = tableFor(kind)
    return transaction(() => {
      const row = read(table, id)
      if (!row.deleted_at) throw new Error('Item is not pending deletion')
      const time = now()
      const deadline = timestamp(row.purge_after)
      if (deadline === null || time >= deadline) {
        throw new Error('The two-hour restore window has expired')
      }

      let expiry = row.expires_at
      if (row.archived_at) {
        expiry = null
      } else if (row.retention_remaining_seconds !== null) {
        if (row.retention_remaining_seconds <= 0) {
          throw new Error('Retention expired; archive before restoring')
        }
        expiry = new Date(
          time + row.retention_remaining_seconds * 1000
        ).toISOString()
      }

      db.prepare(
        `UPDATE ${table}
         SET deleted_at = NULL, purge_after = NULL,
             retention_remaining_seconds = NULL, expires_at = ?
         WHERE id = ?`
      ).run(expiry, id)
      return read(table, id)
    })
  }

  function archive(kind, id) {
    const table = tableFor(kind)
    return transaction(() => {
      read(table, id)
      db.prepare(
        `UPDATE ${table}
         SET archived_at = COALESCE(archived_at, ?),
             expires_at = NULL, retention_remaining_seconds = NULL
         WHERE id = ?`
      ).run(new Date(now()).toISOString(), id)
      return read(table, id)
    })
  }

  function listRestorable() {
    const time = now()
    const result = []
    for (const kind of ['space', 'clip']) {
      const table = tableFor(kind)
      const rows = db.prepare(
        `SELECT id, title, archived_at, deleted_at, purge_after
         FROM ${table} WHERE deleted_at IS NOT NULL`
      ).all()
      for (const row of rows) {
        const deadline = timestamp(row.purge_after)
        if (deadline !== null && deadline > time) {
          result.push({
            ...row,
            item_kind: kind,
            remaining_seconds: Math.ceil((deadline - time) / 1000),
          })
        }
      }
    }
    return result.sort((a, b) =>
      timestamp(a.purge_after) - timestamp(b.purge_after)
    )
  }

  return { softDelete, restore, archive, listRestorable }
}

module.exports = { HOLD_MS, createRetention }
