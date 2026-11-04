const { randomUUID } = require('node:crypto')

function owner(value) {
  const id = String(value)
  if (!/^[1-9][0-9]{0,19}$/.test(id)) {
    throw new Error('Invalid owner identity')
  }
  return id
}

function createPendingRecordingStore(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pending_recording_requests (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      space_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK (
        state IN ('waiting_connection', 'resolving', 'submitting',
                  'recording', 'completed')
      ),
      connection_id TEXT,
      claim_token TEXT,
      job_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS pending_recording_active_space
    ON pending_recording_requests(workspace_id, user_id, space_id)
    WHERE state <> 'completed';
  `)

  function get(id, ownerId) {
    const user = owner(ownerId)
    return db.prepare(`
      SELECT * FROM pending_recording_requests
      WHERE id=? AND workspace_id=? AND user_id=?
    `).get(id, 'telegram:' + user, user) || null
  }

  function enqueue({ ownerId, chatId, spaceId }) {
    const user = owner(ownerId)
    if (String(chatId) !== user) {
      throw new Error('Pending connection requests require a private chat')
    }
    if (typeof spaceId !== 'string' ||
        !/^[A-Za-z0-9]{10,64}$/.test(spaceId)) {
      throw new Error('Invalid Space identity')
    }
    const now = new Date().toISOString()
    db.prepare(`
      INSERT INTO pending_recording_requests
        (id, workspace_id, user_id, chat_id, space_id,
         state, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'waiting_connection', ?, ?)
      ON CONFLICT DO NOTHING
    `).run(randomUUID(), 'telegram:' + user, user, user, spaceId, now, now)

    return db.prepare(`
      SELECT * FROM pending_recording_requests
      WHERE workspace_id=? AND user_id=? AND space_id=?
        AND state <> 'completed'
    `).get('telegram:' + user, user, spaceId)
  }

  function claim(id, ownerId, connectionId) {
    const user = owner(ownerId)
    if (typeof connectionId !== 'string' ||
        !/^[A-Za-z0-9_-]{1,100}$/.test(connectionId)) {
      throw new Error('Invalid connection identity')
    }
    // The integration must verify connection ownership before calling this.
    return db.prepare(`
      UPDATE pending_recording_requests
      SET state='resolving', connection_id=?, claim_token=?, updated_at=?
      WHERE id=? AND workspace_id=? AND user_id=?
        AND state='waiting_connection'
      RETURNING *
    `).get(
      connectionId, randomUUID(), new Date().toISOString(),
      id, 'telegram:' + user, user
    ) || null
  }

  function markSubmitting(id, ownerId, token) {
    const user = owner(ownerId)
    return db.prepare(`
      UPDATE pending_recording_requests
      SET state='submitting', updated_at=?
      WHERE id=? AND workspace_id=? AND user_id=?
        AND state='resolving' AND claim_token=?
      RETURNING *
    `).get(
      new Date().toISOString(), id, 'telegram:' + user, user, token
    ) || null
  }

  function markStarted(id, ownerId, token, jobId) {
    const user = owner(ownerId)
    if (typeof jobId !== 'string' ||
        !/^[A-Za-z0-9_-]{1,100}$/.test(jobId)) {
      throw new Error('Invalid job identity')
    }
    return db.prepare(`
      UPDATE pending_recording_requests
      SET state='recording', job_id=?, updated_at=?
      WHERE id=? AND workspace_id=? AND user_id=?
        AND state='submitting' AND claim_token=?
      RETURNING *
    `).get(
      jobId, new Date().toISOString(),
      id, 'telegram:' + user, user, token
    ) || null
  }

  function releaseResolution(id, ownerId, token) {
    const user = owner(ownerId)
    return db.prepare(`
      UPDATE pending_recording_requests
      SET state='waiting_connection',
          connection_id=NULL, claim_token=NULL, updated_at=?
      WHERE id=? AND workspace_id=? AND user_id=?
        AND state='resolving' AND claim_token=?
      RETURNING *
    `).get(
      new Date().toISOString(), id, 'telegram:' + user, user, token
    ) || null
  }

  function listRecordingRequests(ownerId) {
    const user = owner(ownerId)
    return db.prepare(`
      SELECT * FROM pending_recording_requests
      WHERE workspace_id=? AND user_id=?
        AND state='recording' AND job_id IS NOT NULL
      ORDER BY created_at
    `).all('telegram:' + user, user)
  }

  function finishTracking(id, ownerId, jobId) {
    const user = owner(ownerId)
    return db.prepare(`
      UPDATE pending_recording_requests
      SET state='completed', updated_at=?
      WHERE id=? AND workspace_id=? AND user_id=?
        AND state='recording' AND job_id=?
      RETURNING *
    `).get(
      new Date().toISOString(), id, 'telegram:' + user, user, jobId
    ) || null
  }

  return {
    enqueue, get, claim, markSubmitting, markStarted, releaseResolution,
    listRecordingRequests, finishTracking,
  }
}

module.exports = { createPendingRecordingStore }
