const fs = require('node:fs')
const path = require('node:path')

function tableExists(db) {
  return Boolean(db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='media_exports'"
  ).get())
}

function sourceHasExportWork(db, kind, id) {
  if (!tableExists(db)) return false
  return Boolean(db.prepare(`
    SELECT id FROM media_exports
    WHERE source_kind=? AND source_id=?
      AND status IN ('queued','rendering')
    LIMIT 1
  `).get(kind, id))
}

function planSourceExportCleanup(db, exportDir, kind, id) {
  if (!tableExists(db)) return () => {}
  const rows = db.prepare(
    'SELECT id,status FROM media_exports WHERE source_kind=? AND source_id=?'
  ).all(kind, id)
  if (!rows.length) return () => {}

  // Validate everything before the purge worker removes source files.
  if (rows.some(row =>
    !/^e[a-f0-9]{32}$/.test(row.id || '') ||
    !['completed', 'failed', 'removed'].includes(row.status)
  )) throw new Error('Export metadata could not be verified for deletion')

  const root = path.resolve(exportDir)
  let entries = []
  try {
    const stat = fs.lstatSync(root)
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error('Unverified export directory')
    }
    entries = fs.readdirSync(root)
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw new Error('Export directory could not be verified for deletion')
    }
  }

  const files = []
  const directories = []
  function inspectFile(file) {
    try {
      const stat = fs.lstatSync(file)
      if (!stat.isFile() && !stat.isSymbolicLink()) {
        throw new Error('Unverified artifact')
      }
      files.push(file)
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw new Error('Export artifact could not be verified for deletion')
      }
    }
  }

  for (const row of rows) {
    for (const suffix of ['.mp4', '.cover.png', '.cover.jpg']) {
      inspectFile(path.join(root, row.id + suffix))
    }
    for (const name of entries) {
      if (!name.startsWith('.render-' + row.id + '-')) continue
      const directory = path.join(root, name)
      const stat = fs.lstatSync(directory)
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error('Export scratch directory could not be verified')
      }
      for (const child of fs.readdirSync(directory)) {
        if (child !== 'output.mp4') {
          throw new Error('Export scratch contents could not be verified')
        }
        inspectFile(path.join(directory, child))
      }
      directories.push(directory)
    }
  }

  return () => {
    try {
      for (const file of files) {
        try { fs.unlinkSync(file) } catch (error) {
          if (error.code !== 'ENOENT') throw error
        }
      }
      for (const directory of directories) {
        try { fs.rmdirSync(directory) } catch (error) {
          if (error.code !== 'ENOENT') throw error
        }
      }
      db.prepare(
        'DELETE FROM media_exports WHERE source_kind=? AND source_id=?'
      ).run(kind, id)
    } catch {
      throw new Error('Export artifacts could not be removed completely')
    }
  }
}

module.exports = { sourceHasExportWork, planSourceExportCleanup }

