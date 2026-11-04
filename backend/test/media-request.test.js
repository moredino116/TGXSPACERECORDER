const test=require('node:test'),assert=require('node:assert/strict')
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm')
const {createRequire}=require('node:module')
const {fetchMedia}=require('../lib/media-request')
const secrets={Cookie:'auth_token=fixture_auth; ct0=fixture_csrf',Authorization:'Bearer fixture_only',
  'x-csrf-token':'fixture_csrf','x-twitter-auth-type':'OAuth2Session','x-guest-token':'fixture_guest',
  'x-relay-key':'fixture_internal','Proxy-Authorization':'fixture_proxy',Host:'untrusted.invalid',Origin:'https://untrusted.invalid'}
const sensitive=['cookie','authorization','x-csrf-token','x-twitter-auth-type','x-guest-token','x-relay-key','proxy-authorization','host','origin']
function clean(headers){for(const name of sensitive)assert.equal(headers[name],undefined,name+' must not be forwarded')}
function response(status=200,body='fixture audio',location){return new Response(body,{status,headers:location?{location}:{}})}
async function one(url,extra=secrets) {
  const calls=[]
  const result=await fetchMedia(url,20000,extra,{userAgent:'Fixture UA',fetchImpl:async(u,init)=>{calls.push({url:u,...init});return response()}})
  return{calls,result}
}
test('media guard: public CDN requests contain no account or internal credentials',async()=>{
  const {calls}=await one('https://video.pscp.tv/fixture.m3u8')
  clean(calls[0].headers);assert.equal(calls[0].headers['user-agent'],'Fixture UA');assert.equal(calls[0].headers.referer,'https://x.com/')
})
test('media guard: public requests retain useful range and accept headers',async()=>{
  const {calls}=await one('https://cdn.example/fixture.aac',{...secrets,Range:'bytes=0-99',Accept:'audio/*'})
  assert.equal(calls[0].headers.range,'bytes=0-99');assert.equal(calls[0].headers.accept,'audio/*');clean(calls[0].headers)
})
test('media guard: direct HTTPS X endpoints may receive their session headers',async()=>{
  for(const host of ['x.com','api.x.com','twitter.com','api.twitter.com']) {
    const {calls}=await one('https://'+host+'/fixture')
    assert.equal(calls[0].headers.cookie,secrets.Cookie);assert.equal(calls[0].headers['x-csrf-token'],'fixture_csrf')
    assert.equal(calls[0].headers['x-relay-key'],undefined);assert.equal(calls[0].headers['proxy-authorization'],undefined)
  }
})
test('media guard: deceptive hosts and nonstandard ports never receive session headers',async()=>{
  for(const url of ['https://x.com.evil.invalid/a','https://evilx.com/a','https://api.twitter.com:444/a','https://x.com./a'])clean((await one(url)).calls[0].headers)
})
test('media guard: HTTP public audio remains supported without account credentials',async()=>{
  const {calls}=await one('http://x.com/fixture.aac');clean(calls[0].headers)
})
test('media guard: cross-origin redirect strips credentials and never reintroduces them',async()=>{
  const urls=['https://x.com/start','https://video.pscp.tv/next','https://x.com/final'],calls=[]
  await fetchMedia(urls[0],20000,secrets,{fetchImpl:async(url,init)=>{calls.push(init);return calls.length<3?response(302,'',urls[calls.length]):response()}})
  assert.equal(calls[0].headers.cookie,secrets.Cookie);clean(calls[1].headers);clean(calls[2].headers)
  assert.equal(calls[0].signal,calls[2].signal)
})
test('media guard: HTTPS downgrade cannot carry account credentials',async()=>{
  const calls=[]
  await fetchMedia('https://x.com/start',20000,secrets,{fetchImpl:async(url,init)=>{calls.push(init);return calls.length===1?response(302,'','http://x.com/next'):response()}})
  clean(calls[1].headers)
})
test('media guard: same-origin relative redirect preserves authorized session access',async()=>{
  const calls=[]
  await fetchMedia('https://x.com/start',20000,secrets,{fetchImpl:async(url,init)=>{calls.push({url,...init});return calls.length===1?response(307,'','/next'):response()}})
  assert.equal(calls[1].url,'https://x.com/next');assert.equal(calls[1].headers.cookie,secrets.Cookie)
})
test('media guard: a public redirect to X does not introduce account credentials',async()=>{
  const calls=[]
  await fetchMedia('https://cdn.example/start',20000,secrets,{fetchImpl:async(url,init)=>{calls.push(init);return calls.length===1?response(302,'','https://x.com/next'):response()}})
  clean(calls[0].headers);clean(calls[1].headers)
})
test('media guard: redirect count is bounded',async()=>{
  let count=0
  await assert.rejects(()=>fetchMedia('https://x.com/start',20000,secrets,{fetchImpl:async()=>{count++;return response(302,'','/again')}}),e=>e.message==='Audio request could not be completed.')
  assert.equal(count,9)
})
test('media guard: embedded URL credentials and unsupported protocols fail before fetching',async()=>{
  let count=0
  for(const url of ['https://name:fixture_secret@x.com/','file:///etc/passwd','data:text/plain,fixture_secret'])
    await assert.rejects(()=>fetchMedia(url,20000,secrets,{fetchImpl:async()=>{count++;return response()}}),e=>!e.message.includes('fixture_secret'))
  assert.equal(count,0)
})
test('media guard: redirect response bodies are cancelled before following',async()=>{
  let cancelled=0,calls=0
  await fetchMedia('https://x.com/start',20000,secrets,{fetchImpl:async()=>{
    calls++;return calls===1?{status:302,headers:new Headers({location:'/next'}),body:{cancel:async()=>{cancelled++}}}:response()
  }})
  assert.equal(cancelled,1)
})
test('media guard: upstream request errors do not expose secret URLs or headers',async()=>{
  await assert.rejects(()=>fetchMedia('https://cdn.example/a?signature=fixture_secret',20000,secrets,{fetchImpl:async()=>{throw Error('fixture_secret '+secrets.Cookie)}}),e=>e.message==='Audio request could not be completed.'&&!e.cause)
})
test('media guard: timeout errors keep their safe timeout classification',async()=>{
  await assert.rejects(()=>fetchMedia('https://cdn.example/a',20000,{}, {fetchImpl:async()=>{const e=Error('private URL');e.name='TimeoutError';throw e}}),e=>e.name==='TimeoutError'&&e.message==='Audio request timed out.')
})
test('media guard: the original deadline also aborts response-body reading',async()=>{
  const keepAlive=setTimeout(()=>{},1000)
  try {
    const r=await fetchMedia('https://cdn.example/a',15,{}, {fetchImpl:async(url,init)=>({status:200,
      text:()=>new Promise((resolve,reject)=>{
        if(init.signal.aborted)return reject(init.signal.reason)
        init.signal.addEventListener('abort',()=>reject(init.signal.reason),{once:true})
      })})})
    await assert.rejects(()=>r.text(),e=>e.name==='TimeoutError')
  } finally {clearTimeout(keepAlive)}
})
function routeFunctions(fetchImpl) {
  const file=path.join(__dirname,'../routes/space.js'),source=fs.readFileSync(file,'utf8')
  const names=['fetchWithTimeout','fetchText','fetchBuf','resolveUrl','pickVariant','parseMedia','getMediaPlaylist']
  const code=names.map(name=>{
    const m=new RegExp('^(?:async\\s+)?function\\s+'+name+'\\s*\\(','m').exec(source)
    assert(m,'Missing function '+name);const end=source.indexOf('\n}\n',m.index);assert(end>=0)
    return source.slice(m.index,end+2)
  }).join('\n')
  return vm.runInNewContext(code+'\n;({fetchText,fetchBuf,getMediaPlaylist})',{
    require:createRequire(file),fetch:fetchImpl,UA:'Fixture UA',Buffer,URL,
    publicAudioFallbackLogged:false,console:{log(){}},
  },{filename:'actual-staged-media-functions.js'})
}
test('staged wrapper: playlist and variant requests apply the destination rule independently',async()=>{
  const calls=[]
  const api=routeFunctions(async(url,init)=>{calls.push({url,...init});return response(200,url.includes('/master')?
    '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=128000\nhttps://cdn.example/media.m3u8\n':
    '#EXTM3U\n#EXTINF:2,\nsegment.aac\n#EXT-X-ENDLIST\n')})
  const media=await api.getMediaPlaylist('https://x.com/master',secrets)
  assert.equal(calls[0].headers.cookie,secrets.Cookie);clean(calls[1].headers)
  assert.equal(media.segments[0],'https://cdn.example/segment.aac')
})
test('staged wrapper: audio HTTP 400 fallback still retries with public headers',async()=>{
  const calls=[]
  const api=routeFunctions(async(url,init)=>{calls.push(init);return response(calls.length===1?400:200,'fixture audio')})
  assert.equal((await api.fetchBuf('https://cdn.example/audio',secrets)).toString(),'fixture audio')
  assert.equal(calls.length,2);clean(calls[0].headers);clean(calls[1].headers)
  assert.equal(calls[1].headers['user-agent'],'Mozilla/5.0')
})
test('staged wrapper: failed media URLs are not copied into HTTP errors',async()=>{
  const api=routeFunctions(async()=>response(403,'private upstream body'))
  await assert.rejects(()=>api.fetchText('https://cdn.example/a?signature=fixture_secret',secrets),e=>e.message==='HTTP 403')
})
test('staged wrapper: invalid-playlist errors exclude upstream body contents',async()=>{
  const api=routeFunctions(async()=>response(200,'private upstream body fixture_secret'))
  await assert.rejects(()=>api.getMediaPlaylist('https://cdn.example/a',secrets),e=>e.message==='The audio URL did not return an HLS playlist.')
})
