const test=require('node:test')
const assert=require('node:assert/strict')
const {allowed}=require('../lib/verify')
const id='b'+'a'.repeat(48)
test('browser relay permits only exact POST start and owner-bound action paths',()=>{
  assert(allowed('POST','x-browser/start'))
  for(const action of ['status','frame','input','finish','cancel','reconcile']) assert(allowed('POST','x-browser/'+id+'/'+action))
})
test('browser relay rejects GET frames, wildcard actions, traversal and arbitrary URLs',()=>{
  for(const [method,path] of [['GET','x-browser/start'],['GET','x-browser/'+id+'/frame'],
      ['POST','x-browser/'+id+'/evaluate'],['POST','x-browser/'+id+'/goto'],
      ['POST','x-browser/'+id+'/frame/extra'],['POST','x-browser/../frame'],
      ['POST','x-browser/not-a-lease/frame'],['POST','x-browser//start']]) assert.equal(allowed(method,path),false)
})
