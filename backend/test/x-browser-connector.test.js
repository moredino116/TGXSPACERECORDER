const test=require('node:test')
const assert=require('node:assert/strict')
const {createXBrowserConnector,validateInput}=require('../lib/x-browser-connector')
const {allowedRequest,sessionMaterial,createPlaywrightSessionDriver}=require('../lib/x-browser-driver')
function fixture(options={}) {
  const count={open:0,close:0,input:0,verify:0,save:0};let clock=100000
  const resource={capture:async()=>Buffer.from('fixture-frame'),input:async()=>{count.input++},
    material:async()=>({cookie:'auth_token=fixture; ct0=fixture',csrf:'fixture'}),close:async()=>{count.close++}}
  const connector=createXBrowserConnector({
    open:async()=>{count.open++;return resource},
    verify:async()=>{count.verify++;return {ok:true,id:'456',handle:'fixture_user'}},
    save:async()=>{count.save++;return {id:'fixture_connection',status:'active',encrypted_credentials:'MUST_NOT_BE_RETURNED'}},
    now:()=>clock,schedule:()=>null,unschedule(){},...options,
  })
  return {connector,count,resource,setClock:value=>{clock=value}}
}
const denied=(fn,code)=>assert.rejects(fn,error=>error.code===code)
test('invalid owner cannot open a browser',async()=>{
  const f=fixture();await denied(()=>f.connector.start('not-an-owner'),'owner_required');assert.equal(f.count.open,0)
})
test('repeated start for the same owner and request reuses one browser',async()=>{
  const f=fixture();const a=await f.connector.start('123','request_one');const b=await f.connector.start('123','request_one')
  assert.equal(a.id,b.id);assert.equal(f.count.open,1);await f.connector.cancel('123',a.id)
})
test('another owner cannot view, type, finish, or cancel the connection',async()=>{
  const f=fixture();const s=await f.connector.start('123')
  for(const fn of [()=>f.connector.frame('999',s.id),()=>f.connector.input('999',s.id,1,{type:'text',text:'x'}),
      ()=>f.connector.finish('999',s.id),()=>f.connector.cancel('999',s.id)]) await denied(fn,'connection_unavailable')
  assert.equal(f.count.input,0);assert.equal(f.count.save,0);await f.connector.cancel('123',s.id)
})
test('only one active browser is allowed globally',async()=>{
  const f=fixture();const s=await f.connector.start('123');await denied(()=>f.connector.start('999'),'browser_capacity_busy')
  assert.equal(f.count.open,1);await f.connector.cancel('123',s.id)
})
test('repeated input sequence does not type credentials twice',async()=>{
  const f=fixture();const s=await f.connector.start('123')
  await f.connector.input('123',s.id,1,{type:'text',text:'fixture-only'})
  await f.connector.input('123',s.id,1,{type:'text',text:'fixture-only'})
  assert.equal(f.count.input,1)
  await denied(()=>f.connector.input('123',s.id,3,{type:'key',key:'Enter'}),'input_sequence_conflict')
  await f.connector.cancel('123',s.id)
})
test('unsupported input and browser shortcuts are rejected',()=>{
  for(const action of [{type:'evaluate',text:'x'},{type:'key',key:'Control+L'},{type:'click',x:400,y:2},{type:'text',text:'x'.repeat(2049)}])
    assert.throws(()=>validateInput(action),e=>e.code==='invalid_input')
})
test('expired connection closes its browser and cannot save credentials',async()=>{
  const f=fixture();const s=await f.connector.start('123');f.setClock(s.expiresAt)
  await denied(()=>f.connector.finish('123',s.id),'connection_expired')
  assert.equal(f.count.close,1);assert.equal(f.count.save,0)
})
test('missing sign-in cookies do not call verification or storage',async()=>{
  const f=fixture();f.resource.material=async()=>null;const s=await f.connector.start('123')
  const result=await f.connector.finish('123',s.id);assert.equal(result.code,'sign_in_incomplete')
  assert.equal(f.count.verify,0);assert.equal(f.count.save,0);await f.connector.cancel('123',s.id)
})
test('unconfirmed account validation never saves or claims connection success',async()=>{
  const f=fixture({verify:async()=>({ok:false,status:403,reason:'fixture failure'})});const s=await f.connector.start('123')
  await denied(()=>f.connector.finish('123',s.id),'verification_not_confirmed');assert.equal(f.count.save,0)
})
test('a completed save returns only public connection fields and is idempotent',async()=>{
  const f=fixture();const s=await f.connector.start('123','request_one')
  const a=await f.connector.finish('123',s.id);const b=await f.connector.finish('123',s.id)
  assert.deepEqual(a,b);assert.equal(a.phase,'connected');assert.equal(a.requestId,'request_one')
  assert.equal(f.count.save,1);assert.equal(f.count.verify,1);assert.equal(f.count.close,1)
  const serialized=JSON.stringify(a)
  for(const secret of ['auth_token','ct0=','MUST_NOT_BE_RETURNED','encrypted_credentials']) assert(!serialized.includes(secret))
})
test('storage acknowledgement loss blocks blind resaving and a new login',async()=>{
  let saves=0;const f=fixture({save:async()=>{saves++;throw Error('private storage error')}})
  const s=await f.connector.start('123')
  await denied(()=>f.connector.finish('123',s.id),'save_reconciliation_required')
  await denied(()=>f.connector.finish('123',s.id),'save_reconciliation_required')
  await denied(()=>f.connector.start('123'),'save_reconciliation_required')
  assert.equal(saves,1)
})
test('cancellation closes the temporary browser without saving a connection',async()=>{
  const f=fixture();const s=await f.connector.start('123');await f.connector.cancel('123',s.id)
  assert.equal(f.count.close,1);assert.equal(f.count.save,0)
})
test('frame output carries only image and fixed viewport metadata',async()=>{
  const f=fixture();const s=await f.connector.start('123');const frame=await f.connector.frame('123',s.id)
  assert.deepEqual(Object.keys(frame).sort(),['height','id','imageBase64','mime','width'])
  await f.connector.cancel('123',s.id)
})
test('network restrictions reject foreign hosts, HTTP, credentials and custom ports',()=>{
  assert(allowedRequest('https://x.com/i/flow/login',true));assert(allowedRequest('https://abs.twimg.com/a.js'))
  for(const url of ['http://x.com/','https://x.com.evil.invalid/','https://x.com:444/','https://name:pass@x.com/','https://127.0.0.1/'])
    assert.equal(allowedRequest(url),false)
  assert.equal(allowedRequest('https://abs.twimg.com/login',true),false)
})
test('only matching secure X cookies become session material',()=>{
  const cookies=[{name:'auth_token',value:'fixture_auth',domain:'.x.com',secure:true},
    {name:'ct0',value:'fixture_csrf',domain:'.x.com',secure:true},
    {name:'unrelated',value:'excluded',domain:'.x.com',secure:true}]
  const material=sessionMaterial(cookies)
  assert.equal(material.cookie,'auth_token=fixture_auth; ct0=fixture_csrf')
  assert.equal(sessionMaterial(cookies.map(c=>({...c,domain:'evilx.com'}))),null)
  assert.equal(sessionMaterial(cookies.map(c=>({...c,secure:false}))),null)
  assert.equal(sessionMaterial([{...cookies[0],value:'bad\r\nvalue'},cookies[1]]),null)
})
test('the lifetime timer closes an idle browser without another client request',async()=>{
  let expire;const f=fixture({schedule:fn=>{expire=fn;return null}})
  const s=await f.connector.start('123');f.setClock(s.expiresAt);expire()
  await new Promise(setImmediate);assert.equal(f.count.close,1);assert.equal(f.count.save,0)
})
test('a browser opening after the deadline is closed rather than published',async()=>{
  let release;const f=fixture({open:()=>new Promise(resolve=>{release=resolve})})
  const pending=f.connector.start('123');f.setClock(999999);release(f.resource)
  await denied(()=>pending,'connection_expired');assert.equal(f.count.close,1)
})
test('overlapping completion calls cannot validate or save twice',async()=>{
  let release;const f=fixture({verify:()=>new Promise(resolve=>{release=resolve})})
  const s=await f.connector.start('123');const pending=f.connector.finish('123',s.id)
  while(!release) await new Promise(setImmediate)
  await denied(()=>f.connector.finish('123',s.id),'connection_busy')
  release({ok:true,id:'456',handle:'fixture_user'});await pending;assert.equal(f.count.save,1)
})
test('uncertain save can be confirmed only by an owner-bound persisted receipt',async()=>{
  const f=fixture({save:async()=>{throw Error('fixture lost acknowledgement')},
    lookupSaved:async args=>({...args,state:'saved',connection:{id:'fixture_connection',status:'active',cookie:'MUST_NOT_BE_RETURNED'}})})
  const s=await f.connector.start('123','request_one')
  await denied(()=>f.connector.finish('123',s.id),'save_reconciliation_required')
  const result=await f.connector.reconcile('123',s.id)
  assert.equal(result.phase,'connected');assert(!JSON.stringify(result).includes('MUST_NOT_BE_RETURNED'))
})
test('a mismatched save receipt cannot release an uncertain attempt',async()=>{
  const f=fixture({save:async()=>{throw Error('fixture')},lookupSaved:async()=>({ownerId:'999',attemptId:'wrong',state:'not_saved'})})
  const s=await f.connector.start('123')
  await denied(()=>f.connector.finish('123',s.id),'save_reconciliation_required')
  await denied(()=>f.connector.reconcile('123',s.id),'save_reconciliation_required')
  await denied(()=>f.connector.start('123'),'save_reconciliation_required')
})
test('an authoritative not-saved receipt permits a fresh explicit connection attempt',async()=>{
  const f=fixture({save:async()=>{throw Error('fixture')},lookupSaved:async args=>({...args,state:'not_saved'})})
  const s=await f.connector.start('123')
  await denied(()=>f.connector.finish('123',s.id),'save_reconciliation_required')
  assert.equal((await f.connector.reconcile('123',s.id)).phase,'failed')
  const fresh=await f.connector.start('123');assert.notEqual(fresh.id,s.id)
  await f.connector.cancel('123',fresh.id)
})
test('real Chromium adapter runs only against an intercepted local sign-in fixture',async()=>{
  const {chromium}=require(process.env.TEST_PLAYWRIGHT_MODULE)
  const requests=[];let fixtureContext,fixturePage
  const wrapped={launch:async options=>{
    const browser=await chromium.launch(options)
    const original=browser.newContext.bind(browser)
    browser.newContext=async config=>{
      const context=await original(config);fixtureContext=context
      context.on('page',page=>{fixturePage=page})
      await context.route('**/*',async route=>{
        requests.push(route.request().url())
        await route.fulfill({contentType:'text/html',body:'<!doctype html><title>Offline fixture</title><input autofocus style="height:40px;width:250px">'})
      })
      return context
    }
    return browser
  }}
  const resource=await createPlaywrightSessionDriver({chromium:wrapped})()
  try {
    await resource.input({type:'click',x:80,y:25})
    await resource.input({type:'text',text:'fixture only'})
    assert.equal(await fixturePage.locator('input').inputValue(),'fixture only')
    const image=await resource.capture();assert(Buffer.isBuffer(image));assert(image.length>0)
    assert.equal(await resource.material(),null)
    await fixtureContext.addCookies([
      {name:'auth_token',value:'fixture_auth',domain:'.x.com',path:'/',secure:true,httpOnly:true},
      {name:'ct0',value:'fixture_csrf',domain:'.x.com',path:'/',secure:true},
    ])
    const material=await resource.material();assert.equal(material.csrf,'fixture_csrf')
    const blocked=await fixturePage.evaluate(async()=>{
      try {await fetch('https://forbidden.invalid/');return false} catch{return true}
    })
    assert.equal(blocked,true)
    assert(requests.every(url=>url.startsWith('https://x.com/')))
  } finally {await resource.close()}
})

