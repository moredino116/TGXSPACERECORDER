// Minimal Chromium child environment v1. Browser-cache resolution stays in the parent Node process.
const KEYS=['HOME','PATH','LANG','LC_ALL','TZ','TMPDIR','XDG_CACHE_HOME','XDG_CONFIG_HOME','XDG_RUNTIME_DIR']
function browserEnvironment(env=process.env) {
  const result={}
  for(const key of KEYS) {
    const value=env[key]
    if(value===undefined)continue
    if(typeof value!=='string' || value.length>32768 || /[\x00\r\n]/.test(value))
      throw Error('Invalid browser process environment')
    result[key]=value
  }
  if(!result.PATH)result.PATH='/usr/bin:/bin'
  if(!result.LANG)result.LANG='C.UTF-8'
  return result
}
module.exports={browserEnvironment}

