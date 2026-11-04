// Browser-session save receipts v1. Database access is lazy and owner-scoped.
const crypto=require('node:crypto')
const ATTEMPT=/^b[a-f0-9]{48}$/
function fail() {const e=new Error('Connection save could not be confirmed.');e.code='BROWSER_CONNECTION_SAVE_UNCONFIRMED';return e}
function scope(ownerId,attemptId) {
  if(typeof ownerId!=='string' || !/^[1-9][0-9]{0,19}$/.test(ownerId) ||
      typeof attemptId!=='string' || !ATTEMPT.test(attemptId)) throw fail()
}
function createBrowserConnectionStore({getDb,encryptSecret,now=()=>new Date().toISOString()}) {
  if(typeof getDb!=='function' || typeof encryptSecret!=='function') throw Error('Invalid connection store configuration')
  function database() {
    const db=getDb()
    db.exec(`CREATE TABLE IF NOT EXISTS x_browser_connection_receipts_v1 (
      attempt_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, connection_id TEXT NOT NULL,
      x_account_id TEXT NOT NULL, request_id TEXT, created_at TEXT NOT NULL
    )`)
    return db
  }
  function receipt(db,ownerId,attemptId) {
    const row=db.prepare('SELECT * FROM x_browser_connection_receipts_v1 WHERE attempt_id=?').get(attemptId)
    if(row && row.owner_id!==ownerId) throw fail()
    return row
  }
  function publicConnection(db,row) {
    const conn=db.prepare(`SELECT id,x_handle,status,x_account_id,revoked_at FROM x_connections
      WHERE id=? AND workspace_id=? AND user_id=?`).get(row.connection_id,'telegram:'+row.owner_id,row.owner_id)
    if(!conn || conn.status!=='active' || conn.revoked_at || conn.x_account_id!==row.x_account_id) return null
    return {id:conn.id,x_handle:conn.x_handle||null,status:'active'}
  }
  async function lookupSaved({ownerId,attemptId}) {
    scope(ownerId,attemptId)
    try {
      const db=database(), row=receipt(db,ownerId,attemptId)
      if(!row) return {ownerId,attemptId,state:'not_saved'}
      const connection=publicConnection(db,row)
      return {ownerId,attemptId,requestId:row.request_id,
        state:connection?'saved':'saved_unavailable',...(connection?{connection}:{})}
    } catch {throw fail()}
  }
  async function save({ownerId,attemptId,requestId=null,identity,material}) {
    scope(ownerId,attemptId)
    if(requestId!==null && (typeof requestId!=='string' || !/^[A-Za-z0-9_-]{1,100}$/.test(requestId))) throw fail()
    if(!identity || typeof identity.id!=='string' || !/^[1-9][0-9]{0,24}$/.test(identity.id) ||
       typeof identity.handle!=='string' || !/^[A-Za-z0-9_]{1,100}$/.test(identity.handle)) throw fail()
    const parts=typeof material?.cookie==='string' && material.cookie.length<=9000
      ? /^auth_token=([^\x00-\x20\x7f;,]+); ct0=([^\x00-\x20\x7f;,]+)$/.exec(material.cookie) : null
    if(!parts || parts[1].length>4096 || parts[2].length>4096 || material.csrf!==parts[2]) throw fail()
    let db
    function existingReceipt() {
      const row=receipt(db,ownerId,attemptId)
      if(!row) return null
      if(row.x_account_id!==identity.id || row.request_id!==requestId) throw fail()
      const conn=publicConnection(db,row)
      if(!conn) throw fail()
      return conn
    }
    try {
      db=database()
      const previous=existingReceipt()
      if(previous) return previous
      const sealed=await encryptSecret(JSON.stringify({cookie:material.cookie,csrf:material.csrf}))
      if(!sealed || typeof sealed.ciphertext!=='string' ||
          !/^[a-f0-9]{24}:[a-f0-9]{32}:[a-f0-9]+$/i.test(sealed.ciphertext) ||
          typeof sealed.keyVersion!=='string' || !sealed.keyVersion || sealed.keyVersion.length>100) throw fail()
      db.exec('BEGIN IMMEDIATE')
      try {
        const repeated=existingReceipt()
        if(repeated) {db.exec('COMMIT');return repeated}
        const old=db.prepare('SELECT id FROM x_connections WHERE workspace_id=? AND user_id=? AND x_account_id=? LIMIT 1')
          .get('telegram:'+ownerId,ownerId,identity.id)
        const id=old?.id || 'x'+crypto.randomBytes(16).toString('hex')
        const stamp=now()
        let avatar=null
        try {const u=new URL(identity.avatar);if(u.protocol==='https:' && !u.username && !u.password && u.href.length<=2048) avatar=u.href} catch {}
        db.prepare(`INSERT INTO x_connections
          (id,workspace_id,user_id,x_account_id,x_handle,display_name,avatar_url,
           auth_type,encrypted_credentials,credential_key_version,status,granted_scopes,
           connected_at,last_validated_at,created_at,updated_at,expires_at,revoked_at)
          VALUES (?,?,?,?,?,?,?,'session',?,?,'active','read:spaces (session)',?,?,?,?,NULL,NULL)
          ON CONFLICT(id) DO UPDATE SET
            x_handle=excluded.x_handle,display_name=excluded.display_name,avatar_url=excluded.avatar_url,
            auth_type='session',encrypted_credentials=excluded.encrypted_credentials,
            credential_key_version=excluded.credential_key_version,status='active',
            granted_scopes=excluded.granted_scopes,last_validated_at=excluded.last_validated_at,
            expires_at=NULL,revoked_at=NULL,updated_at=excluded.updated_at`).run(
              id,'telegram:'+ownerId,ownerId,identity.id,identity.handle,
              String(identity.name||identity.handle).slice(0,200),avatar,
              sealed.ciphertext,sealed.keyVersion,stamp,stamp,stamp,stamp)
        db.prepare(`INSERT INTO x_browser_connection_receipts_v1
          (attempt_id,owner_id,connection_id,x_account_id,request_id,created_at) VALUES (?,?,?,?,?,?)`)
          .run(attemptId,ownerId,id,identity.id,requestId,stamp)
        const row=receipt(db,ownerId,attemptId), result=publicConnection(db,row)
        if(!result) throw fail()
        db.exec('COMMIT')
        return result
      } catch {try{db.exec('ROLLBACK')}catch{};throw fail()}
    } catch {throw fail()}
  }
  return {save,lookupSaved}
}
module.exports={createBrowserConnectionStore}

