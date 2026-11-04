
const { resolveXConnectionOwner } = require('./x-connection-owner')

function failure(code, reason, httpStatus) {
  return {
    accessMode: 'connected_account',
    cookie: null, csrf: null, connectionId: null,
    error: code, reason, httpStatus,
  }
}

async function sessionForRequest(body = {}, req, {
  dbQuery,
  decryptSecret,
  resolveOwner = resolveXConnectionOwner,
}) {
  if (body.accessMode !== 'connected_account') {
    return {
      accessMode: 'public',
      cookie: null, csrf: null, connectionId: null,
    }
  }

  const owner = resolveOwner(req)
  if (!owner) {
    return failure('owner-required',
      'An authorized Telegram identity is required to use an X connection.', 403)
  }
  const id = body.xConnectionId
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(id)) {
    return failure('connection-required',
      'Select an X connection before retrying.', 400)
  }

  let conn
  try {
    const { rows } = await dbQuery(
      `SELECT id, x_handle, status, encrypted_credentials, credential_key_version
       FROM x_connections
       WHERE id=$1 AND workspace_id=$2 AND user_id=$3`,
      [id, owner.workspace, owner.user]
    )
    conn = rows[0]
  } catch {
    return failure('connection-lookup-failed',
      'Could not read the saved X connection. Try again later.', 503)
  }

  if (!conn) {
    return failure('connection-unavailable',
      'That X connection is not available to this account.', 404)
  }
  if (conn.status !== 'active' || !conn.encrypted_credentials) {
    return failure('reconnect-required',
      'Reconnect your X account before retrying.', 409)
  }

  let credentials
  try {
    credentials = JSON.parse(await decryptSecret(
      conn.encrypted_credentials, conn.credential_key_version
    ))
  } catch {
    return failure('reconnect-required',
      'The saved X session could not be read. Reconnect your account.', 409)
  }

  const cookie = credentials?.cookie
  const csrf = credentials?.csrf ||
    /(?:^|;\s*)ct0=([^;]+)/.exec(String(cookie || ''))?.[1]

  if (typeof cookie !== 'string' ||
      !/(?:^|;\s*)auth_token=[^;]+/.test(cookie) ||
      typeof csrf !== 'string' || !csrf.trim() ||
      /[\r\n]/.test(cookie) || /[\r\n]/.test(csrf)) {
    return failure('reconnect-required',
      'The saved X session is incomplete. Reconnect your account.', 409)
  }

  return {
    accessMode: 'connected_account',
    cookie, csrf,
    connectionId: conn.id,
    handle: conn.x_handle || null,
    status: conn.status,
  }
}

module.exports = { sessionForRequest }

