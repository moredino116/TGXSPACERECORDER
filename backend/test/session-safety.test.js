const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const vm = require('node:vm')
const { createDurableKeyProvider } = require('../lib/secretbox-key-store')
const { resolveWithSavedSession } = require('../lib/telegram-x-fallback')
function database(filename = ':memory:') {
  const { DatabaseSync } = require('node:sqlite')
  const db = new DatabaseSync(filename)
  db.exec('CREATE TABLE IF NOT EXISTS app_keys (version TEXT PRIMARY KEY, key_hex TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP)')
  const query = async (sql, params = []) => {
    const bound = []
    const translated = sql.replace(/\$(\d+)/g, (_, n) => { bound.push(params[Number(n)-1]); return '?' })
    const stmt = db.prepare(translated)
    if (/^\s*SELECT/i.test(sql)) return { rows: stmt.all(...bound) }
    stmt.run(...bound); return { rows: [] }
  }
  return { db, query }
}
function load(relative, mocks, env = {}) {
  const file = path.join(__dirname, '..', relative)
  const module = { exports: {} }
  const context = { module, exports: module.exports, Buffer,
    process: { env }, console: { log() {}, error() {} },
    require(name) {
      if (Object.hasOwn(mocks,name)) return mocks[name]
      if (name === 'crypto' || name === 'node:crypto') return crypto
      throw new Error('Unexpected module import: '+name)
    } }
  vm.runInNewContext(fs.readFileSync(file,'utf8'),context,{filename:file,timeout:2000})
  return module.exports
}
async function unavailable(fn) {
  await assert.rejects(fn, error => error.code === 'X_SESSION_KEY_UNAVAILABLE' &&
    error.message === 'Session credential storage is temporarily unavailable.')
}
test('managed-key behavior is preserved without database access', async () => {
  const get = createDurableKeyProvider({ env:{X_CONN_ENC_KEY:'fixture-only'}, dbQuery:async()=>{throw Error('Unexpected database call')} })
  const value = await get()
  assert.equal(value.version,'env')
  assert.equal(value.key.toString('hex'),crypto.createHash('sha256').update('fixture-only').digest('hex'))
})
test('generated key is read back from SQLite before being returned', async () => {
  const {db,query}=database()
  try {
    const value=await createDurableKeyProvider({dbQuery:query})()
    assert.equal(value.key.toString('hex'),db.prepare('SELECT key_hex FROM app_keys').get().key_hex)
    assert.equal(value.key.length,32)
  } finally { db.close() }
})
test('key lookup failure does not mint a process-only key', async () => {
  const keyCache=new Map()
  await unavailable(createDurableKeyProvider({keyCache,dbQuery:async()=>{throw Error('private database detail')}}))
  assert.equal(keyCache.size,0)
})
test('failed key insertion does not cache or return the candidate key', async () => {
  const keyCache=new Map()
  const dbQuery=async sql=>{ if(sql.startsWith('SELECT')) return {rows:[]}; throw Error('private write failure') }
  await unavailable(createDurableKeyProvider({dbQuery,keyCache}))
  assert.equal(keyCache.size,0)
})
test('an unconfirmed write cannot produce a usable credential key', async () => {
  const keyCache=new Map()
  await unavailable(createDurableKeyProvider({keyCache,dbQuery:async()=>({rows:[]})}))
  assert.equal(keyCache.size,0)
})
test('malformed stored keys are rejected without caching', async () => {
  const keyCache=new Map()
  await unavailable(createDurableKeyProvider({keyCache,dbQuery:async()=>({rows:[{version:'v1',key_hex:'broken'}]})}))
  assert.equal(keyCache.size,0)
})
test('concurrent creators converge on the actually persisted key', async () => {
  const {db,query}=database()
  try {
    const [a,b]=await Promise.all([
      createDurableKeyProvider({dbQuery:query})(),createDurableKeyProvider({dbQuery:query})()
    ])
    assert.equal(a.key.toString('hex'),b.key.toString('hex'))
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM app_keys').get().n,1)
  } finally { db.close() }
})
test('actual secretbox decrypts after fixture database reopen and fresh module load', async () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'recorder-session-key-'))
  let fixture=database(path.join(dir,'fixture.db'))
  const moduleFor=query=>load('lib/secretbox.js',{
    './db':{dbQuery:query}, './secretbox-key-store':{createDurableKeyProvider}
  })
  try {
    const first=moduleFor(fixture.query)
    const sealed=await first.encryptSecret('fixture-session-not-real')
    fixture.db.close(); fixture=database(path.join(dir,'fixture.db'))
    const second=moduleFor(fixture.query)
    assert.equal(await second.decryptSecret(sealed.ciphertext,sealed.keyVersion),'fixture-session-not-real')
  } finally { fixture.db.close();fs.rmSync(dir,{recursive:true,force:true}) }
})
function routeFixture(query) {
  const handlers=new Map()
  const router={use(){},post(p,f){handlers.set('POST '+p,f)},get(){},delete(){}}
  load('routes/x-connections.js',{
    express:{Router:()=>router}, '../lib/db':{dbQuery:query},
    '../lib/secretbox':{encryptSecret:async()=>{throw Error('private encryption failure')}},
    '../lib/xapi':{verifySession:async()=>({ok:true,id:'fixture_account',handle:'fixture',name:'Fixture'})},
    '../lib/x-connection-owner':{xConnectionOwnerGuard(){}}
  })
  const req={body:{cookie:'auth_token=fixture; ct0=fixture',consent:true},params:{id:'fixture_connection'},
    xConnectionOwner:{workspace:'telegram:123',user:'123'}}
  const res={statusCode:200,status(code){this.statusCode=code;return this},json(value){this.value=value;return this}}
  return {handlers,req,res}
}
test('connection completion returns a safe failure before any connection write', async () => {
  const {handlers,req,res}=routeFixture(async()=>{throw Error('Unexpected database access')})
  await handlers.get('POST /complete')(req,res)
  assert.equal(res.statusCode,503)
  assert.equal(res.value.error,'Connection could not be saved securely. Try again later.')
  assert.equal(res.value.ok,false)
})
test('reconnect encryption failure preserves the previous connection', async () => {
  const queries=[]
  const {handlers,req,res}=routeFixture(async sql=>{
    queries.push(sql)
    assert(sql.startsWith('SELECT'))
    return {rows:[{id:'fixture_connection'}]}
  })
  await handlers.get('POST /:id/reconnect')(req,res)
  assert.equal(res.statusCode,503)
  assert.equal(queries.length,1)
})
async function fallback(final) {
  let calls=0
  const value=await resolveWithSavedSession({input:'https://x.com/i/spaces/fixture_space',call:async()=>{
    calls++
    if(calls===1) return {status:200,json:{ok:false,code:'x_access_denied',canTryConnectedAccount:true}}
    if(calls===2) return {status:200,json:[{id:'fixture_connection',status:'active'}]}
    return final
  }})
  return {value,calls}
}
test('successful public resolution does not enumerate or use saved sessions', async () => {
  let calls=0
  const value=await resolveWithSavedSession({input:'fixture',call:async()=>{
    calls++;return {status:200,json:{ok:true,m3u8:'https://fixture.invalid/audio.m3u8'}}
  }})
  assert.equal(calls,1);assert.equal(value.needsConnection,false)
})
test('invalid saved session reaches Connect X handling instead of a generic stop', async () => {
  const {value,calls}=await fallback({status:409,json:{ok:false,code:'reconnect-required'}})
  assert.equal(calls,3);assert.equal(value.needsConnection,true);assert.equal(value.stop,false)
})
test('missing owner authorization is not misrepresented as an X login problem', async () => {
  const {value}=await fallback({status:403,json:{ok:false,code:'owner-required'}})
  assert.equal(value.needsConnection,false);assert.equal(value.stop,true)
})
test('unrelated upstream failure does not request a fresh X login', async () => {
  const {value}=await fallback({status:503,json:{ok:false,code:'x_unavailable'}})
  assert.equal(value.needsConnection,false);assert.equal(value.stop,true)
})

