// All runtime effects are lazy; importing this module does not open storage or a browser.
function createXBrowserService() {
  const {createBrowserConnectionStore}=require('./x-browser-store')
  const store=createBrowserConnectionStore({
    getDb:()=>require('./db').getDb(),
    encryptSecret:value=>require('./secretbox').encryptSecret(value),
  })
  const {createXBrowserConnector}=require('./x-browser-connector')
  const connector=createXBrowserConnector({
    open:async()=>{
      const fs=require('node:fs')
      const match=/^MemAvailable:\s+(\d+)/m.exec(fs.readFileSync('/proc/meminfo','utf8'))
      if(!match || Number(match[1])<1048576) throw Error('Browser resources unavailable')
      const modulePath=process.env.X_BROWSER_PLAYWRIGHT_MODULE || '/home/ubuntu/recorder-browser-tools/node_modules/playwright'
      const {chromium}=require(modulePath)
      return require('./x-browser-driver').createPlaywrightSessionDriver({chromium})()
    },
    verify:(cookie,csrf)=>require('./xapi').verifySession(cookie,csrf),
    save:store.save,lookupSaved:store.lookupSaved,
  })
  return {connector,lookupSaved:store.lookupSaved}
}
module.exports={createXBrowserService}
