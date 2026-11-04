// Destination-scoped media transport v1. No cookie jar, configuration reads, or logs.
const ACCOUNT_HOSTS=new Set(['x.com','www.x.com','api.x.com','twitter.com','www.twitter.com','api.twitter.com'])
const PUBLIC_HEADERS=new Set(['user-agent','accept','accept-language','range','if-range','if-none-match','if-modified-since','cache-control'])
const ACCOUNT_HEADERS=new Set(['cookie','authorization','x-csrf-token','x-twitter-auth-type','x-twitter-active-user','x-guest-token'])
const REDIRECTS=new Set([301,302,303,307,308])
function safeError(error) {
  const timeout=error?.name==='AbortError' || error?.name==='TimeoutError'
  const result=new Error(timeout?'Audio request timed out.':'Audio request could not be completed.')
  if(timeout)result.name=error.name
  return result
}
function parsedUrl(value) {
  const url=new URL(value)
  if(!['http:','https:'].includes(url.protocol) || url.username || url.password)throw Error('Unsupported media URL')
  return url
}
function requestHeaders(url,extra,userAgent,credentialsAllowed) {
  const headers={'user-agent':userAgent,referer:'https://x.com/'}
  const trusted=credentialsAllowed && url.protocol==='https:' && (!url.port || url.port==='443') && ACCOUNT_HOSTS.has(url.hostname)
  for(const [raw,value] of Object.entries(extra||{})) {
    const name=raw.toLowerCase()
    if(!PUBLIC_HEADERS.has(name) && !(trusted && ACCOUNT_HEADERS.has(name)))continue
    if(typeof value!=='string' || /[\x00\r\n]/.test(value) || value.length>16384)throw Error('Invalid media header')
    headers[name]=value
  }
  return headers
}
async function fetchMedia(url,ms=20000,extra={}, {fetchImpl=globalThis.fetch,userAgent='Mozilla/5.0'}={}) {
  try {
    if(typeof fetchImpl!=='function' || !Number.isInteger(ms) || ms<1 || ms>60000 ||
        typeof userAgent!=='string' || /[\x00\r\n]/.test(userAgent))throw Error('Invalid media request')
    let current=parsedUrl(url),credentialsAllowed=true
    const signal=AbortSignal.timeout(ms)
    for(let hop=0;hop<=8;hop++) {
      signal.throwIfAborted()
      const response=await fetchImpl(current.href,{
        method:'GET',headers:requestHeaders(current,extra,userAgent,credentialsAllowed),redirect:'manual',signal,
      })
      if(!REDIRECTS.has(response.status))return response
      const location=response.headers.get('location')
      try {await response.body?.cancel()} catch {}
      if(!location || hop===8)throw Error('Unconfirmed media redirect')
      const next=parsedUrl(new URL(location,current).href)
      if(next.origin!==current.origin)credentialsAllowed=false
      current=next
    }
    throw Error('Media redirect limit')
  } catch(error) {throw safeError(error)}
}
module.exports={fetchMedia}
