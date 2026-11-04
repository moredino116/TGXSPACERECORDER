const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

// Verified export recovery v1
function normalizeRecoveryContext(value) {
  if (!value || value.unit !== 'x-space-recorder.service' ||
      !/^[a-f0-9]{32}$/.test(value.machine || '') ||
      !/^[a-f0-9]{32}$/.test(value.invocation || '')) return null
  return Object.freeze({
    unit: value.unit, machine: value.machine, invocation: value.invocation,
  })
}

function readSystemdRecoveryContext({
  env = process.env,
  readFile = fs.readFileSync,
  exec = require('node:child_process').execFileSync,
} = {}) {
  const invocation = env.INVOCATION_ID
  if (!/^[a-f0-9]{32}$/.test(invocation || '')) return null
  try {
    const cgroup = String(readFile('/proc/self/cgroup', 'utf8'))
    if (!/(?:^|\/)x-space-recorder\.service(?:\/|$)/m.test(cgroup)) return null
    const machine = String(readFile('/etc/machine-id', 'utf8')).trim()
    const output = String(exec('/usr/bin/systemctl', [
      'show', 'x-space-recorder.service',
      '--property=KillMode,SendSIGKILL,InvocationID', '--no-pager',
    ], {
      timeout: 3000,
      maxBuffer: 16384,
      env: { PATH: '/usr/bin:/bin', LANG: 'C' },
      stdio: ['ignore', 'pipe', 'pipe'],
    }))
    const properties = Object.fromEntries(output.trim().split('\n').map(line => {
      const split = line.indexOf('=')
      return [line.slice(0, split), line.slice(split + 1)]
    }))
    if (properties.KillMode !== 'control-group' ||
        properties.SendSIGKILL !== 'yes' ||
        properties.InvocationID !== invocation) return null
    return normalizeRecoveryContext({
      unit: 'x-space-recorder.service', machine, invocation,
    })
  } catch {
    return null
  }
}

function activeExports(db) {
  const exists = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='media_exports'"
  ).get()
  if (!exists) return false
  return db.prepare(
    "SELECT COUNT(*) AS count FROM media_exports WHERE status IN ('queued','rendering')"
  ).get().count > 0
}

