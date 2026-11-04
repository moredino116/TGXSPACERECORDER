// Recorder-owned, temporary login browser. No profile/session files are exported.
const {validateInput}=require('./x-browser-connector')
const TOP=new Set(['x.com','www.x.com','twitter.com','www.twitter.com'])
function allowedRequest(raw,navigation=false) {
  try {
    const u=new URL(raw)
    if(u.protocol!=='https:' || u.username || u.password || (u.port && u.port!=='443')) return false
    if(navigation) return TOP.has(u.hostname)
    return ['x.com','twitter.com','twimg.com'].some(h=>u.hostname===h || u.hostname.endsWith('.'+h))
  } catch {return false}
}
function sessionMaterial(cookies) {
  if(!Array.isArray(cookies)) return null
  const relevant=cookies.filter(c=>c && ['x.com','.x.com'].includes(c.domain) && c.secure===true)
  function value(name) {
    const found=relevant.filter(c=>c.name===name)
    if(found.length!==1 || typeof found[0].value!=='string' || !found[0].value ||
        found[0].value.length>4096 || /[\x00-\x20\x7f;,]/.test(found[0].value)) return null
    return found[0].value
  }
  const auth=value('auth_token'),csrf=value('ct0')
  return auth && csrf ? {cookie:'auth_token='+auth+'; ct0='+csrf,csrf} : null
}
function createPlaywrightSessionDriver({chromium}) {
  if(!chromium || typeof chromium.launch!=='function') throw Error('Chromium is required')
  return async function open() {
    let browser,context,page
    try {
      browser=await chromium.launch({headless:true,timeout:20000,env:require('./x-browser-environment').browserEnvironment()})
      context=await browser.newContext({viewport:{width:390,height:780},acceptDownloads:false,serviceWorkers:'block',permissions:[]})
      context.setDefaultTimeout(8000)
      if(typeof context.routeWebSocket!=='function') throw Error('WebSocket policy unavailable')
      await context.routeWebSocket('**/*',socket=>socket.close())
      context.on('page',other=>{if(page && other!==page) void other.close().catch(()=>{})})
      await context.route('**/*',async route=>{
        const req=route.request()
        if(allowedRequest(req.url(),req.isNavigationRequest())) return route.fallback()
        return route.abort('blockedbyclient')
      })
      page=await context.newPage()
      page.on('dialog',dialog=>{void dialog.dismiss().catch(()=>{})})
      page.on('download',download=>{void download.cancel().catch(()=>{})})
      await page.goto('https://x.com/i/flow/login',{waitUntil:'domcontentloaded',timeout:20000})
      return {
        async capture(){return page.screenshot({type:'jpeg',quality:65,animations:'disabled',timeout:8000})},
        async input(action){
          action=validateInput(action)
          if(action.type==='click') return page.mouse.click(action.x,action.y)
          if(action.type==='text') return page.keyboard.insertText(action.text)
          if(action.type==='key') return page.keyboard.press(action.key)
          if(action.type==='scroll') return page.mouse.wheel(0,action.dy)
          throw Error('Invalid input')
        },
        async material(){return sessionMaterial(await context.cookies('https://x.com/'))},
        async close(){
          await context.close().catch(()=>{})
          try {await browser.close()} catch(error){if(browser.isConnected()) throw error}
        },
      }
    } catch {
      if(browser) await browser.close().catch(()=>{})
      throw Error('Login browser unavailable')
    }
  }
}
module.exports={createPlaywrightSessionDriver,allowedRequest,sessionMaterial}
