function createPendingRecordingRetry({
  store, getConnection, resolve, start,
}) {
  function reply(status, code, extra = {}) {
    return { status, json: { ok: status === 200, code, ...extra } }
  }

  async function resume({ ownerId, requestId, connectionId }) {
    const user = String(ownerId)
    if (!/^[1-9][0-9]{0,19}$/.test(user) ||
        typeof requestId !== 'string' ||
        !/^[A-Za-z0-9_-]{1,100}$/.test(requestId) ||
        typeof connectionId !== 'string' ||
        !/^[A-Za-z0-9_-]{1,100}$/.test(connectionId)) {
      return reply(400, 'invalid_request')
    }

    const row = store.get(requestId, user)
    if (!row) return reply(404, 'request_unavailable')

    if (row.state === 'recording' && row.job_id) {
      return reply(200, 'recording_started', {
        requestId: row.id, jobId: row.job_id, reused: true,
      })
    }
    if (row.state !== 'waiting_connection') {
      return reply(409,
        row.state === 'submitting' ? 'submission_uncertain' : 'request_busy',
        { requestId: row.id })
    }

    let connection
    try {
      connection = await getConnection(connectionId, user)
    } catch {
      return reply(503, 'connection_lookup_failed')
    }
    if (!connection ||
        connection.id !== connectionId ||
        connection.workspace_id !== 'telegram:' + user ||
        String(connection.user_id) !== user) {
      return reply(403, 'connection_unavailable')
    }
    if (connection.status !== 'active') {
      return reply(409, 'reconnect_required')
    }

    const claimed = store.claim(requestId, user, connectionId)
    if (!claimed) return reply(409, 'request_busy')

    const input = 'https://x.com/i/spaces/' + claimed.space_id
    const access = { accessMode: 'connected_account', xConnectionId: connectionId }
    let resolved
    try {
      resolved = await resolve({ ownerId: user, input, ...access })
    } catch {
      store.releaseResolution(requestId, user, claimed.claim_token)
      return reply(503, 'resolution_unavailable')
    }

    const audio = resolved?.json
    if (resolved?.status !== 200 || audio?.ok !== true ||
        typeof audio.m3u8 !== 'string' || !audio.m3u8.trim()) {
      store.releaseResolution(requestId, user, claimed.claim_token)
      // Browser reconnect classification v1
      if (['x_authentication_rejected', 'reconnect-required'].includes(audio?.code)) {
        return reply(409, 'reconnect_required')
      }
      return reply(409, 'audio_not_resolved')
    }

    // Persist this boundary BEFORE any recording-start call.
    if (!store.markSubmitting(requestId, user, claimed.claim_token)) {
      return reply(409, 'request_busy')
    }

    try {
      const started = await start({
        ownerId: user,
        body: {
          ...access,
          input,
          m3u8: audio.m3u8,
          name: audio.title || 'Space',
          title: audio.title || null,
          source: 'space',
          enhance: true,
        },
      })
      const jobId = started?.json?.id
      if (started?.status !== 200 ||
          typeof jobId !== 'string' ||
          !/^[A-Za-z0-9_-]{1,100}$/.test(jobId)) {
        return reply(409, 'submission_uncertain', { requestId })
      }
      const saved = store.markStarted(
        requestId, user, claimed.claim_token, jobId
      )
      if (!saved) return reply(409, 'submission_uncertain', { requestId })

      return reply(200, 'recording_started', {
        requestId, jobId, reused: false,
      })
    } catch {
      // A timeout or save failure does not prove no job was created.
      return reply(409, 'submission_uncertain', { requestId })
    }
  }

  return { resume }
}

module.exports = { createPendingRecordingRetry }
