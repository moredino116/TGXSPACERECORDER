const test=require('node:test')
const assert=require('node:assert/strict')
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto')
const {createBrowserConnectionStore}=require('../lib/x-browser-store')
const {attachXBrowserRoutes}=require('../lib/x-browser-routes')
const attempt='b'+'a'.repeat(48),second='b'+'b'.repeat(48)
const material={cookie:'auth_token=fixture_auth; ct0=fixture_csrf',csrf:'fixture_csrf'}
const identity={id:'456',handle:'fixture_user',name:'Fixture user'}
function fixture(t) {
  const {DatabaseSync}=require('node:sqlite')
  const {SQL}=require('../db/schema')
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'browser-store-fixture-')),file=path.join(dir,'fixture.db')
  let db=new DatabaseSync(file);db.exec(SQL)
  const key=crypto.randomBytes(32)
  async function encryptSecret(plain) {
    const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',key,iv)
    const encrypted=Buffer.concat([cipher.update(plain,'utf8'),cipher.final()])
    return {ciphertext:iv.toString('hex')+':'+cipher.getAuthTag().toString('hex')+':'+encrypted.toString('hex'),keyVersion:'fixture'}
  }
  async function decryptSecret(value) {
    const [iv,tag,body]=value.split(':'),dec=crypto.createDecipheriv('aes-256-gcm',key,Buffer.from(iv,'hex'))
    dec.setAuthTag(Buffer.from(tag,'hex'));return Buffer.concat([dec.update(Buffer.from(body,'hex')),dec.final()]).toString('utf8')
  }
  const getDb=()=>db
  const make=()=>createBrowserConnectionStore({getDb,encryptSecret})
  const args={ownerId:'123',attemptId:attempt,requestId:'request_one',identity,material}
  const query=async(sql,params=[])=>{
    const values=[];const normalized=sql.replace(/\$(\d+)/g,(_,n)=>{values.push(params[Number(n)-1]);return '?'})
    return {rows:db.prepare(normalized).all(...values)}
  }
  t.after(()=>{db.close();fs.rmSync(dir,{recursive:true,force:true})})
  return {get db(){return db},store:make(),args,make,decryptSecret,query,
    reopen(){db.close();db=new DatabaseSync(file);db.exec(SQL)}}
}
test('SQLite store saves ciphertext and an owner-bound receipt atomically',async t=>{
  const f=fixture(t),conn=await f.store.save(f.args)
  const row=f.db.prepare('SELECT * FROM x_connections WHERE id=?').get(conn.id)
  assert.equal(row.workspace_id,'telegram:123');assert.equal(String(row.user_id),'123')
  assert.equal(row.auth_type,'session');assert.equal(row.status,'active')
  assert(!row.encrypted_credentials.includes('fixture_auth'))
  assert.equal(JSON.parse(await f.decryptSecret(row.encrypted_credentials)).cookie,material.cookie)
  assert.equal((await f.store.lookupSaved(f.args)).state,'saved')
  assert(!JSON.stringify(conn).includes('encrypted_credentials'))
})
test('SQLite receipt and connection survive reopen with a fresh store instance',async t=>{
  const f=fixture(t),first=await f.store.save(f.args);f.reopen()
  const receipt=await f.make().lookupSaved(f.args)
  assert.equal(receipt.state,'saved');assert.equal(receipt.connection.id,first.id);assert.equal(receipt.requestId,'request_one')
})
test('repeated SQLite save returns the same connection and single receipt',async t=>{
  const f=fixture(t),a=await f.store.save(f.args),b=await f.store.save(f.args)
  assert.equal(a.id,b.id)
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM x_connections').get().n,1)
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM x_browser_connection_receipts_v1').get().n,1)
})
test('new login attempt for the same account updates rather than duplicates its connection',async t=>{
  const f=fixture(t),a=await f.store.save(f.args)
  f.db.prepare("UPDATE x_connections SET status='reauth_required',revoked_at='fixture' WHERE id=?").run(a.id)
  const b=await f.store.save({...f.args,attemptId:second})
  assert.equal(a.id,b.id);assert.equal((await f.store.lookupSaved({...f.args,attemptId:second})).state,'saved')
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM x_connections').get().n,1)
})
test('one Telegram owner cannot read another owners receipt',async t=>{
  const f=fixture(t);await f.store.save(f.args)
  await assert.rejects(()=>f.store.lookupSaved({...f.args,ownerId:'999'}),e=>e.code==='BROWSER_CONNECTION_SAVE_UNCONFIRMED')
})
test('same X account stays isolated between different Telegram owners',async t=>{
  const f=fixture(t),a=await f.store.save(f.args)
  const b=await f.store.save({...f.args,ownerId:'999',attemptId:second})
  assert.notEqual(a.id,b.id)
  assert.equal((await f.store.lookupSaved(f.args)).connection.id,a.id)
})
test('reusing an attempt cannot silently change its account or original request',async t=>{
  const f=fixture(t);await f.store.save(f.args)
  for(const change of [{identity:{...identity,id:'789'}},{requestId:'different_request'}])
    await assert.rejects(()=>f.store.save({...f.args,...change}),e=>e.code==='BROWSER_CONNECTION_SAVE_UNCONFIRMED')
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM x_connections').get().n,1)
})
test('receipt insert failure rolls back the connection write',async t=>{
  const f=fixture(t);await f.store.lookupSaved(f.args)
  f.db.exec(`CREATE TRIGGER fixture_receipt_failure BEFORE INSERT ON x_browser_connection_receipts_v1
    BEGIN SELECT RAISE(ABORT,'fixture failure'); END`)
  await assert.rejects(()=>f.store.save(f.args),e=>e.message==='Connection save could not be confirmed.')
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM x_connections').get().n,0)
  assert.equal((await f.store.lookupSaved(f.args)).state,'not_saved')
})
test('deleted connection is not recreated by replaying its old save attempt',async t=>{
  const f=fixture(t),conn=await f.store.save(f.args)
  f.db.prepare('DELETE FROM x_connections WHERE id=?').run(conn.id)
  assert.equal((await f.store.lookupSaved(f.args)).state,'saved_unavailable')
  await assert.rejects(()=>f.store.save(f.args),e=>e.code==='BROWSER_CONNECTION_SAVE_UNCONFIRMED')
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM x_connections').get().n,0)
})
test('existing session loader can consume the new connection and still defaults to public',async t=>{
  const f=fixture(t),conn=await f.store.save(f.args)
  const {sessionForRequest}=require('../lib/x-session-for-request')
  const deps={dbQuery:f.query,decryptSecret:f.decryptSecret,resolveOwner:()=>({workspace:'telegram:123',user:'123'})}
  const loaded=await sessionForRequest({accessMode:'connected_account',xConnectionId:conn.id},{},deps)
  assert.equal(loaded.cookie,material.cookie);assert.equal(loaded.csrf,material.csrf)
  const publicResult=await sessionForRequest({}, {},{dbQuery:()=>{throw Error('unexpected')},decryptSecret:()=>{throw Error('unexpected')}})
  assert.equal(publicResult.accessMode,'public');assert.equal(publicResult.cookie,null)
})
test('real SQLite receipt reconciles a lost save acknowledgement without a second save',async t=>{
  const f=fixture(t);let saves=0
  const {createXBrowserConnector}=require('../lib/x-browser-connector')
  const connector=createXBrowserConnector({open:async()=>({material:async()=>material,close:async()=>{}}),
    verify:async()=>({ok:true,...identity}),save:async args=>{saves++;await f.store.save(args);throw Error('fixture lost acknowledgement')},
    lookupSaved:f.store.lookupSaved,schedule:()=>null,unschedule(){}})
  const lease=await connector.start('123','request_one')
  await assert.rejects(()=>connector.finish('123',lease.id),e=>e.code==='save_reconciliation_required')
  const confirmed=await connector.reconcile('123',lease.id)
  assert.equal(confirmed.phase,'connected');assert.equal(saves,1)
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM x_connections').get().n,1)
})
test('a disconnected saved receipt safely releases an uncertain browser attempt',async t=>{
  const f=fixture(t)
  const {createXBrowserConnector}=require('../lib/x-browser-connector')
  const connector=createXBrowserConnector({open:async()=>({material:async()=>material,close:async()=>{}}),
    verify:async()=>({ok:true,...identity}),save:async args=>{await f.store.save(args);throw Error('fixture')},
    lookupSaved:f.store.lookupSaved,schedule:()=>null,unschedule(){}})
  const lease=await connector.start('123')
  await assert.rejects(()=>connector.finish('123',lease.id))
  f.db.prepare('DELETE FROM x_connections').run()
  assert.equal((await connector.reconcile('123',lease.id)).phase,'failed')
  const fresh=await connector.start('123');await connector.cancel('123',fresh.id)
})
function api(options={}) {
  const handlers=new Map(),calls=[];let builds=0
  const connector={}
  for(const action of ['start','status','frame','input','finish','cancel','reconcile']) connector[action]=async(...args)=>{
    calls.push({action,args});return {id:attempt,phase:'ready',requestId:'request_one'}
  }
  const service={connector,lookupSaved:async()=>({state:'not_saved'})}
  attachXBrowserRoutes({post:(p,fn)=>handlers.set(p,fn)},{
    resolveOwner:()=>({workspace:'telegram:123',user:'123'}),
    getService:()=>{builds++;return service},...options,
  })
  async function call(action,body={},method='POST') {
    const req={method,body,params:{id:attempt}},headers={}
    const res={statusCode:200,setHeader:(k,v)=>{headers[k]=v},status(n){this.statusCode=n;return this},json(value){this.value=value;return this}}
    await handlers.get(action==='start'?'/start':'/:id/'+action)(req,res)
    return {res,headers}
  }
  return {call,calls,service,get builds(){return builds}}
}
test('API denies missing owner before any service or storage initialization',async()=>{
  const f=api({resolveOwner:()=>null});const {res}=await f.call('start',{consent:true})
  assert.equal(res.statusCode,403);assert.equal(f.builds,0)
})
test('API start requires explicit consent and rejects client-supplied ownership',async()=>{
  const f=api()
  for(const body of [{},{consent:false},{consent:true,ownerId:'999'},{consent:true,cookie:'do-not-accept'}]) {
    assert.equal((await f.call('start',body)).res.statusCode,400)
  }
  assert.equal(f.builds,0)
})
test('API start uses the verified owner and preserves the request ID',async()=>{
  const f=api();const {res,headers}=await f.call('start',{consent:true,requestId:'request_one'})
  assert.equal(res.statusCode,200);assert.deepEqual(f.calls[0],{action:'start',args:['123','request_one']})
  assert.equal(headers['Cache-Control'],'no-store')
})
test('API only accepts POST and sets no-store on failures too',async()=>{
  const f=api();const {res,headers}=await f.call('status',{},'GET')
  assert.equal(res.statusCode,405);assert.equal(headers.Allow,'POST');assert.equal(headers['Cache-Control'],'no-store');assert.equal(f.builds,0)
})
test('API input carries only the verified owner and bounded connector identifiers',async()=>{
  const f=api();await f.call('input',{sequence:1,action:{type:'key',key:'Enter'}})
  assert.deepEqual(f.calls[0],{action:'input',args:['123',attempt,1,{type:'key',key:'Enter'}]})
})
test('API never returns private exception messages',async()=>{
  const f=api();f.service.connector.frame=async()=>{throw Error('private cookie and database detail')}
  const {res}=await f.call('frame');assert.equal(res.statusCode,503)
  assert.deepEqual(res.value,{ok:false,code:'connection_not_confirmed'})
})
test('API requires a live owner-bound save receipt before reporting connected',async()=>{
  const f=api();f.service.connector.finish=async()=>({id:attempt,phase:'connected',connection:{id:'fixture_conn'},requestId:'request_one'})
  assert.equal((await f.call('finish')).res.statusCode,409)
})
test('API connected output is projected from the verified receipt without credentials',async()=>{
  const f=api();f.service.connector.finish=async()=>({id:attempt,phase:'connected',expiresAt:123,connection:{id:'fixture_conn'},requestId:'request_one',cookie:'MUST_NOT_RETURN'})
  f.service.lookupSaved=async()=>({ownerId:'123',attemptId:attempt,state:'saved',connection:{id:'fixture_conn',x_handle:'fixture',encrypted_credentials:'MUST_NOT_RETURN'}})
  const {res}=await f.call('finish');assert.equal(res.statusCode,200);assert.equal(res.value.phase,'connected')
  assert(!JSON.stringify(res.value).includes('MUST_NOT_RETURN'))
})
test('runtime wiring constructs without opening storage or a browser',()=>{
  const {createXBrowserService}=require('../lib/x-browser-service')
  const service=createXBrowserService()
  assert.equal(typeof service.connector.start,'function')
  assert.equal(typeof service.lookupSaved,'function')
})