function createExportQueue({
  db, archiveDir, exportDir, renderer, isBusy,
  now = () => Date.now(),
  recoveryContext = readSystemdRecoveryContext(),
}) {
  if (typeof isBusy !== 'function' || typeof renderer?.render !== 'function') {
    throw new Error('Export renderer and live-work check are required')
  }
  const archive = fs.realpathSync(archiveDir)
  fs.mkdirSync(exportDir, { recursive: true })
  const outputRoot = fs.realpathSync(exportDir)
  const recovery = normalizeRecoveryContext(recoveryContext)

  db.exec(`
    CREATE TABLE IF NOT EXISTS media_exports (
      id TEXT PRIMARY KEY,
      owner TEXT NOT NULL,
      request_key TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      source_id TEXT NOT NULL,
      preset TEXT NOT NULL,
      cover BLOB NOT NULL,
      cover_type TEXT NOT NULL,
      cover_hash TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      finished_at INTEGER,
      size_bytes INTEGER,
      UNIQUE(owner, request_key)
    );
    CREATE INDEX IF NOT EXISTS media_exports_status
      ON media_exports(status, created_at);
  `)

  // Additive, repeatable claim-identity migration.
  db.exec('BEGIN IMMEDIATE')
  try {
    const columns = new Set(
      db.prepare('PRAGMA table_info(media_exports)').all().map(row => row.name)
    )
    for (const name of ['worker_unit', 'worker_machine', 'worker_invocation']) {
      if (!columns.has(name)) {
        db.exec(`ALTER TABLE media_exports ADD COLUMN ${name} TEXT`)
      }
    }
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }

  let running = false

  function validId(value) {
    return typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value)
  }
  function ownerKey(value) {
    if (typeof value !== 'string' || !/^telegram:[1-9][0-9]{0,19}$/.test(value)) {
      throw new Error('Invalid export owner')
    }
    return value
  }
  function sourceInfo(kind, id) {
    if (!['space', 'clip'].includes(kind) || !validId(id)) {
      throw new Error('Invalid source item')
    }
    const table = kind === 'clip' ? 'clips' : 'recordings'
    const item = db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id)
    if (!item || item.deleted_at) throw new Error('Source item is unavailable')
    if (kind === 'clip' ? item.status !== 'completed' : item.state !== 'ready') {
      throw new Error('Source item is not completed')
    }
    for (const extension of kind === 'clip' ? ['.m4a'] : ['.m4a', '.aac', '.raw']) {
      const file = path.join(archive, id + extension)
      try {
        const stat = fs.lstatSync(file)
        if (stat.isSymbolicLink() || !stat.isFile() || stat.size < 1) continue
        if (path.dirname(fs.realpathSync(file)) !== archive) continue
        return { file, stat }
      } catch {}
    }
    throw new Error('Source file is unavailable')
  }
  function publicJob(row) {
    if (!row) return null
    return {
      id: row.id,
      kind: row.source_kind,
      sourceId: row.source_id,
      preset: row.preset,
      status: row.status,
      createdAt: row.created_at,
      finishedAt: row.finished_at,
      sizeBytes: row.size_bytes,
    }
  }
  function get(owner, id) {
    ownerKey(owner)
    if (!validId(id)) return null
    return publicJob(db.prepare(
      'SELECT * FROM media_exports WHERE owner=? AND id=?'
    ).get(owner, id))
  }

  function enqueue(owner, body) {
    ownerKey(owner)
    const { requestKey, kind, sourceId, preset, coverBase64 } = body || {}
    if (!validId(requestKey) || !validId(sourceId) ||
        !['space', 'clip'].includes(kind) ||
        !['landscape720', 'landscape1080'].includes(preset) ||
        typeof coverBase64 !== 'string' || coverBase64.length > 1398104) {
      throw new Error('Invalid export request')
    }
    const cover = Buffer.from(coverBase64, 'base64')
    if (!cover.length || cover.length > 1048576 ||
        cover.toString('base64') !== coverBase64) {
      throw new Error('Invalid cover encoding')
    }
    const png = cover.length >= 24 &&
      cover.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
    const jpeg = cover.length >= 4 && cover[0] === 255 && cover[1] === 216
    if (!png && !jpeg) throw new Error('Cover must be PNG or JPEG')

    const hash = crypto.createHash('sha256').update(cover).digest('hex')
    const existing = db.prepare(
      'SELECT * FROM media_exports WHERE owner=? AND request_key=?'
    ).get(owner, requestKey)
    if (existing) {
      if (existing.source_kind !== kind || existing.source_id !== sourceId ||
          existing.preset !== preset || existing.cover_hash !== hash) {
        throw new Error('Export request conflicts with its saved job')
      }
      return publicJob(existing)
    }
    sourceInfo(kind, sourceId)
    if (db.prepare("SELECT COUNT(*) AS count FROM media_exports WHERE status <> 'removed'").get().count >= 20) {
      throw new Error('Export storage capacity requires maintenance')
    }
    const id = 'e' + crypto.randomBytes(16).toString('hex')
    db.prepare(`
      INSERT INTO media_exports
        (id,owner,request_key,source_kind,source_id,preset,
         cover,cover_type,cover_hash,status,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,'queued',?)
    `).run(
      id, owner, requestKey, kind, sourceId, preset,
      cover, png ? 'png' : 'jpg', hash, now()
    )
    return get(owner, id)
  }

  // Export management v1
  function list(owner, kind, sourceId) {
    ownerKey(owner)
    if (!['space', 'clip'].includes(kind) || !validId(sourceId)) {
      throw new Error('Invalid source item')
    }
    return db.prepare(`
      SELECT * FROM media_exports
      WHERE owner=? AND source_kind=? AND source_id=? AND status <> 'removed'
      ORDER BY created_at DESC,id DESC
    `).all(owner, kind, sourceId).map(publicJob)
  }

  function removeExport(owner, id) {
    ownerKey(owner)
    if (!/^e[a-f0-9]{32}$/.test(id || '')) {
      throw new Error('Export is unavailable')
    }
    db.exec('BEGIN IMMEDIATE')
    try {
      const row = db.prepare(
        'SELECT * FROM media_exports WHERE owner=? AND id=?'
      ).get(owner, id)
      if (!row) throw new Error('Export is unavailable')
      if (row.status === 'removed') {
        db.exec('COMMIT')
        return publicJob(row)
      }
      if (!['completed', 'failed'].includes(row.status)) {
        throw new Error('Export work is still active')
      }

      // Unknown scratch files require recovery/maintenance, not broad deletion.
      if (fs.readdirSync(outputRoot).some(
        name => name.startsWith('.render-' + id + '-')
      )) throw new Error('Export scratch work requires maintenance')

      const files = ['.mp4', '.cover.png', '.cover.jpg']
        .map(suffix => path.join(outputRoot, id + suffix))
      for (const file of files) {
        try {
          const stat = fs.lstatSync(file)
          if (!stat.isFile() && !stat.isSymbolicLink()) {
            throw new Error('Unverified artifact')
          }
        } catch (error) {
          if (error.code !== 'ENOENT') throw error
        }
      }
      for (const file of files) {
        try { fs.unlinkSync(file) } catch (error) {
          if (error.code !== 'ENOENT') throw error
        }
      }
      db.prepare(`
        UPDATE media_exports
        SET status='removed',cover=x'',size_bytes=NULL,finished_at=?
        WHERE owner=? AND id=?
      `).run(now(), owner, id)
      db.exec('COMMIT')
      return get(owner, id)
    } catch {
      db.exec('ROLLBACK')
      throw new Error('Export could not be removed')
    }
  }

  // Signed export delivery v1
  function deliveryFile(row) {
    if (!row || row.status !== 'completed' ||
        !/^e[a-f0-9]{32}$/.test(row.id || '')) {
      throw new Error('Export is unavailable')
    }
    sourceInfo(row.source_kind, row.source_id)
    const file = path.join(outputRoot, row.id + '.mp4')
    try {
      const stat = fs.lstatSync(file)
      if (!stat.isFile() || stat.isSymbolicLink() ||
          stat.size < 1 || stat.size !== row.size_bytes ||
          path.dirname(fs.realpathSync(file)) !== outputRoot) {
        throw new Error()
      }
    } catch {
      throw new Error('Export is unavailable')
    }
    return file
  }

  function authorizeDownload(owner, id) {
    ownerKey(owner)
    if (!validId(id)) throw new Error('Export is unavailable')
    const row = db.prepare(
      'SELECT * FROM media_exports WHERE owner=? AND id=?'
    ).get(owner, id)
    deliveryFile(row)
    return {
      id: row.id,
      available: true,
      downloadPath: '/api/space/exports/' + row.id + '/file',
      sizeBytes: row.size_bytes,
    }
  }

  function fileForDelivery(id) {
    if (!/^e[a-f0-9]{32}$/.test(id || '')) {
      throw new Error('Export is unavailable')
    }
    return deliveryFile(db.prepare(
      'SELECT * FROM media_exports WHERE id=?'
    ).get(id))
  }

  function recoverInterrupted() {
    if (!recovery || running || renderer.isBusy?.()) return []
    const results = []
    db.exec('BEGIN IMMEDIATE')
    try {
      const rows = db.prepare(
        "SELECT * FROM media_exports WHERE status='rendering'"
      ).all()
      for (const row of rows) {
        if (!/^e[a-f0-9]{32}$/.test(row.id || '') ||
            row.worker_unit !== recovery.unit ||
            row.worker_machine !== recovery.machine ||
            !/^[a-f0-9]{32}$/.test(row.worker_invocation || '') ||
            row.worker_invocation === recovery.invocation) continue

        try {
          // Inspect scratch contents before deleting any job artifacts.
          const scratchDirectories = fs.readdirSync(outputRoot).filter(
            name => name.startsWith('.render-' + row.id + '-')
          )
          for (const name of scratchDirectories) {
            const directory = path.join(outputRoot, name)
            const stat = fs.lstatSync(directory)
            if (!stat.isDirectory() || stat.isSymbolicLink()) {
              throw new Error('Unverified scratch directory')
            }
            for (const child of fs.readdirSync(directory)) {
              if (child !== 'output.mp4') {
                throw new Error('Unverified scratch contents')
              }
              const childStat = fs.lstatSync(path.join(directory, child))
              if (!childStat.isFile() && !childStat.isSymbolicLink()) {
                throw new Error('Unverified scratch output')
              }
            }
          }

          for (const suffix of ['.mp4', '.cover.png', '.cover.jpg']) {
            try {
              fs.unlinkSync(path.join(outputRoot, row.id + suffix))
            } catch (error) {
              if (error.code !== 'ENOENT') throw error
            }
          }
          for (const name of scratchDirectories) {
            const directory = path.join(outputRoot, name)
            for (const child of fs.readdirSync(directory)) {
              fs.unlinkSync(path.join(directory, child))
            }
            fs.rmdirSync(directory)
          }
          db.prepare(
            "UPDATE media_exports SET status='failed',finished_at=?,cover=x'' WHERE id=? AND status='rendering'"
          ).run(now(), row.id)
          results.push({ id: row.id, status: 'failed', reason: 'interrupted' })
        } catch {
          results.push({ id: row.id, status: 'rendering', reason: 'recovery-blocked' })
        }
      }
      db.exec('COMMIT')
      return results
    } catch {
      db.exec('ROLLBACK')
      throw new Error('Interrupted export recovery could not be verified')
    }
  }

  async function runOnce() {
    const recovered = recoverInterrupted()
    if (running || isBusy() || renderer.isBusy?.()) return recovered
    running = true
    let job
    let coverFile
    let coverWritten = false
    try {
      db.exec('BEGIN IMMEDIATE')
      try {
        const other = db.prepare(
          "SELECT id FROM media_exports WHERE status='rendering' LIMIT 1"
        ).get()
        if (!other) {
          job = db.prepare(
            "SELECT * FROM media_exports WHERE status='queued' ORDER BY created_at,id LIMIT 1"
          ).get()
          if (job) {
            db.prepare(
              `UPDATE media_exports
               SET status='rendering',worker_unit=?,worker_machine=?,worker_invocation=?
               WHERE id=? AND status='queued'`
            ).run(
              recovery?.unit || null,
              recovery?.machine || null,
              recovery?.invocation || null,
              job.id
            )
          }
        }
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
      if (!job) return recovered

      const before = sourceInfo(job.source_kind, job.source_id)
      const disk = fs.statfsSync(outputRoot)
      if (Number(disk.bavail) * Number(disk.bsize) < 640 * 1024 * 1024) {
        throw new Error('Insufficient export space')
      }
      coverFile = path.join(outputRoot, job.id + '.cover.' + job.cover_type)
      fs.writeFileSync(coverFile, job.cover, { flag: 'wx', mode: 0o600 })
      coverWritten = true

      const result = await renderer.render({
        sourcePath: before.file,
        coverPath: coverFile,
        id: job.id,
        preset: job.preset,
      })
      const output = path.join(outputRoot, job.id + '.mp4')
      if (path.resolve(result.path) !== output) {
        throw new Error('Unexpected renderer output')
      }
      const after = sourceInfo(job.source_kind, job.source_id)
      if (before.file !== after.file ||
          before.stat.ino !== after.stat.ino ||
          before.stat.size !== after.stat.size ||
          before.stat.mtimeMs !== after.stat.mtimeMs) {
        throw new Error('Source changed during export')
      }
      const stat = fs.lstatSync(output)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1) {
        throw new Error('Export file is unavailable')
      }
      db.prepare(
        "UPDATE media_exports SET status='completed',finished_at=?,size_bytes=? WHERE id=? AND status='rendering'"
      ).run(now(), stat.size, job.id)
      return [...recovered, { id: job.id, status: 'completed' }]
    } catch {
      if (job) {
        try { fs.unlinkSync(path.join(outputRoot, job.id + '.mp4')) } catch {}
        db.prepare(
          "UPDATE media_exports SET status='failed',finished_at=? WHERE id=?"
        ).run(now(), job.id)
        return [...recovered, { id: job.id, status: 'failed' }]
      }
      throw new Error('Export worker could not verify its queue')
    } finally {
      try {
        if (coverWritten) fs.unlinkSync(coverFile)
      } catch {}
      running = false
    }
  }

  return {
    enqueue, get, list, removeExport, runOnce, recoverInterrupted, authorizeDownload, fileForDelivery,
    isRendering: () => running,
    hasWork: () => activeExports(db),
  }
}

