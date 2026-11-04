// Temporary browser-session connector v1. Owner IDs must come from the relay guard.
const crypto = require('node:crypto')
const KEYS = new Set(['Enter','Tab','Backspace','Delete','Escape','ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End'])
function fault(code,status=409) {
  const error=new Error(code);error.code=code;error.status=status;return error
}
function validateInput(action) {
  if(!action || typeof action!=='object') throw fault('invalid_input',400)
  if(action.type==='click' && Number.isInteger(action.x) && Number.isInteger(action.y) &&
      action.x>=0 && action.x<390 && action.y>=0 && action.y<780)
    return {type:'click',x:action.x,y:action.y}
  if(action.type==='text' && typeof action.text==='string' && action.text.length>0 && action.text.length<=2048)
    return {type:'text',text:action.text}
  if(action.type==='key' && KEYS.has(action.key)) return {type:'key',key:action.key}
  if(action.type==='scroll' && Number.isInteger(action.dy) && Math.abs(action.dy)<=780)
    return {type:'scroll',dy:action.dy}
  throw fault('invalid_input',400)
}
function createXBrowserConnector({open,verify,save,lookupSaved=null,now=Date.now,ttlMs=600000,
    schedule=setTimeout,unschedule=clearTimeout}) {
  if(![open,verify,save].every(fn=>typeof fn==='function') ||
      !Number.isInteger(ttlMs) || ttlMs<10000 || ttlMs>900000) throw Error('Invalid connector configuration')
  let slot=null
  function owner(value) {
    if(typeof value!=='string' || !/^[1-9][0-9]{0,19}$/.test(value)) throw fault('owner_required',403)
    return value
  }
  function publicState(s) {
    const result={id:s.id,phase:s.phase,expiresAt:s.deadline,requestId:s.requestId,lastSequence:s.lastSequence}
    if(s.connection) result.connection={...s.connection}
    return result
  }
  async function close(s) {
    if(!s.driver || s.closed) return
    if(s.closing) return s.closing
    s.closing=(async()=>{
      try {await s.driver.close();s.closed=true;s.driver=null;s.lastInputDigest=null}
      catch {s.closeFailed=true;throw fault('browser_close_unconfirmed',503)}
      finally {s.closing=null}
    })()
    return s.closing
  }
  async function expire(s) {
    if(now()<s.deadline) return
    if(!['saving','connected','save_uncertain'].includes(s.phase)) s.phase='expired'
    await close(s)
  }
  async function get(who,id) {
    owner(who)
    const s=slot
    if(!s || s.owner!==who || s.id!==id) throw fault('connection_unavailable',404)
    await expire(s)
    if(s.phase==='expired') throw fault('connection_expired',410)
    return s
  }
  function ready(s) {
    if(s.busy) throw fault('connection_busy')
    if(s.phase!=='ready') throw fault('connection_not_ready')
  }
  async function start(who,requestId=null) {
    owner(who)
    if(requestId!==null && (typeof requestId!=='string' || !/^[A-Za-z0-9_-]{1,100}$/.test(requestId)))
      throw fault('invalid_request',400)
    if(slot) {
      await expire(slot)
      if(slot.phase==='save_uncertain') throw fault('save_reconciliation_required')
      if(slot.owner===who && slot.requestId===requestId && ['opening','ready','checking','saving'].includes(slot.phase))
        return publicState(slot)
      if(slot.busy || (slot.driver && !slot.closed) || !['expired','cancelled','failed','connected'].includes(slot.phase))
        throw fault('browser_capacity_busy')
      unschedule(slot.timer)
    }
    const s={id:'b'+crypto.randomBytes(24).toString('hex'),owner:who,requestId,
      deadline:now()+ttlMs,phase:'opening',busy:true,closed:false,lastSequence:0}
    slot=s
    s.timer=schedule(()=>{void expire(s).catch(()=>{})},ttlMs)
    s.timer?.unref?.()
    try {
      s.driver=await open()
      if(s.phase!=='opening' || now()>=s.deadline) {
        s.phase='expired';await close(s);throw fault('connection_expired',410)
      }
      s.phase='ready';return publicState(s)
    } catch(error) {
      if(s.phase!=='expired' && s.phase!=='cancelled') s.phase='failed'
      await close(s)
      if(error?.code==='connection_expired') throw error
      throw fault('browser_unavailable',503)
    } finally {s.busy=false}
  }
  async function status(who,id) {return publicState(await get(who,id))}
  async function frame(who,id) {
    const s=await get(who,id);ready(s);s.busy=true
    try {
      const image=await s.driver.capture()
      if(!Buffer.isBuffer(image) || !image.length || image.length>2097152) throw Error('Invalid frame')
      return {id:s.id,width:390,height:780,mime:'image/jpeg',imageBase64:image.toString('base64')}
    } catch {throw fault('browser_frame_unavailable',503)}
    finally {s.busy=false}
  }
  async function input(who,id,sequence,action) {
    const s=await get(who,id);ready(s)
    if(!Number.isSafeInteger(sequence) || sequence<1) throw fault('invalid_sequence',400)
    const command=validateInput(action)
    const digest=crypto.createHash('sha256').update(JSON.stringify(command)).digest('hex')
    if(sequence===s.lastSequence) {
      if(digest!==s.lastInputDigest) throw fault('input_sequence_conflict')
      return {ok:true,sequence}
    }
    if(sequence!==s.lastSequence+1) throw fault('input_sequence_conflict')
    s.busy=true
    try {await s.driver.input(command);s.lastSequence=sequence;s.lastInputDigest=digest;return {ok:true,sequence}}
    catch {s.phase='failed';await close(s);throw fault('browser_input_unconfirmed',503)}
    finally {s.busy=false}
  }
  async function finish(who,id) {
    const s=await get(who,id)
    if(s.phase==='connected') return publicState(s)
    if(s.phase==='save_uncertain') throw fault('save_reconciliation_required')
    ready(s);s.busy=true
    let material=null
    try {
      material=await s.driver.material()
      if(!material) return {...publicState(s),code:'sign_in_incomplete'}
      s.phase='checking'
      let identity
      try {identity=await verify(material.cookie,material.csrf)}
      catch {throw fault('verification_unavailable',503)}
      if(!identity?.ok || typeof identity.id!=='string' || !/^[1-9][0-9]{0,24}$/.test(identity.id) ||
          typeof identity.handle!=='string' || !/^[A-Za-z0-9_]{1,100}$/.test(identity.handle))
        throw fault('verification_not_confirmed',409)
      if(s.phase==='expired' || now()>=s.deadline) throw fault('connection_expired',410)
      s.verifiedHandle=identity.handle
      s.phase='saving'
      let connection
      try {
        connection=await save({ownerId:s.owner,requestId:s.requestId,attemptId:s.id,
          identity:{id:identity.id,handle:identity.handle,name:String(identity.name||identity.handle).slice(0,200),avatar:identity.avatar||null},
          material})
        if(!connection || typeof connection.id!=='string' || !/^[A-Za-z0-9_-]{1,100}$/.test(connection.id) || connection.status!=='active')
          throw Error('Unconfirmed save')
      } catch {s.phase='save_uncertain';throw fault('save_reconciliation_required')}
      s.connection={id:connection.id,x_handle:identity.handle,status:'active'}
      s.phase='connected'
      await close(s)
      return publicState(s)
    } catch(error) {
      if(!['save_uncertain','connected','expired'].includes(s.phase)) s.phase='failed'
      await close(s)
      if(['verification_unavailable','verification_not_confirmed','connection_expired','save_reconciliation_required','browser_close_unconfirmed'].includes(error?.code)) throw error
      throw fault('connection_not_confirmed',503)
    } finally {material=null;s.busy=false}
  }
  async function cancel(who,id) {
    const s=await get(who,id)
    if(s.busy || s.phase==='save_uncertain') throw fault('connection_busy')
    if(s.phase==='connected') return publicState(s)
    s.phase='cancelled';unschedule(s.timer);await close(s);return publicState(s)
  }
  async function reconcile(who,id) {
    const s=await get(who,id)
    if(s.phase!=='save_uncertain') return publicState(s)
    if(s.busy) throw fault('connection_busy')
    if(typeof lookupSaved!=='function') throw fault('save_reconciliation_required')
    s.busy=true
    try {
      const receipt=await lookupSaved({ownerId:s.owner,attemptId:s.id})
      if(!receipt || receipt.ownerId!==s.owner || receipt.attemptId!==s.id)
        throw Error('Unconfirmed receipt')
      if(['not_saved','saved_unavailable'].includes(receipt.state)) {s.phase='failed';return publicState(s)}
      const connection=receipt.connection
      if(receipt.state!=='saved' || !connection || connection.status!=='active' ||
          typeof connection.id!=='string' || !/^[A-Za-z0-9_-]{1,100}$/.test(connection.id))
        throw Error('Unconfirmed receipt')
      s.connection={id:connection.id,x_handle:s.verifiedHandle,status:'active'}
      s.phase='connected';await close(s);return publicState(s)
    } catch {throw fault('save_reconciliation_required')}
    finally {s.busy=false}
  }
  return {start,status,frame,input,finish,cancel,reconcile}
}
module.exports={createXBrowserConnector,validateInput}

