#!/usr/bin/env node
const { webcrypto } = require("crypto");
const path = require("path");
globalThis.crypto = webcrypto;
globalThis.btoa = (s) => Buffer.from(s, "binary").toString("base64");
globalThis.atob = (s) => Buffer.from(s, "base64").toString("binary");
require(path.join(__dirname, "..", "crypto.js"));
const C = globalThis.VCCrypto;
const BASE = process.env.VIBECHIC_WORKER_BASE || "https://vibechic-admin.tusinh-information.workers.dev";
const teamPw = process.env.VIBECHIC_TEAM_PASSWORD;
if (!teamPw) { console.error("missing VIBECHIC_TEAM_PASSWORD"); process.exit(2); }
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function log(o) { console.log(JSON.stringify(o)); }
function metaHeaders(obj) {
  const json = JSON.stringify(obj);
  return { "X-VC-Item-Meta": Buffer.from(json, "utf8").toString("base64"), "X-VC-Item-Meta-Enc": "b64" };
}
async function main() {
  const teamToken = await C.deriveTeamWriteToken(teamPw);
  assert(teamToken.length === 64, "token");
  const metaRes = await fetch(BASE + "/public/crypto-meta.json?_=" + Date.now(), { cache: "no-store" });
  assert(metaRes.ok, "crypto-meta " + metaRes.status);
  const meta = await metaRes.json();
  const teamKey = await C.deriveKey(teamPw, meta.salt, meta.iterations || C.KDF_ITERATIONS);
  assert(await C.checkVerifier(teamKey, meta), "verifier");
  const keyA = C.generateDeviceKeyBytes();
  const keyB = C.generateDeviceKeyBytes();
  const idA = await C.deviceIdFromKeyBytes(keyA);
  const idB = await C.deviceIdFromKeyBytes(keyB);
  log({ step: "devices", a: idA.slice(0, 8), b: idB.slice(0, 8) });
  { const r = await fetch(BASE + "/team/products"); log({ step: "list_no_token", status: r.status }); assert(r.status===401||r.status===403,"auth"); }
  const run = Date.now().toString(36);
  const productId = "prod-e2e-" + run;
  const imageId = "timg-" + run;
  const plainFull = new Uint8Array(1200); plainFull[0]=0xff; plainFull[1]=0xd8; plainFull[2]=0xff; plainFull[plainFull.length-2]=0xff; plainFull[plainFull.length-1]=0xd9;
  for (let i=3;i<plainFull.length-2;i++) plainFull[i]=(i*17)&0xff;
  const plainThumb = plainFull.slice(0, 200);
  const envFull = await C.encryptBytes(teamKey, plainFull);
  const envThumb = await C.encryptBytes(teamKey, plainThumb);
  { const r = await fetch(BASE + "/team/images/" + imageId, { method:"PUT", headers:{ Authorization:"Bearer "+idA, "Content-Type":"application/json", "X-VC-Team-Token":teamToken }, body: JSON.stringify(envFull) }); const j=await r.json().catch(()=>({})); log({step:"put_image",status:r.status,ok:j.ok}); assert(r.status===200&&j.ok,"put image"); }
  { const r = await fetch(BASE + "/team/thumbs/" + imageId, { method:"PUT", headers:{ Authorization:"Bearer "+idA, "Content-Type":"application/json", "X-VC-Team-Token":teamToken }, body: JSON.stringify(envThumb) }); const j=await r.json().catch(()=>({})); log({step:"put_thumb",status:r.status,ok:j.ok}); assert(r.status===200&&j.ok,"put thumb"); }
  const product = { id: productId, title: "E2E "+run, category:"Test", variants:[{id:"v1",label:"A",html:"<p>hi</p>"}], images:[{id:imageId,hasFull:true,hasThumb:true,teamImage:true}], teamProduct:true };
  const payload = { v:1, product, authorDeviceId:idA, authorName:"E2E-A", lastEditorName:"E2E-A", updatedAt:new Date().toISOString() };
  const enc = await C.encryptText(teamKey, JSON.stringify(payload));
  let remoteUpdatedAt = null;
  { const r = await fetch(BASE + "/team/products/" + productId, { method:"PUT", headers:{ Authorization:"Bearer "+idA, "Content-Type":"application/json", "X-VC-Team-Token":teamToken, ...metaHeaders({ authorName:"E2E-A", lastEditorName:"E2E-A", imageIds:[imageId], thumbIds:[imageId], titleHint:product.title }) }, body: JSON.stringify(enc) }); const j=await r.json().catch(()=>({})); log({step:"put_product",status:r.status,ok:j.ok}); assert(r.status===200&&j.ok,"put product"); remoteUpdatedAt=j.meta.updatedAt; }
  { const r = await fetch(BASE + "/team/products", { headers:{ "X-VC-Team-Token":teamToken, Authorization:"Bearer "+idB } }); const j=await r.json(); const hit=(j.items||[]).find(x=>x.id===productId); log({step:"list_all",status:r.status,hit:!!hit,n:(j.items||[]).length}); assert(hit&&Array.isArray(hit.thumbIds),"listed"); }
  { const r = await fetch(BASE + "/team/products?since=" + encodeURIComponent(remoteUpdatedAt), { headers:{ "X-VC-Team-Token":teamToken, Authorization:"Bearer "+idB } }); const j=await r.json(); const hit=(j.items||[]).find(x=>x.id===productId); log({step:"list_since_eq",hit:!!hit}); assert(!hit,"since"); }
  { const r = await fetch(BASE + "/team/products/" + productId, { headers:{ "X-VC-Team-Token":teamToken, Authorization:"Bearer "+idB } }); assert(r.status===200,"get"); const parsed=JSON.parse(await C.decryptText(teamKey, await r.json())); assert(parsed.product.id===productId,"decrypt"); log({step:"get_decrypt_B",ok:true}); }
  product.title = "Edited by B "+run; payload.product=product; payload.lastEditorName="E2E-B";
  { const enc2=await C.encryptText(teamKey, JSON.stringify(payload)); const r=await fetch(BASE + "/team/products/" + productId, { method:"PUT", headers:{ Authorization:"Bearer "+idB, "Content-Type":"application/json", "X-VC-Team-Token":teamToken, "X-VC-If-Updated-At":remoteUpdatedAt, ...metaHeaders({ lastEditorName:"E2E-B", imageIds:[imageId], thumbIds:[imageId], titleHint:product.title }) }, body:JSON.stringify(enc2) }); const j=await r.json().catch(()=>({})); log({step:"put_edit_B",status:r.status,ok:j.ok}); assert(r.status===200&&j.ok,"B edit"); remoteUpdatedAt=j.meta.updatedAt; }
  { const enc3=await C.encryptText(teamKey, JSON.stringify(payload)); const r=await fetch(BASE + "/team/products/" + productId, { method:"PUT", headers:{ Authorization:"Bearer "+idA, "Content-Type":"application/json", "X-VC-Team-Token":teamToken, "X-VC-If-Updated-At":"1999-01-01T00:00:00.000Z", ...metaHeaders({ lastEditorName:"E2E-A", imageIds:[imageId], thumbIds:[imageId], titleHint:"x" }) }, body:JSON.stringify(enc3) }); log({step:"put_conflict",status:r.status}); assert(r.status===409,"conflict"); }
  { const r=await fetch(BASE + "/team/thumbs/" + imageId, { headers:{ "X-VC-Team-Token":teamToken, Authorization:"Bearer "+idB } }); const bytes=await C.decryptBytes(teamKey, await r.json()); log({step:"thumb_decrypt",n:bytes.length}); assert(bytes.length===plainThumb.length,"thumb len"); }
  const N=Number(process.env.SCALE_N||100); const t0=Date.now(); const scaleIds=[];
  for (let i=0;i<N;i++){ const pid="scale-"+run+"-"+String(i).padStart(3,"0"); scaleIds.push(pid); const p={id:pid,title:"Scale "+i,category:"Scale",variants:[{id:"v1",label:"A",html:"<p>s"+i+"</p>"}],images:[],teamProduct:true}; const pl={v:1,product:p,authorDeviceId:idA,authorName:"Scale",lastEditorName:"Scale",updatedAt:new Date().toISOString()}; const e=await C.encryptText(teamKey, JSON.stringify(pl)); const r=await fetch(BASE + "/team/products/" + pid, { method:"PUT", headers:{ Authorization:"Bearer "+idA, "Content-Type":"application/json", "X-VC-Team-Token":teamToken, ...metaHeaders({ lastEditorName:"Scale", imageIds:[], thumbIds:[], titleHint:p.title }) }, body:JSON.stringify(e) }); if(!r.ok) throw new Error("scale put "+i+" "+r.status); if(i%50===49) log({step:"scale_progress",i:i+1,ms:Date.now()-t0}); }
  const pushMs=Date.now()-t0; log({step:"scale_push_done",n:N,ms:pushMs});
  const t1=Date.now(); const listRes=await fetch(BASE + "/team/products", { headers:{ "X-VC-Team-Token":teamToken, Authorization:"Bearer "+idB } }); const listJ=await listRes.json(); const listMs=Date.now()-t1;
  const scaleHits=(listJ.items||[]).filter(x=>String(x.id).startsWith("scale-"+run)); log({step:"scale_list",total:(listJ.items||[]).length,scale:scaleHits.length,ms:listMs}); assert(scaleHits.length===N,"scale count");
  const mid=scaleHits.map(x=>x.updatedAt).sort()[Math.floor(N/2)];
  const incRes=await fetch(BASE + "/team/products?since=" + encodeURIComponent(mid), { headers:{ "X-VC-Team-Token":teamToken, Authorization:"Bearer "+idB } });
  const incHits=((await incRes.json()).items||[]).filter(x=>String(x.id).startsWith("scale-"+run)); log({step:"scale_incremental",n:incHits.length}); assert(incHits.length<N&&incHits.length>0,"incremental");
  { const r=await fetch(BASE + "/team/products/" + productId, { method:"DELETE", headers:{ Authorization:"Bearer "+idA, "X-VC-Team-Token":teamToken } }); log({step:"delete_product",status:r.status}); assert(r.status===200,"delete"); }
  let deleted=0; for (const pid of scaleIds){ const r=await fetch(BASE + "/team/products/" + pid, { method:"DELETE", headers:{ Authorization:"Bearer "+idA, "X-VC-Team-Token":teamToken } }); if(r.ok) deleted++; }
  log({step:"scale_cleanup",deleted}); log({step:"PASS",pushMs,listMs,scale:N});
}
main().catch((e)=>{ console.error(JSON.stringify({step:"FAIL",error:String(e&&e.message||e)})); process.exit(1); });
