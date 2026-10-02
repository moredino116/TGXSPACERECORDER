const tg=window.Telegram&&Telegram.WebApp;tg&&(tg.ready(),tg.expand())
const $=s=>document.querySelector(s),msg=t=>$("#msg").textContent=t
async function call(m,p,b){const r=await fetch("/relay/"+p,{method:m,headers:{"content-type":"application/json","x-telegram-init-data":tg?tg.initData:""},body:b?JSON.stringify(b):undefined})
const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.error||"Request failed ("+r.status+")");return j}
async function load(){try{const j=await call("GET","space/archive");const a=Array.isArray(j)?j:(j.recordings||j.items||[])
const ul=$("#list");ul.textContent="";if(!a.length){ul.innerHTML="<li>No recordings yet. Paste a Space link above.</li>";return}
for(const r of a){const li=document.createElement("li");li.append(r.title||r.id);const b=document.createElement("button");b.className="d";b.textContent="Delete"
b.onclick=async()=>{if(!confirm("Delete this recording?"))return;try{await call("DELETE","space/archive/"+encodeURIComponent(r.id));load()}catch(e){msg(e.message)}};li.append(b);ul.append(li)}}catch(e){msg(e.message)}}
$("#f").onsubmit=async e=>{e.preventDefault();try{msg("Starting…");await call("POST","space/start",{url:$("#u").value});msg("Recording started.");load()}catch(x){msg(x.message)}}
load()