function attachExportRoutes(router, {
  getDb, archiveDir, exportDir, ffmpegPath, isBusy,
  rendererTimeoutMs = 1800000,
}) {
  const { xConnectionOwnerGuard } = require('./x-connection-owner')
  const { createCoverRenderer } = require('./cover-video-renderer')
  let queue

  function service() {
    if (!queue) {
      fs.mkdirSync(exportDir, { recursive: true })
      queue = createExportQueue({
        db: getDb(), archiveDir, exportDir, isBusy,
        renderer: createCoverRenderer({
          ffmpegPath, sourceRoot: archiveDir, exportRoot: exportDir,
          timeoutMs: rendererTimeoutMs,
        }),
      })
    }
    return queue
  }

  router.post('/exports', xConnectionOwnerGuard, (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    try {
      const job = service().enqueue(req.xConnectionOwner.workspace, req.body)
      return res.status(202).json({ ok: true, job })
    } catch {
      return res.status(400).json({
        ok: false,
        error: 'Export could not be queued. Check source, cover, saved request, or storage capacity.',
      })
    }
  })

  router.get('/exports/:id', xConnectionOwnerGuard, (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    try {
      const job = service().get(req.xConnectionOwner.workspace, req.params.id)
      if (!job) return res.status(404).json({ ok: false, error: 'Export not found.' })
      return res.json({ ok: true, job })
    } catch {
      return res.status(503).json({ ok: false, error: 'Export status unavailable.' })
    }
  })

  router.post('/exports/:id/download', xConnectionOwnerGuard, (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    try {
      const allowed = service().authorizeDownload(
        req.xConnectionOwner.workspace, req.params.id
      )
      return res.json({ ok: true, ...allowed })
    } catch {
      return res.status(404).json({
        ok: false, error: 'Export is not available for download.',
      })
    }
  })

  router.get('/exports/:id/file', (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    try {
      const file = service().fileForDelivery(req.params.id)
      res.setHeader('Content-Type', 'video/mp4')
      return res.download(file, req.params.id + '.mp4')
    } catch {
      return res.status(404).json({
        ok: false, error: 'Export is not available for download.',
      })
    }
  })

  router.get('/exports/source/:kind/:sourceId', xConnectionOwnerGuard, (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    try {
      const jobs = service().list(
        req.xConnectionOwner.workspace, req.params.kind, req.params.sourceId
      )
      return res.json({ ok: true, jobs })
    } catch {
      return res.status(400).json({ ok: false, error: 'Export list unavailable.' })
    }
  })

  router.delete('/exports/:id', xConnectionOwnerGuard, (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    try {
      const job = service().removeExport(
        req.xConnectionOwner.workspace, req.params.id
      )
      return res.json({ ok: true, job })
    } catch {
      return res.status(404).json({
        ok: false,
        error: 'Export could not be removed. Refresh its status before retrying.',
      })
    }
  })

  const timer = setInterval(() => {
    try {
      // Resume persisted work without depending on another browser request.
      if (!queue && activeExports(getDb())) service()
      if (queue) void queue.runOnce().catch(() => {
        console.error('[exports] worker pass could not be verified')
      })
    } catch {
      console.error('[exports] worker initialization could not be verified')
    }
  }, 1500)
  timer.unref()

  return {
    isRendering: () => Boolean(queue?.isRendering()),
    hasWork: () => activeExports(getDb()),
    close: () => clearInterval(timer),
  }
}

module.exports = {
  createExportQueue, activeExports, attachExportRoutes,
  readSystemdRecoveryContext,
}
