const test=require("node:test"),assert=require("node:assert"),crypto=require("crypto")
const {verifyInitData,allowed}=require("../lib/verify")
const TOK="123:ABC",now=1700000000000
function sign(user,authDate){const p=new URLSearchParams({auth_date:String(authDate),user:JSON.stringify(user)})
const s=[...p.entries()].map(([k,v])=>`${k}=${v}`).sort().join("\n");const k=crypto.createHmac("sha256","WebAppData").update(TOK).digest()
p.set("hash",crypto.createHmac("sha256",k).update(s).digest("hex"));return p.toString()}
test("accepts valid allowed user",()=>assert.equal(verifyInitData(sign({id:42},now/1000),TOK,"42",3600,now).id,42))
test("rejects other user",()=>assert.equal(verifyInitData(sign({id:7},now/1000),TOK,"42",3600,now),null))
test("rejects tampered",()=>assert.equal(verifyInitData(sign({id:42},now/1000).replace("42","43"),TOK,"42",3600,now),null))
test("rejects expired",()=>assert.equal(verifyInitData(sign({id:42},now/1000-9999),TOK,"42",3600,now),null))
test("rejects empty allowlist",()=>assert.equal(verifyInitData(sign({id:42},now/1000),TOK,"",3600,now),null))
test("allowlist",()=>{assert(allowed("POST","space/stop/abc"));assert(!allowed("GET","x-connections"));assert(!allowed("GET","space/../x"));assert(!allowed("DELETE","space/stop/a"))})

test("direct-item management permissions stay narrow", () => {
  assert(allowed("GET", "space/process"))
  assert(allowed("POST", "space/recordings/live_1/archive"))
  assert(allowed("POST", "retention/items/clip/clip_1/archive"))
  assert(!allowed("DELETE", "space/process"))
  assert(!allowed("GET", "space/recordings/live_1/archive"))
  assert(!allowed("POST", "retention/items/account/a/archive"))
  assert(!allowed("POST", "retention/items/clip/a/restore"))
  assert(!allowed("GET", "space/preview/live_1"))
  assert(!allowed("GET", "space/file/live_1"))
  assert(!allowed("POST", "space/recordings/a/archive/extra"))
  assert(!allowed("POST", "space/recordings/../archive"))
})


test("clip-status polling permissions stay narrow", () => {
  assert(allowed("GET", "space/recordings/rec_123/clips"))
  assert(allowed("GET", "space/recordings/a-b/clips"))
  assert(allowed("GET", "space/recordings/" + "a".repeat(100) + "/clips"))

  assert(!allowed("DELETE", "space/recordings/rec_123/clips"))
  assert(!allowed("PUT", "space/recordings/rec_123/clips"))
  assert(!allowed("GET", "space/recordings//clips"))
  assert(!allowed("GET", "space/recordings/../clips"))
  assert(!allowed("GET", "space/recordings/" + "a".repeat(101) + "/clips"))
  assert(!allowed("GET", "space/recordings/rec_123/clips/extra"))
  assert(!allowed("GET", "space/recordings/rec_123/clips?extra=1"))
  assert(!allowed("GET", "space/recordings/rec_123/file"))
})
