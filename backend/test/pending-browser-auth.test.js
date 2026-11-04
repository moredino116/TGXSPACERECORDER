const test=require('node:test'),assert=require('node:assert/strict')
const {createPendingRecordingRetry}=require('../lib/pending-recording-retry')
for(const [code,expected] of [
  ['x_authentication_rejected','reconnect_required'],['reconnect-required','reconnect_required'],
  ['x_access_denied','audio_not_resolved'],['space_stream_unavailable','audio_not_resolved'],['x_rate_limited','audio_not_resolved'],
]) test('saved request classifies '+code+' without creating a recording job',async()=>{
  let releases=0,starts=0
  const row={id:'fixture_request',state:'waiting_connection',space_id:'fixture_space'}
  const store={get:()=>row,claim:()=>({...row,claim_token:'fixture_claim'}),releaseResolution:()=>{releases++;return true}}
  const retry=createPendingRecordingRetry({store,getConnection:async()=>({id:'fixture_connection',workspace_id:'telegram:123',user_id:'123',status:'active'}),
    resolve:async()=>({status:code==='reconnect-required'?409:200,json:{ok:false,code}}),
    start:async()=>{starts++;throw Error('unexpected start')}})
  const result=await retry.resume({ownerId:'123',requestId:'fixture_request',connectionId:'fixture_connection'})
  assert.equal(result.json.code,expected);assert.equal(starts,0);assert.equal(releases,1)
})

const {createXBrowserConnector}=require('../lib/x-browser-connector')
function browserFixture(){let inputs=0;return{get inputs(){return inputs},connector:createXBrowserConnector({
  open:async()=>({input:async()=>{inputs++},close:async()=>{}}),verify:async()=>null,save:async()=>null,schedule:()=>null,unschedule(){}})}}
test('an input sequence cannot be reused with different typed text',async()=>{
  const f=browserFixture(),s=await f.connector.start('123')
  await f.connector.input('123',s.id,1,{type:'text',text:'fixture one'})
  await assert.rejects(()=>f.connector.input('123',s.id,1,{type:'text',text:'fixture two'}),e=>e.code==='input_sequence_conflict')
  assert.equal(f.inputs,1);await f.connector.cancel('123',s.id)
})
test('owner status exposes the acknowledged sequence but never typed text or its digest',async()=>{
  const f=browserFixture(),s=await f.connector.start('123')
  await f.connector.input('123',s.id,1,{type:'text',text:'fixture private text'})
  const status=await f.connector.status('123',s.id)
  assert.equal(status.lastSequence,1)
  assert(!JSON.stringify(status).includes('fixture private text'));assert(!Object.hasOwn(status,'lastInputDigest'))
  await f.connector.cancel('123',s.id)
})

