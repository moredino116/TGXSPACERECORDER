// Uses only the owner-authenticated call supplied by the bot.
// Never reads, transports, or returns session secrets.
async function resolveWithSavedSession({ call, input, allowConnected = true, forceConnectedAccount = false }) {
  const response = await call('POST', '/api/space/resolve', { input })
  const initial = { response, access: {}, needsConnection: false }
  const body = response.json || {}

  const eligibleForAccountRetry =
    ['x_authentication_rejected', 'x_access_denied'].includes(body.code) ||
    (forceConnectedAccount &&
      ['x_lookup_unavailable', 'space_lookup_empty'].includes(body.code))
  if (response.status !== 200 || body.ok === true ||
      body.canTryConnectedAccount !== true && !forceConnectedAccount ||
      !eligibleForAccountRetry) {
    return initial
  }

  if (!allowConnected) return { ...initial, needsConnection: true }

  let listed
  try {
    listed = await call('GET', '/api/x-connections')
  } catch {
    listed = null
  }
  if (!listed || listed.status !== 200 || !Array.isArray(listed.json) ||
      listed.json.some(row =>
        !row || !/^[A-Za-z0-9_-]{1,100}$/.test(row.id || ''))) {
    return {
      ...initial,
      response: { status: 503, json: {
        ok: false, code: 'connection_lookup_failed',
        reason: 'Saved connection status could not be checked. No account-assisted attempt was made.',
      } },
      stop: true,
    }
  }

  if (listed.json.length > 1) {
    return {
      ...initial,
      response: { status: 409, json: {
        ok: false, code: 'connection_selection_required',
        reason: 'Multiple saved X connections exist. Account selection must be resolved before account-assisted recording.',
      } },
      stop: true,
    }
  }

  const connection = listed.json[0]
  if (!connection || connection.status !== 'active') {
    return { ...initial, needsConnection: true }
  }

  const access = {
    accessMode: 'connected_account',
    xConnectionId: connection.id,
  }
  const connected = await call('POST', '/api/space/resolve', {
    input, ...access,
  })
  const result = connected.json || {}
  const needsConnection = ['x_authentication_rejected', 'reconnect-required']
    .includes(result.code)

  return {
    response: connected,
    access,
    needsConnection,
    stop: connected.status !== 200 && !needsConnection,
  }
}

module.exports = { resolveWithSavedSession }

