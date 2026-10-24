const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {DOMParser}=require('linkedom');
const c=require('../javdb-collector.user.js');
const DAY=86400000, now=DAY*10;
const doc=h=>new DOMParser().parseFromString(`<html><body>${h}</body></html>`,'text/html');
const announcement=domain=>`<nav class="sub-header"><div class="content">官方App: <a href="https://app.${domain}/">App</a>, 最新域名: <a href="https://${domain}/">${domain}</a>, 永久域名: <a href="https://javdb.com/">javdb.com</a>, App永久域名: <a href="https://jav.app/">jav.app</a></div></nav>`;
function memory(initial={}){const data=new Map(Object.entries(initial));return {data,get:async(k,d=null)=>data.has(k)?structuredClone(data.get(k)):d,set:async(k,v)=>data.set(k,structuredClone(v))};}
test('metadata and runtime cover future numeric mirrors without matching impostors or app installers',()=>{
 const raw=fs.readFileSync(require.resolve('../javdb-collector.user.js'),'utf8');
 const pattern=raw.match(/^\/\/ @include\s+(\/.*\/)$/m)?.[1];assert.ok(pattern,'needs a future-compatible include');
 const expression=new RegExp(pattern.slice(1,-1));
 for(const url of ['https://javdb.com/lists/GJ5a7','https://javdb580.com/actors/65v5Q','https://www.javdb99999.com/tags?c1=64']){assert.equal(expression.test(url),true);assert.equal(c.isJavdbSite(url),true);}
 for(const url of ['https://javdb580.com.evil.test/','https://fakejavdb580.com/','https://evil.test/?https://javdb580.com/','https://app.javdb580.com/','https://jav.app/','http://javdb580.com/','https://user@javdb580.com/'])assert.equal(c.isJavdbSite(url),false);
});
test('announcement parser takes the latest web domain, not App or permanent links',()=>{
 assert.equal(c.latestAnnouncement(doc(announcement('javdb580.com')),'https://javdb.com'),'https://javdb580.com');
 assert.equal(c.latestAnnouncement(doc(announcement('javdb99999.com')),'https://javdb580.com'),'https://javdb99999.com');
 assert.equal(c.latestAnnouncement(doc('<a href="https://javdb999.com">广告</a>'),'https://javdb.com'),null);
 assert.equal(c.latestAnnouncement(doc(announcement('evil.test')),'https://javdb.com'),null);
});
test('fresh page announcement initializes cache without making an extra request',async()=>{
 const storage=memory();const result=await c.syncLatestDomain({storage,document:doc(announcement('javdb580.com')),origin:'https://javdb.com',now,request:async()=>{throw Error('Must not request');}});
 assert.equal(result.latest,'https://javdb580.com');assert.equal(result.checkedAt,now);assert.equal(c.nextDomainCheck(result),now+DAY);
});
test('cached domain suppresses checks for 24h, then fresh homepage updates it',async()=>{
 const storage=memory({[c.DOMAIN_STORAGE_KEY]:{latest:'https://javdb580.com',checkedAt:now,attemptedAt:now,error:''}});const requests=[];
 const opts={storage,origin:'https://javdb.com',parseHTML:doc,request:async url=>{requests.push(url);return announcement('javdb581.com');}};
 assert.equal((await c.syncLatestDomain({...opts,now:now+DAY-1})).latest,'https://javdb580.com');assert.equal(requests.length,0);
 const result=await c.syncLatestDomain({...opts,now:now+DAY});assert.equal(result.latest,'https://javdb581.com');assert.deepEqual(requests,['https://javdb.com/']);assert.equal(result.checkedAt,now+DAY);
});
test('network and malformed announcements retain old address without faking a successful check',async()=>{
 for(const request of [async()=>{throw Error('offline');},async()=>'<h1>Changed page</h1>']){
  const storage=memory({[c.DOMAIN_STORAGE_KEY]:{latest:'https://javdb580.com',checkedAt:now-DAY,attemptedAt:now-DAY,error:''}});
  const result=await c.syncLatestDomain({storage,origin:'https://javdb.com',now,request,parseHTML:doc});
  assert.equal(result.latest,'https://javdb580.com');assert.equal(result.checkedAt,now-DAY);assert.ok(result.error);assert.equal(c.nextDomainCheck(result),now+3600000);
 }
});
test('mirror job recovery copies and rebases every request URL, while preserving original progress and filters',async()=>{
 const original=c.createJob('https://javdb.com/lists/GJ5a7?sort=score','剧情爆炸');original.nextPage='https://javdb.com/lists/GJ5a7?page=3&sort=score';original.pages=[original.source,'https://javdb.com/lists/GJ5a7?page=2&sort=score'];original.signatures=['a','b'];original.items=[{id:'a',url:'https://javdb.com/v/a',status:'pending',code:'ABC-001'}];
 const storage=memory({[c.jobStorageKey(original.source)]:original});const target='https://javdb580.com/lists/GJ5a7?sort=score';
 const result=await c.loadJob(storage,target);
 assert.equal(result.source,target);assert.equal(result.nextPage,'https://javdb580.com/lists/GJ5a7?page=3&sort=score');assert.deepEqual(result.pages,[target,'https://javdb580.com/lists/GJ5a7?page=2&sort=score']);assert.equal(result.items[0].url,'https://javdb580.com/v/a');assert.deepEqual(storage.data.get(c.jobStorageKey(original.source)),original);
 await c.saveJob(storage,result);assert.equal(storage.data.get(c.jobStorageKey(target)).source,target);assert.equal(storage.data.get(c.jobStorageKey(original.source)).source,original.source);
 const later=await c.loadJob(storage,'https://javdb999.com/lists/GJ5a7?sort=score');assert.equal(later.items[0].url,'https://javdb999.com/v/a');
});
test('unrelated sites and collections cannot import mirror checkpoints',async()=>{
 const job=c.createJob('https://javdb.com/lists/one','One');const storage=memory({[c.jobStorageKey(job.source)]:job});
 assert.equal(await c.loadJob(storage,'https://javdb580.com/lists/other'),null);
 assert.throws(()=>c.rebaseJob(job,'https://evil.test'),/域名|来源/);
 const bad=structuredClone(job);bad.items=[{id:'a',url:'https://evil.test/v/a',status:'pending'}];assert.throws(()=>c.rebaseJob(bad,'https://javdb580.com'));
});
test('opening the latest domain keeps full current page, filters and page number',()=>{
 assert.equal(c.latestPageURL('https://javdb581.com','https://javdb.com/tags?c1=64&c2=48&page=3#top'),'https://javdb581.com/tags?c1=64&c2=48&page=3#top');
 assert.throws(()=>c.latestPageURL('https://evil.test','https://javdb.com/'));
});
test('an earlier slow failure cannot roll back a newer successful shared domain check',async()=>{
 const storage=memory({[c.DOMAIN_STORAGE_KEY]:{latest:'https://javdb580.com',checkedAt:now-DAY,attemptedAt:now-DAY,error:''}});
 let failSlow,started;const pending=new Promise((resolve,reject)=>{failSlow=reject;});const didStart=new Promise(resolve=>started=resolve);
 const older=c.syncLatestDomain({storage,origin:'https://javdb.com',now,parseHTML:doc,request:async()=>{started();return pending;}});
 await didStart;
 await c.syncLatestDomain({storage,origin:'https://javdb580.com',now:now+1,parseHTML:doc,request:async()=>announcement('javdb581.com')});
 failSlow(Error('late timeout'));const result=await older;
 assert.equal(result.latest,'https://javdb581.com');assert.equal(result.checkedAt,now+1);assert.equal(result.error,'');assert.equal(storage.data.get(c.DOMAIN_STORAGE_KEY).latest,'https://javdb581.com');
});
