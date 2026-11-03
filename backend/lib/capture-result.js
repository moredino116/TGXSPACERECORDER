function archiveUnconfirmed(row) {
  return ['pending', 'failed'].includes(row?.archiveStatus)
}

function completionText(row) {
  if (row?.captureWarning === 'capture_interrupted') {
    return 'Saved partial audio: capture was interrupted.'
  }
  if (row?.captureWarning === 'processing_failed') {
    return 'Saved with a warning: processing failed; original captured audio was retained.'
  }
  if (row?.captureWarning === 'capture_end_unconfirmed') {
    return 'Saved captured audio; the end of the Space was not confirmed.'
  }
  if (row?.captureWarning === 'missing_audio_segments') {
    return 'Saved with gaps: some audio segments could not be downloaded.'
  }
  if (row?.captureWarning) return 'Saved with a capture warning.'
  if (Number(row?.gaps) > 0) {
    return 'Saved with gaps: some audio segments could not be downloaded.'
  }
  return 'Saved.'
}

module.exports = { archiveUnconfirmed, completionText }

