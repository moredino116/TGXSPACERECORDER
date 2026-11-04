const columns = [
  ['capture_warning', 'TEXT'],
  ['capture_stop_reason', 'TEXT'],
  ['captured_segments', 'INTEGER'],
  ['captured_bytes', 'INTEGER'],
  ['gap_seconds', 'REAL'],
]

function ensureRecordingCaptureMetadata(db) {
  const existing = new Set(
    db.prepare('PRAGMA table_info(recordings)').all().map(row => row.name)
  )
  for (const [name, type] of columns) {
    if (!existing.has(name)) {
      db.exec(`ALTER TABLE recordings ADD COLUMN ${name} ${type}`)
    }
  }
}

function captureMetadata(job) {
  const warnings = new Set([
    'capture_interrupted', 'processing_failed',
    'capture_end_unconfirmed', 'missing_audio_segments',
  ])
  const reasons = new Set([
    'playlist_end', 'user_stop', 'time_limit', 'no_new_audio',
    'playlist_unavailable', 'capture_error', 'no_audio',
  ])
  const number = value =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0
      ? value : null
  return [
    warnings.has(job.captureWarning) ? job.captureWarning : null,
    reasons.has(job.captureStopReason) ? job.captureStopReason : null,
    number(job.capturedSegments),
    number(job.capturedBytes),
    number(job.gapSeconds),
  ]
}

module.exports = { ensureRecordingCaptureMetadata, captureMetadata }
