const { archiveUnconfirmed, completionText } = require('./capture-result')

function createSavedRequestTracker({
  call, active, send, fileUrl, clipLabel, ownerIds,
}) {
  let polling = false
  const valid = value =>
    typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value)

  async function sync() {
    for (const ownerId of ownerIds) {
      const user = String(ownerId)
      const chatId = Number(user)
      if (!/^[1-9][0-9]{0,19}$/.test(user) ||
          !Number.isSafeInteger(chatId)) continue
      try {
        const result = await call('GET', '/api/space/requests', undefined, user)
        if (result.status !== 200 || result.json?.ok !== true ||
            !Array.isArray(result.json.requests)) continue
        for (const row of result.json.requests) {
          if (row.state !== 'recording' ||
              !valid(row.requestId) || !valid(row.jobId)) continue
          const existing = active.get(row.jobId)
          if (existing && (
            existing.chatId !== chatId ||
            (existing.ownerId && String(existing.ownerId) !== user)
          )) continue

          if (existing) {
            existing.savedRequestId = row.requestId
            existing.ownerId = user
          } else {
            active.set(row.jobId, {
              id: row.jobId, chatId, ownerId: user,
              savedRequestId: row.requestId,
              title: row.spaceId || 'Space',
            })
          }
        }
      } catch {
        // Keep existing tracking; never expose raw errors or session data.
      }
    }
  }

  async function poll() {
    if (polling) return
    polling = true
    try {
      await sync()
      for (const job of [...active.values()]) {
        if (!job.savedRequestId) continue
        try {
          if (!job.terminalNotificationSent) {
            const status = await call(
              'GET', '/api/space/status/' + job.id, undefined, job.ownerId
            )
            if (status.status !== 200) continue
            const row = status.json || {}
            if (row.state === 'ready') {
              if (archiveUnconfirmed(row)) {
                if (!job.archiveNoticeSent) {
                  await send(job.chatId,
                    'Audio file retained, but archive indexing is not confirmed. ' +
                    'Do not submit another recording. Job: ' + job.id)
                  job.archiveNoticeSent = true
                }
                continue
              }
              const url = fileUrl(job.id)
              await send(
                job.chatId,
                completionText(row) + '\n' + clipLabel(row.name || job.title) + '\n' + url,
                { reply_markup: { inline_keyboard: [[
                  { text: 'Open audio', url },
                ]] } }
              )
            } else if (row.state === 'error') {
              await send(
                job.chatId,
                'Recording failed for saved request ' + job.savedRequestId +
                '. Check this recording before submitting another request.'
              )
            } else {
              continue
            }
            job.terminalNotificationSent = true
          }

          const ack = await call(
            'POST',
            '/api/space/requests/' + job.savedRequestId + '/complete',
            {},
            job.ownerId
          )
          if (ack.status === 200 && ack.json?.ok === true) {
            active.delete(job.id)
          }
        } catch {
          // Keep the job for another status/acknowledgement attempt.
        }
      }
    } finally {
      polling = false
    }
  }

  return { sync, poll }
}

module.exports = { createSavedRequestTracker }

