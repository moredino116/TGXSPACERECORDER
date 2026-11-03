const { Router } = require('express')
const { getDb } = require('../lib/db')
const { createRetention } = require('../lib/retention')

const router = Router()

function service() {
  return createRetention(getDb())
}

function validateTarget(req, res, next) {
  if (!['space', 'clip'].includes(req.params.kind)) {
    return res.status(400).json({
      ok: false,
      error: 'Item kind must be space or clip',
    })
  }
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(req.params.id || '')) {
    return res.status(400).json({
      ok: false,
      error: 'Invalid item ID',
    })
  }
  next()
}

function reportError(res, error) {
  const message = String(error?.message || error)
  const statuses = {
    'Item not found': 404,
    'Item is not pending deletion': 409,
    'The two-hour restore window has expired': 410,
    'Retention expired; archive before restoring': 409,
  }
  const status = statuses[message] || 500
  if (status === 500) {
    console.error('[retention] request failed:', message)
  }
  return res.status(status).json({
    ok: false,
    error: status === 500 ? 'Retention operation failed' : message,
  })
}

function publicItem(kind, row) {
  return {
    id: row.id,
    item_kind: kind,
    title: row.title || row.name || row.id,
    archived_at: row.archived_at,
    expires_at: row.expires_at,
    deleted_at: row.deleted_at,
    purge_after: row.purge_after,
    retention_remaining_seconds: row.retention_remaining_seconds,
  }
}

router.get('/restore', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store')
  try {
    return res.json({
      ok: true,
      items: service().listRestorable(),
    })
  } catch (error) {
    return reportError(res, error)
  }
})

router.post('/items/:kind/:id/restore', validateTarget, (req, res) => {
  res.setHeader('Cache-Control', 'no-store')
  try {
    const row = service().restore(req.params.kind, req.params.id)
    return res.json({
      ok: true,
      item: publicItem(req.params.kind, row),
    })
  } catch (error) {
    return reportError(res, error)
  }
})

router.post('/items/:kind/:id/archive', validateTarget, (req, res) => {
  res.setHeader('Cache-Control', 'no-store')
  try {
    const row = service().archive(req.params.kind, req.params.id)
    return res.json({
      ok: true,
      item: publicItem(req.params.kind, row),
    })
  } catch (error) {
    return reportError(res, error)
  }
})

module.exports = router

