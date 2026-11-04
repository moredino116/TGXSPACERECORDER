// Failure hints are not proof that connecting an account will fix access.
function resolutionFailure(stage, statuses = []) {
  const values = statuses.map(Number)
  const upstreamStatuses = [...new Set(values)]
  function result(code, reason, canTryConnectedAccount = false) {
    return {
      ok: false, code, stage, upstreamStatuses,
      canTryConnectedAccount, reason,
    }
  }

  // Mixed query failures must not hide rate limits or transport failures.
  if (values.includes(429)) {
    return result('x_rate_limited',
      'X rate-limited the request. Wait before retrying; this is not a confirmed login problem.')
  }
  if (values.some(n => n === 0 || n >= 500)) {
    return result('x_unavailable',
      'X could not be reached reliably or returned a server error. Try again later.')
  }
  if (stage === 'guest') {
    return result('x_guest_activation_failed',
      'X did not provide a guest token. Connecting an account is not a confirmed fix.')
  }

  // Unknown endpoint failures take precedence over authentication hints.
  if (values.some(n => n >= 300 && n !== 401 && n !== 403)) {
    return result('x_lookup_unavailable',
      'X returned an unsuccessful lookup response. This does not establish that the Space is missing or requires login.')
  }
  if (values.includes(401)) {
    return result('x_authentication_rejected',
      'X rejected authentication for this request. An authorized connected account may help, but access is not guaranteed.',
      true)
  }
  if (values.includes(403)) {
    return result('x_access_denied',
      'X denied this request. A connected account may help only if it has access to this Space.',
      true)
  }
  return result(
    stage === 'stream' ? 'space_stream_unavailable' : 'space_lookup_empty',
    stage === 'stream'
      ? 'X returned no playback URL. Audio may be unavailable or access-restricted; the cause is not confirmed.'
      : 'X returned no usable Space data. The cause is not confirmed; check the link and try again.'
  )
}

module.exports = { resolutionFailure }
