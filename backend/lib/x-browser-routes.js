// Private connection API v1. No storage/browser initialization before owner verification.
const ACTIONS=['status','frame','input','finish','cancel','reconcile']
const CODES=new Set(['owner_required','invalid_request','invalid_input','invalid_sequence','connection_unavailable',
  'connection_expired','connection_busy','connection_not_ready','browser_capacity_busy','browser_unavailable',
  'browser_frame_unavailable','browser_input_unconfirmed','input_sequence_conflict','verification_unavailable',
  'verification_not_confirmed','save_reconciliation_required','browser_close_unconfirmed','connection_not_confirmed'])
function attachXBrowserRoutes(router,{resolveOwner,getService}={}) {
  const resolve=resolveOwner || (req=>require('./x-connection-owner').resolveXConnectionOwner(req))
  let cached
  const service=getService || (()=>cached || (cached=require('./x-browser-service').createXBrowserService()))
  function handler(action) {return async(req,res)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('Pragma','no-cache')
    res.setHeader('X-Content-Type-Options','nosniff')
    if(req.method!=='POST') {res.setHeader('Allow','POST');return res.status(405).json({ok:false,code:'method_not_allowed'})}
    const owner=resolve(req)
    if(!owner || typeof owner.user!=='string' || !/^[1-9][0-9]{0,19}$/.test(owner.user) || owner.workspace!=='telegram:'+owner.user)
      return res.status(403).json({ok:false,code:'owner_required'})
    const body=req.body===undefined?{}:req.body
    const keys=action==='start'?['requestId','consent']:action==='input'?['sequence','action']:[]
    if(!body || typeof body!=='object' || Array.isArray(body) || Object.keys(body).some(key=>!keys.includes(key)))
      return res.status(400).json({ok:false,code:'invalid_request'})
    if(action==='start' && (body.consent!==true || (body.requestId!==undefined && body.requestId!==null &&
        (typeof body.requestId!=='string' || !/^[A-Za-z0-9_-]{1,100}$/.test(body.requestId)))))
      return res.status(400).json({ok:false,code:'invalid_request'})
    const id=req.params?.id
    if(action!=='start' && (typeof id!=='string' || !/^b[a-f0-9]{48}$/.test(id)))
      return res.status(400).json({ok:false,code:'invalid_request'})
    try {
      const s=service()
      let result
      if(action==='start') result=await s.connector.start(owner.user,body.requestId??null)
      else if(action==='input') result=await s.connector.input(owner.user,id,body.sequence,body.action)
      else result=await s.connector[action](owner.user,id)
      if(result?.phase==='connected') {
        const receipt=await s.lookupSaved({ownerId:owner.user,attemptId:result.id})
        if(receipt?.state!=='saved' || receipt.ownerId!==owner.user || receipt.attemptId!==result.id ||
           receipt.connection?.id!==result.connection?.id)
          return res.status(409).json({ok:false,code:'connection_unavailable'})
        result={id:result.id,phase:'connected',expiresAt:result.expiresAt,requestId:result.requestId,
          connection:{id:receipt.connection.id,x_handle:receipt.connection.x_handle||null,status:'active'}}
      }
      return res.json({...result,ok:true})
    } catch(error) {
      const known=CODES.has(error?.code)
      const status=known && [400,403,404,409,410,503].includes(error.status)?error.status:503
      return res.status(status).json({ok:false,code:known?error.code:'connection_not_confirmed'})
    }
  }}
  router.post('/start',handler('start'))
  for(const action of ACTIONS) router.post('/:id/'+action,handler(action))
}
module.exports={attachXBrowserRoutes}

