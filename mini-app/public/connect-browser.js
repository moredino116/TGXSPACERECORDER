// Private browser connection UI v1. No credentials or login state are stored in browser storage.
;(async()=>{
  const params=new URLSearchParams(location.search)
  if(params.get('connect')!=='x' || params.has('manage')) return
  const main=document.querySelector('main');if(!main) return
  main.classList.add('manage-view','x-browser-view');main.replaceChildren()
  function node(tag,text,parent=main) {const n=document.createElement(tag);if(text!==undefined)n.textContent=text;parent.append(n);return n}
  function button(text,fn,parent=main,tone='neutral') {const b=node('button',text,parent);b.type='button';b.dataset.tone=tone;b.onclick=()=>{void fn().catch(()=>{operation.textContent='The operation was not confirmed. Refresh status before retrying.'})};return b}
  node('h1','Connect X')
  const state=node('p','Checking connection…');state.className='x-browser-state';state.setAttribute('role','status')
  const operation=node('p','');operation.className='x-browser-operation';operation.setAttribute('role','status')
  const requestStatus=node('p','');requestStatus.className='x-browser-request';requestStatus.setAttribute('role','status')
  const tg=window.Telegram?.WebApp;tg?.ready?.();tg?.expand?.()
  if(!tg?.initData){state.textContent='Open account setup from the bot in Telegram.';return}
  const validId=value=>typeof value==='string' && /^[A-Za-z0-9_-]{1,100}$/.test(value)
  const requestId=params.get('request')
  if(requestId!==null && !validId(requestId)){state.textContent='Invalid saved request link. Return to the bot.';return}
  const kind=params.get('return_kind'),returnId=params.get('return_id')
  if(['space','clip'].includes(kind)&&validId(returnId)) {
    const back=node('a','Back to selected item');back.href='?'+new URLSearchParams({manage:kind,id:returnId})
  }
  node('p','Public recording and playback do not require this connection. Connect only when account access is needed.')
  node('p','Sign-in runs in a temporary browser on your recorder. Its private image is shown here. After validation, the reusable session is encrypted on the recorder and the login browser closes.')
  const account=node('p','')
  const access=node('section');access.className='x-browser-access'
  const permission=node('label',undefined,access);permission.className='x-browser-consent'
  const consent=node('input',undefined,permission);consent.type='checkbox';consent.setAttribute('aria-label','Authorize X session reuse')
  permission.append(document.createTextNode(' I own or am authorized to use this X account, and authorize session reuse for recordings I request.'))
  let current=null,lease=null,closed=false,starting=false,requestBusy=false,blocked=false,connectionVerified=false,sequence=0,frameSeen=false,pollTimer=null
  let serial=Promise.resolve();const controllers=new Set(),resumed=new Set()
  function enqueue(fn){const next=serial.then(()=>closed?undefined:fn());serial=next.catch(()=>{});return next}
  async function call(method,path,body) {
    const c=new AbortController();controllers.add(c);const timer=setTimeout(()=>c.abort(),25000)
    try {
      const response=await fetch('/relay/'+path,{method,cache:'no-store',signal:c.signal,
        headers:{'content-type':'application/json','x-telegram-init-data':tg.initData},
        body:body===undefined?undefined:JSON.stringify(body)})
      const data=await response.json().catch(()=>null)
      if(!response.ok || data===null) {
        const e=new Error('Request not confirmed');e.code=typeof data?.code==='string'?data.code:'unconfirmed';throw e
      }
      return data
    } finally {clearTimeout(timer);controllers.delete(c)}
  }
  const post=(action,body={})=>call('POST','x-browser/'+lease.id+'/'+action,body)
  const usable=c=>c && c.status==='active' && !c.revoked_at && (!c.expires_at || Date.parse(c.expires_at)>Date.now())
  function showConnection(forceReconnect=false) {
    state.textContent=forceReconnect?'Reconnect required':!current?'Not connected':usable(current)?'Connected':'Reconnect required'
    account.textContent=current?.x_handle && /^[A-Za-z0-9_]{1,100}$/.test(current.x_handle)?'@'+current.x_handle:''
    connect.textContent=current?'Reconnect X':'Connect X'
    connect.disabled=!connectionVerified || starting || Boolean(lease) || !consent.checked
    disconnect.hidden=!current;disconnect.disabled=!connectionVerified || Boolean(lease)
  }
  const connect=button('Connect X',start,access,'primary')
  const refresh=button('Refresh connection status',()=>load(true),access)
  const disconnect=button('Disconnect X',disconnectCurrent,access,'danger');disconnect.hidden=true
  consent.onchange=()=>{connect.disabled=!connectionVerified || starting || Boolean(lease) || !consent.checked}
  const checkRequest=requestId?button('Check saved request status',()=>resumeCurrent(false),access):null
  const remote=node('section');remote.className='x-browser-panel';remote.hidden=true
  node('p','Private recorder-owned X browser: tap a field in the image, type into the box below, then Send text. Use Enter or Tab when needed. Sign-in is checked automatically.',remote)
  const image=node('img',undefined,remote);image.className='x-browser-screen';image.alt='Private X sign-in browser';image.draggable=false
  const typing=node('form',undefined,remote);typing.autocomplete='off'
  const textLabel=node('label','Text for selected X field',typing)
  const text=node('input',undefined,textLabel);text.type='password';text.autocomplete='off';text.spellcheck=false;text.maxLength=2048;text.setAttribute('autocapitalize','off')
  text.setAttribute('aria-label','Text for selected X field')
  const send=node('button','Send text',typing);send.type='submit';send.dataset.tone='primary'
  const keys=node('div',undefined,remote);keys.className='manage-controls'
  for(const key of ['Enter','Tab','Backspace']) button(key,()=>sendInput({type:'key',key}),keys)
  button('Scroll up',()=>sendInput({type:'scroll',dy:-390}),keys)
  button('Scroll down',()=>sendInput({type:'scroll',dy:390}),keys)
  button('Check sign-in',()=>enqueue(pollOnce),remote)
  button('Cancel connection',cancel,remote,'danger')
  node('p','Text is relayed to this recorder-owned browser. This page does not save it. Do not enter developer API credentials or session cookies.',remote)
  node('p','Connected means account validation and secure saving were confirmed. A recording job ID is not proof of downloaded or playable audio.')
  function clearRemote(){clearTimeout(pollTimer);text.value='';image.removeAttribute('src');remote.hidden=true;frameSeen=false}
  function setRemoteEnabled(value){for(const b of remote.querySelectorAll('button'))if(b.textContent!=='Cancel connection')b.disabled=!value;text.disabled=!value}
  function schedule(ms=1200){clearTimeout(pollTimer);if(lease&&!closed&&!blocked)pollTimer=setTimeout(()=>{void enqueue(pollOnce).catch(()=>{}).finally(()=>schedule())},ms)}
  function job(data) {
    if(!validId(data.jobId))throw Error('Unconfirmed job')
    requestStatus.textContent='Recording job confirmed: '+data.jobId+'. Check /process for capture progress. This screen does not verify downloaded or playable audio.'
  }
  async function resumeCurrent(allowStart=true) {
    if(!requestId || requestBusy || !usable(current))return
    requestBusy=true
    try {
      const data=await call('GET','space/requests/'+requestId)
      if(data.ok!==true || data.requestId!==requestId || !['waiting_connection','resolving','submitting','recording','completed'].includes(data.state))throw Error('Unverified request')
      if(data.state==='recording'){job(data);return}
      if(data.state==='submitting'){requestStatus.textContent='Recording start has an uncertain outcome. Do not send the Space again. Check /process; no additional start was submitted.';return}
      if(data.state==='resolving'){requestStatus.textContent='Saved request is resolving or needs recovery. No additional start was submitted.';return}
      if(data.state==='completed'){requestStatus.textContent='This saved request is already completed.';return}
      if(!allowStart || resumed.has(requestId)){requestStatus.textContent='Request is saved. No additional recording start was submitted.';return}
      resumed.add(requestId)
      const result=await call('POST','space/requests/'+requestId+'/resume',{connectionId:current.id})
      if(result.ok!==true || result.requestId!==requestId)throw Error('Unverified retry')
      job(result)
    } catch(error) {
      if(error.code==='reconnect_required') {
        resumed.delete(requestId)
        current={...current,status:'reauth_required'};showConnection(true)
        requestStatus.textContent='Reconnect X to retry this saved request. No recording job was confirmed.'
      } else requestStatus.textContent='Recording retry/status was not confirmed. Check /process and saved request status before retrying; do not send the Space again.'
    } finally {requestBusy=false}
  }
  async function load(autoResume=true) {
    if(lease || starting || closed)return
    refresh.disabled=true;connect.disabled=true
    try {
      const rows=await call('GET','x-connections')
      if(!Array.isArray(rows) || rows.some(row=>!row || !validId(row.id) || typeof row.status!=='string'))throw Error('Unverified list')
      if(rows.length>1){connectionVerified=false;current=null;state.textContent='Saved connection status needs attention';operation.textContent='Multiple saved X connections exist. No account was selected.';connect.disabled=true;disconnect.hidden=true;return}
      connectionVerified=true;current=rows[0]||null;showConnection()
      if(autoResume && usable(current))await resumeCurrent(true)
      else if(requestId)requestStatus.textContent='The original recording request remains saved.'
    } catch {connectionVerified=false;state.textContent='Connection status unavailable';operation.textContent='No browser or recording was started. Refresh connection status.';connect.disabled=true}
    finally {refresh.disabled=false}
  }
  async function connected(result,allowResume=true) {
    const c=result.connection
    if(result.phase!=='connected' || !validId(c?.id) || c.status!=='active' ||
        (result.requestId??null)!==requestId)throw Error('Unconfirmed saved connection')
    lease=null;blocked=false;clearRemote();connectionVerified=true;current={id:c.id,status:'active',x_handle:c.x_handle||null};showConnection()
    operation.textContent='Reusable session saved securely. The temporary login browser is closed.'
    if(allowResume)await resumeCurrent(true)
  }
  async function pollOnce() {
    if(!lease || blocked || closed)return
    try {
      let result=await post('status')
      if(result.ok!==true || result.id!==lease.id)throw Error('Unverified browser status')
      if(result.phase==='save_uncertain')result=await post('reconcile')
      if(result.phase==='connected'){await connected(result);return}
      if(['opening','checking','saving'].includes(result.phase)){operation.textContent='Opening or validating the private connection…';return}
      if(result.phase!=='ready')throw Error('Connection unavailable')
      if(Number.isSafeInteger(result.lastSequence)&&result.lastSequence>=sequence)sequence=result.lastSequence
      const frame=await post('frame')
      if(frame.id!==lease.id || frame.width!==390 || frame.height!==780 || frame.mime!=='image/jpeg' ||
         typeof frame.imageBase64!=='string' || !frame.imageBase64.length || frame.imageBase64.length>2796204 ||
         !/^[A-Za-z0-9+/]+={0,2}$/.test(frame.imageBase64))throw Error('Unverified image')
      image.src='data:image/jpeg;base64,'+frame.imageBase64;frameSeen=true;setRemoteEnabled(true)
      operation.textContent='Sign in using the private X browser below. Saving is checked automatically.'
      result=await post('finish')
      if(result.phase==='connected')await connected(result)
      else if(result.phase==='save_uncertain')operation.textContent='Secure save needs confirmation. Checking its receipt; do not submit another login.'
    } catch(error) {
      if(error.code==='connection_busy')return
      if(error.code==='save_reconciliation_required'){operation.textContent='Secure saving has an uncertain outcome. Checking its receipt; no recording retry was submitted.';return}
      if(['connection_expired','connection_unavailable','verification_not_confirmed','verification_unavailable','connection_not_ready'].includes(error.code)) {
        lease=null;clearRemote();showConnection(Boolean(current));operation.textContent='The connection was not confirmed. Refresh saved connection status before reconnecting.';return
      }
      operation.textContent='Private connection status could not be confirmed. Check sign-in again or cancel; do not assume it succeeded.'
    }
  }
  async function start() {
    if(starting || lease || !consent.checked || closed)return
    starting=true;connect.disabled=true;operation.textContent='Opening your private connection browser…'
    try {
      const result=await call('POST','x-browser/start',{consent:true,requestId})
      if(result.ok!==true || !/^b[a-f0-9]{48}$/.test(result.id||'') || (result.requestId??null)!==requestId)throw Error('Unconfirmed start')
      lease={id:result.id};sequence=Number.isSafeInteger(result.lastSequence)?result.lastSequence:0
      blocked=false;remote.hidden=false;setRemoteEnabled(false)
      await enqueue(pollOnce);schedule()
    } catch {operation.textContent='Connection start was not confirmed. No recording was submitted. Connect X again checks the same pending browser attempt.'}
    finally {starting=false;showConnection()}
  }
  async function sendInput(action) {
    if(!lease || blocked || !frameSeen || closed)return
    return enqueue(async()=>{
      if(!lease || blocked)return
      const next=sequence+1;let acknowledged=false
      for(let attempt=0;attempt<2;attempt++) {
        try {const result=await post('input',{sequence:next,action});if(result.ok!==true || result.sequence!==next)throw Error('Unverified input');acknowledged=true;break}
        catch(error){if(attempt===0 && !['owner_required','connection_unavailable','connection_expired','browser_input_unconfirmed'].includes(error.code))continue;break}
      }
      if(!acknowledged){blocked=true;setRemoteEnabled(false);operation.textContent='Input delivery is uncertain. Cancel this connection before entering more text.';return}
      sequence=next;schedule(100)
    })
  }
  image.onpointerup=event=>{
    if(!frameSeen || blocked)return
    const box=image.getBoundingClientRect()
    if(!box.width || !box.height)return
    const x=Math.max(0,Math.min(389,Math.floor((event.clientX-box.left)*390/box.width)))
    const y=Math.max(0,Math.min(779,Math.floor((event.clientY-box.top)*780/box.height)))
    void sendInput({type:'click',x,y})
  }
  typing.onsubmit=event=>{event.preventDefault();const value=text.value;text.value='';if(value)void sendInput({type:'text',text:value})}
  async function cancel() {
    text.value='';clearTimeout(pollTimer)
    return enqueue(async()=>{
      if(!lease)return
      try {
        const result=await post('cancel')
        if(result.phase==='connected'){await connected(result,false);operation.textContent='The session had already been saved. Cancellation submitted no additional recording start.';return}
        if(result.phase!=='cancelled')throw Error('Unconfirmed cancellation')
        lease=null;blocked=false;clearRemote();showConnection();operation.textContent='Temporary connection closed. No new session was saved.'
      } catch(error) {
        if(['connection_expired','connection_unavailable'].includes(error.code)){lease=null;blocked=false;clearRemote();showConnection()}
        operation.textContent='Cancellation or connection state was not confirmed. Refresh saved connection status before reconnecting.'
      }
    })
  }
  async function disconnectCurrent() {
    if(!current || lease)return
    disconnect.disabled=true
    try {const data=await call('DELETE','x-connections/'+current.id);if(data.ok!==true)throw Error('Unconfirmed disconnect');current=null;resumed.clear();showConnection();operation.textContent='Saved X session removed. Public recording remains available.'}
    catch {operation.textContent='Disconnect was not confirmed. Refresh connection status.'}
    finally {disconnect.disabled=false}
  }
  window.addEventListener('pagehide',()=>{closed=true;clearTimeout(pollTimer);text.value='';image.removeAttribute('src');for(const c of controllers)c.abort()})
  await load(true)
})().catch(()=>{const node=document.querySelector('.x-browser-operation');if(node)node.textContent='The private connection interface could not initialize. Return to the bot.'})

