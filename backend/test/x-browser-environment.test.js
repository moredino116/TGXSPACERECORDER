const test=require('node:test'),assert=require('node:assert/strict')
const {browserEnvironment}=require('../lib/x-browser-environment')
test('browser environment: allowlist omits backend credentials and Node launch settings',()=>{
  const value=browserEnvironment({HOME:'/fixture/home',PATH:'/usr/bin:/bin',LANG:'C.UTF-8',TMPDIR:'/fixture/tmp',
    RECORDER_RELAY_KEY:'fixture-secret',TELEGRAM_BOT_TOKEN:'fixture-secret',X_CONN_ENC_KEY:'fixture-secret',
    NODE_OPTIONS:'fixture-secret',AWS_SECRET_ACCESS_KEY:'fixture-secret',PLAYWRIGHT_BROWSERS_PATH:'/fixture/parent-only'})
  assert.deepEqual(value,{HOME:'/fixture/home',PATH:'/usr/bin:/bin',LANG:'C.UTF-8',TMPDIR:'/fixture/tmp'})
  assert(!JSON.stringify(value).includes('fixture-secret'))
})
test('browser environment: secret environment entries are not enumerated or accessed',()=>{
  const allowed=new Set(['HOME','PATH','LANG','LC_ALL','TZ','TMPDIR','XDG_CACHE_HOME','XDG_CONFIG_HOME','XDG_RUNTIME_DIR'])
  const env=new Proxy({}, {ownKeys(){throw Error('Environment enumeration forbidden')},get(target,key){
    assert(allowed.has(key),'Unexpected environment access');return undefined
  }})
  assert.deepEqual(browserEnvironment(env),{PATH:'/usr/bin:/bin',LANG:'C.UTF-8'})
})
test('browser environment: invalid operating-system values fail without disclosing them',()=>{
  assert.throws(()=>browserEnvironment({HOME:'fixture-secret\ninvalid'}),e=>e.message==='Invalid browser process environment')
})
test('actual staged driver explicitly supplies a minimal child environment before launch',async()=>{
  const {createPlaywrightSessionDriver}=require('../lib/x-browser-driver')
  let options
  const open=createPlaywrightSessionDriver({chromium:{launch:async value=>{options=value;throw Error('Fixture stops before any browser launch')}}})
  await assert.rejects(open,e=>e.message==='Login browser unavailable')
  assert(options && options.env)
  assert.equal(options.headless,true)
  for(const key of ['RECORDER_RELAY_KEY','TELEGRAM_BOT_TOKEN','X_CONN_ENC_KEY','NODE_OPTIONS','TEST_PLAYWRIGHT_MODULE'])
    assert.equal(options.env[key],undefined)
  assert.equal(typeof options.env.PATH,'string')
})

