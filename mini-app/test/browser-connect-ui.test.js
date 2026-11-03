const test=require('node:test'),assert=require('node:assert/strict')
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto')
const {chromium}=require(process.env.TEST_PLAYWRIGHT_MODULE)
const root=path.join(__dirname,'../..'),publicDir=path.join(root,'mini-app/public')
const {createXBrowserConnector}=require(path.join(root,'backend/lib/x-browser-connector'))
const {createBrowserConnectionStore}=require(path.join(root,'backend/lib/x-browser-store'))
const {attachXBrowserRoutes}=require(path.join(root,'backend/lib/x-browser-routes'))
const {resolveXConnectionOwner}=require(path.join(root,'backend/lib/x-connection-owner'))
const {createPendingRecordingRetry}=require(path.join(root,'backend/lib/pending-recording-retry'))
const verify=require('../lib/verify')
const jpeg=Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAA4KCw0LCQ4NDA0QDw4RFiQXFhQUFiwgIRokNC43NjMuMjI6QVNGOj1OPjIySGJJTlZYXV5dOEVmbWVabFNbXVn/2wBDAQ8QEBYTFioXFypZOzI7WVlZWVlZWVlZWVlZWVlZWVlZWVlZWVlZWVlZWVlZWVlZWVlZWVlZWVlZWVlZWVlZWVn/wAARCAMMAYYDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDz6iiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACtiHzd9vt3fYNi+Zj7nT589s5z79PaseimnYzqU+c2llP9pafH58x5t/3ZHyD5V9/wClQRM9yl2sck9y3kDAdef9YnQZNZlF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FFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAf/2Q==','base64')
const env={TELEGRAM_BOT_TOKEN:'fixture-bot-only',TELEGRAM_ALLOWED_USER_IDS:'123',RECORDER_RELAY_KEY:'fixture-relay-only',ORACLE_ORIGIN:'https://oracle-fixture.invalid'}
const material={cookie:'auth_token=fixture_auth; ct0=fixture_csrf',csrf:'fixture_csrf'}
let browser
test.before(async()=>{browser=await chromium.launch({headless:true,timeout:20000})})
test.after(async()=>{if(browser)await browser.close()})
function initData(id=123) {
  const p=new URLSearchParams({auth_date:String(Math.floor(Date.now()/1000)),user:JSON.stringify({id})})
  const data=[...p.entries()].map(([k,v])=>k+'='+v).sort().join('\n')
  const secret=crypto.createHmac('sha256','WebAppData').update(env.TELEGRAM_BOT_TOKEN).digest()
  p.set('hash',crypto.createHmac('sha256',secret).update(data).digest('hex'));return p.toString()
}
async function fixture(t,options={}) {
  const {DatabaseSync}=require('node:sqlite'),{SQL}=require(path.join(root,'backend/db/schema'))
  const db=new DatabaseSync(':memory:');db.exec(SQL)
  const key=crypto.randomBytes(32)
  async function encryptSecret(value){const iv=crypto.randomBytes(12),c=crypto.createCipheriv('aes-256-gcm',key,iv);const out=Buffer.concat([c.update(value,'utf8'),c.final()]);return{ciphertext:iv.toString('hex')+':'+c.getAuthTag().toString('hex')+':'+out.toString('hex'),keyVersion:'fixture'}}
  async function decryptSecret(value){const [iv,tag,body]=value.split(':'),d=crypto.createDecipheriv('aes-256-gcm',key,Buffer.from(iv,'hex'));d.setAuthTag(Buffer.from(tag,'hex'));return Buffer.concat([d.update(Buffer.from(body,'hex')),d.final()]).toString('utf8')}
  const store=createBrowserConnectionStore({getDb:()=>db,encryptSecret})
  const f={opens:0,closes:0,starts:0,resumes:0,inputs:[],paths:[],blocked:[],errors:[],signedIn:false,resolutions:0}
  const row={id:'request_one',space_id:'fixture_space',state:options.requestState||'waiting_connection',job_id:options.requestState==='recording'?'fixture_job':null}
  const pending={get:(id,owner)=>id==='request_one'&&owner==='123'?{...row}:null,
    claim:(id,owner)=>{if(row.state!=='waiting_connection')return null;row.state='resolving';return{...row,claim_token:'fixture_claim'}},
    releaseResolution:()=>{row.state='waiting_connection';return true},markSubmitting:()=>{row.state='submitting';return true},
    markStarted:(id,owner,token,job)=>{row.state='recording';row.job_id=job;return true}}
  const query=async(sql,params=[])=>{const values=[];const text=sql.replace(/\$(\d+)/g,(_,n)=>{values.push(params[Number(n)-1]);return '?'});return{rows:db.prepare(text).all(...values)}}
  const retry=createPendingRecordingRetry({store:pending,
    getConnection:async(id,owner)=>db.prepare('SELECT * FROM x_connections WHERE id=? AND workspace_id=? AND user_id=?').get(id,'telegram:'+owner,owner),
    resolve:async args=>{
      f.resolutions++
      if(options.rejectOld && f.resolutions===1)return{status:200,json:{ok:false,code:'x_authentication_rejected'}}
      const {sessionForRequest}=require(path.join(root,'backend/lib/x-session-for-request'))
      const loaded=await sessionForRequest(args,{}, {dbQuery:query,decryptSecret,resolveOwner:()=>({workspace:'telegram:123',user:'123'})})
      assert.equal(loaded.cookie,material.cookie)
      return{status:200,json:{ok:true,m3u8:'https://fixture.invalid/audio.m3u8',title:'Fixture Space'}}
    },start:async args=>{f.starts++;assert.equal(args.body.accessMode,'connected_account');assert(!Object.hasOwn(args.body,'cookie'));return{status:200,json:{id:'fixture_job'}}}})
  const connector=createXBrowserConnector({
    open:async()=>{f.opens++;return{capture:async()=>jpeg,input:async a=>{f.inputs.push(a);if(a.type==='key'&&a.key==='Enter')f.signedIn=true},material:async()=>f.signedIn?material:null,close:async()=>{f.closes++}}},
    verify:async()=>options.verificationFails?{ok:false,status:403}:{ok:true,id:'456',handle:'fixture_user'},
    save:async args=>{const result=await store.save(args);if(options.loseSaveAck){options.loseSaveAck=false;throw Error('fixture lost receipt')}return result},
    lookupSaved:store.lookupSaved,schedule:()=>null,unschedule(){}})
  const handlers=new Map()
  attachXBrowserRoutes({post:(p,fn)=>handlers.set(p,fn)},{resolveOwner:req=>resolveXConnectionOwner(req,env),getService:()=>({connector,lookupSaved:store.lookupSaved})})
  if(options.saved) {
    const saved=await store.save({ownerId:'123',attemptId:'b'+'f'.repeat(48),requestId:null,identity:{id:'456',handle:'fixture_user'},material})
    if(options.saved==='invalid')db.prepare("UPDATE x_connections SET status='invalid' WHERE id=?").run(saved.id)
  }
  function response(){return{statusCode:200,headers:{},setHeader(k,v){this.headers[k.toLowerCase()]=v;return this},status(n){this.statusCode=n;return this},json(value){this.body=Buffer.from(JSON.stringify(value));return this},send(value){this.body=Buffer.from(value);return this}}}
  async function backendFetch(url,init) {
    assert.equal(new URL(url).origin,env.ORACLE_ORIGIN)
    const target=new URL(url).pathname.slice('/api/'.length),owner=resolveXConnectionOwner({headers:init.headers},env)
    assert(owner);const body=init.body?JSON.parse(init.body):{}
    f.paths.push(init.method+' '+target)
    let res=response()
    if(target.startsWith('x-browser/')) {
      const bits=target.split('/'),pattern=bits.length===2?'/start':'/:id/'+bits[2]
      const handler=handlers.get(pattern);assert(handler,'Unexpected browser endpoint')
      await handler({method:init.method,headers:init.headers,body,params:{id:bits[1]}},res)
    } else if(target==='x-connections' && init.method==='GET') {
      if(options.badList)res.json({unexpected:true})
      else res.json(db.prepare("SELECT id,x_handle,status,expires_at,revoked_at FROM x_connections WHERE workspace_id=? AND user_id=? AND status<>'disconnected'").all(owner.workspace,owner.user))
    } else if(target.startsWith('x-connections/') && init.method==='DELETE') {
      db.prepare('DELETE FROM x_connections WHERE id=? AND workspace_id=? AND user_id=?').run(target.split('/')[1],owner.workspace,owner.user);res.json({ok:true})
    } else if(target==='space/requests/request_one' && init.method==='GET') res.json({ok:true,requestId:'request_one',state:row.state,jobId:row.job_id})
    else if(target==='space/requests/request_one/resume' && init.method==='POST') {
      f.resumes++;const result=await retry.resume({ownerId:owner.user,requestId:'request_one',connectionId:body.connectionId});res.status(result.status).json(result.json)
    } else throw Error('Unexpected fixture backend endpoint: '+target)
    const output=res.body||Buffer.from('{}')
    return{status:res.statusCode,headers:{get:k=>res.headers[k.toLowerCase()]||'application/json'},arrayBuffer:async()=>Uint8Array.from(output).buffer}
  }
  const relayModule={exports:{}}
  vm.runInNewContext(fs.readFileSync(path.join(root,'mini-app/api/relay.js'),'utf8'),{
    module:relayModule,exports:relayModule.exports,process:{env},Buffer,URL,AbortController,setTimeout,clearTimeout,
    require:name=>{assert.equal(name,'../lib/verify');return verify},fetch:backendFetch,
  },{filename:'fixture-real-relay.js'})
  const context=await browser.newContext({viewport:{width:options.width||390,height:900},serviceWorkers:'block'})
  context.setDefaultTimeout(12000)
  await context.routeWebSocket('**/*',socket=>socket.close())
  await context.addInitScript(value=>{window.Telegram={WebApp:{initData:value,ready(){},expand(){}}}},options.noIdentity?'':initData(options.deniedUser?999:123))
  const csp=JSON.parse(fs.readFileSync(path.join(root,'mini-app/vercel.json'),'utf8')).headers.flatMap(item=>item.headers).find(h=>h.key.toLowerCase()==='content-security-policy').value
  await context.route('**/*',async route=>{
    const req=route.request(),url=new URL(req.url()),p=url.pathname
    try {
      if(url.origin==='https://telegram.org'&&p==='/js/telegram-web-app.js')return await route.fulfill({contentType:'application/javascript',body:'/* offline SDK fixture */'})
      if(url.origin!=='https://recorder.test'){f.blocked.push(req.url());return await route.abort()}
      if(p==='/' || p==='/index.html')return await route.fulfill({contentType:'text/html',headers:{'content-security-policy':csp},body:fs.readFileSync(path.join(publicDir,'index.html'))})
      const assets=['app.css','manage.js','connect-browser.js','manage-connection.js','manage-exports.js']
      if(assets.includes(p.slice(1)))return await route.fulfill({contentType:p.endsWith('.css')?'text/css':'application/javascript',body:fs.readFileSync(path.join(publicDir,p.slice(1)))})
      if(p==='/favicon.ico')return await route.fulfill({status:204,body:''})
      if(p.startsWith('/relay/')) {
        const res=response()
        await relayModule.exports({method:req.method(),headers:req.headers(),query:{path:p.slice('/relay/'.length)},body:req.postData()?JSON.parse(req.postData()):undefined},res)
        if(options.dropInputOnce&&p.endsWith('/input')){options.dropInputOnce=false;return await route.abort('failed')}
        return await route.fulfill({status:res.statusCode,headers:res.headers,contentType:'application/json',body:res.body||Buffer.from('{}')})
      }
      f.blocked.push(req.method()+' '+p);await route.abort()
    } catch(error){if(!f.closing)f.errors.push(error.message);await route.abort().catch(()=>{})}
  })
  const page=await context.newPage();page.on('pageerror',e=>f.errors.push(e.message))
  Object.assign(f,{page,db,row,context})
  t.after(async()=>{f.closing=true;await context.close();await new Promise(setImmediate);db.close();assert.deepEqual(f.errors,[]);assert.deepEqual(f.blocked,[])})
  await page.goto('https://recorder.test/'+(options.query??'?connect=x'),{waitUntil:'load'})
  return f
}
async function begin(f){await f.page.getByLabel('Authorize X session reuse',{exact:true}).check();await f.page.getByRole('button',{name:/^(Connect X|Reconnect X)$/}).click();await f.page.locator('.x-browser-screen').waitFor({state:'visible'});await f.page.waitForFunction(()=>document.querySelector('.x-browser-screen').naturalWidth>0)}
async function signIn(f){await begin(f);await f.page.getByLabel('Text for selected X field',{exact:true}).fill('fixture text only');await f.page.getByRole('button',{name:'Send text',exact:true}).click();await f.page.getByRole('button',{name:'Enter',exact:true}).click()}
test('new entry loads browser connection UI instead of the legacy cookie form',async t=>{
  const f=await fixture(t);await f.page.getByText('Not connected',{exact:true}).waitFor()
  assert.equal(await f.page.getByLabel('Authenticated X session',{exact:true}).count(),0)
  assert.equal(await f.page.locator('script[src="connect.js"]').count(),0);assert.equal(f.opens,0)
})
test('no Telegram identity means no connection or recording API calls',async t=>{
  const f=await fixture(t,{noIdentity:true});await f.page.getByText('Open account setup from the bot in Telegram.',{exact:true}).waitFor();assert.equal(f.paths.length,0)
})
test('an invalid request link stops before API access',async t=>{
  const f=await fixture(t,{query:'?connect=x&request=bad%2Fid'});await f.page.getByText('Invalid saved request link. Return to the bot.',{exact:true}).waitFor();assert.equal(f.paths.length,0)
})
test('unapproved Telegram identity cannot initialize a private browser',async t=>{
  const f=await fixture(t,{deniedUser:true});await f.page.getByText('Connection status unavailable',{exact:true}).waitFor();assert.equal(f.opens,0)
})
test('account setup preserves the exact selected clip return link',async t=>{
  const f=await fixture(t,{query:'?connect=x&return_kind=clip&return_id=fixture_clip'});await f.page.getByText('Not connected',{exact:true}).waitFor()
  const link=await f.page.getByRole('link',{name:'Back to selected item',exact:true}).getAttribute('href')
  assert.equal(new URL(link,'https://recorder.test').searchParams.get('id'),'fixture_clip');assert.equal(f.starts,0)
})
test('a malformed saved-account list does not enable sign-in or claim not connected',async t=>{
  const f=await fixture(t,{badList:true});await f.page.getByText('Connection status unavailable',{exact:true}).waitFor()
  await f.page.getByLabel('Authorize X session reuse',{exact:true}).check();assert(await f.page.getByRole('button',{name:'Connect X',exact:true}).isDisabled());assert.equal(f.opens,0)
})
test('validated browser login saves through real relay/routes/SQLite and automatically retries once',async t=>{
  const f=await fixture(t,{query:'?connect=x&request=request_one'});await signIn(f)
  await f.page.locator('.x-browser-request').filter({hasText:'Recording job confirmed: fixture_job'}).waitFor()
  assert.equal(f.opens,1);assert.equal(f.closes,1);assert.equal(f.starts,1);assert.equal(f.resumes,1)
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM x_connections').get().n,1)
  assert.equal(await f.page.locator('.x-browser-screen').getAttribute('src'),null)
  assert.equal(await f.page.getByLabel('Text for selected X field',{exact:true}).inputValue(),'')
  assert.equal(await f.page.evaluate(()=>localStorage.length+sessionStorage.length),0)
  assert(!(await f.page.locator('main').innerText()).includes('fixture_auth'))
})
test('future request reuses the saved connection without opening another browser',async t=>{
  const f=await fixture(t,{saved:'active',query:'?connect=x&request=request_one'})
  await f.page.locator('.x-browser-request').filter({hasText:'Recording job confirmed: fixture_job'}).waitFor()
  assert.equal(f.opens,0);assert.equal(f.starts,1)
})
test('an uncertain original recording submission is not submitted again',async t=>{
  const f=await fixture(t,{saved:'active',requestState:'submitting',query:'?connect=x&request=request_one'})
  await f.page.locator('.x-browser-request').filter({hasText:'uncertain outcome'}).waitFor();assert.equal(f.starts,0);assert.equal(f.resumes,0)
})
test('already-recording request displays its saved job without another start',async t=>{
  const f=await fixture(t,{saved:'active',requestState:'recording',query:'?connect=x&request=request_one'})
  await f.page.locator('.x-browser-request').filter({hasText:'Recording job confirmed: fixture_job'}).waitFor();assert.equal(f.starts,0);assert.equal(f.resumes,0)
})
test('a rejected old session gets a reconnect action and successful reconnect retries the same request',async t=>{
  const f=await fixture(t,{saved:'active',rejectOld:true,query:'?connect=x&request=request_one'})
  await f.page.getByText('Reconnect required',{exact:true}).waitFor();assert.equal(f.starts,0)
  await signIn(f);await f.page.locator('.x-browser-request').filter({hasText:'Recording job confirmed: fixture_job'}).waitFor()
  assert.equal(f.starts,1);assert.equal(f.resolutions,2)
})
test('lost save acknowledgement is reconciled without duplicate connection or recording',async t=>{
  const f=await fixture(t,{loseSaveAck:true,query:'?connect=x&request=request_one'});await signIn(f)
  await f.page.locator('.x-browser-request').filter({hasText:'Recording job confirmed: fixture_job'}).waitFor()
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM x_connections').get().n,1);assert.equal(f.starts,1)
})
test('lost input response retries the same sequence without typing twice',async t=>{
  const f=await fixture(t,{dropInputOnce:true});await begin(f)
  await f.page.getByLabel('Text for selected X field',{exact:true}).fill('fixture text only');await f.page.getByRole('button',{name:'Send text',exact:true}).click()
  await f.page.waitForTimeout(400);assert.equal(f.inputs.filter(a=>a.type==='text').length,1)
  await f.page.getByRole('button',{name:'Cancel connection',exact:true}).click()
})
test('cancelling a temporary connection does not save or start recording',async t=>{
  const f=await fixture(t,{query:'?connect=x&request=request_one'});await begin(f)
  await f.page.getByRole('button',{name:'Cancel connection',exact:true}).click()
  await f.page.getByText('Temporary connection closed. No new session was saved.',{exact:true}).waitFor()
  assert.equal(f.starts,0);assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM x_connections').get().n,0)
})
test('disconnect removes the saved session without starting a recording',async t=>{
  const f=await fixture(t,{saved:'active'});await f.page.getByText('Connected',{exact:true}).waitFor()
  await f.page.getByRole('button',{name:'Disconnect X',exact:true}).click();await f.page.getByText('Not connected',{exact:true}).waitFor()
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM x_connections').get().n,0);assert.equal(f.starts,0)
})
test('mobile browser view has no horizontal overflow and maps private-image clicks',async t=>{
  const f=await fixture(t,{width:320});await begin(f)
  await f.page.locator('.x-browser-screen').click({position:{x:50,y:50}})
  await f.page.waitForTimeout(150);assert(f.inputs.some(a=>a.type==='click'&&a.x>=0&&a.x<390&&a.y>=0&&a.y<780))
  assert.equal(await f.page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false)
  await f.page.getByRole('button',{name:'Cancel connection',exact:true}).click()
})

