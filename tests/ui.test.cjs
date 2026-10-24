const {test}=require('node:test');
const assert=require('node:assert/strict');
const {DOMParser}=require('linkedom');
const c=require('../javdb-collector.user.js');
const origin='https://javdb.com', source=origin+'/lists/sample';
const announcement=latest=>`<nav class="sub-header">最新域名: <a href="https://${latest}/">${latest}</a></nav>`;
const list='<html><body>'+announcement('javdb580.com')+'<h2 class="title"><span class="actor-section-name">Sample list</span></h2><div class="movie-list"><div class="item"><a href="/v/a"><div class="video-title"><strong>ABC-001</strong> A</div></a></div></div></body></html>';
const detail='<html><body><div class="video-detail"><h2>A</h2></div><div id="magnets-content"><div class="item"><div class="magnet-name"><a href="magnet:?xt=urn:btih:0000000000000000000000000000000000000001"><span class="name">A 1080P 中文字幕</span></a></div></div></div></body></html>';
const parseHTML=h=>new DOMParser().parseFromString(h,'text/html');
function dependencies(extra={}){
 const data=new Map(),downloads=[];
 const options={document:parseHTML(list),location:new URL(source),storage:{get:async(k,d)=>data.has(k)?structuredClone(data.get(k)):d,set:async(k,v)=>data.set(k,structuredClone(v))},locks:{request:async(n,o,f)=>f({name:n})},parseHTML,request:async u=>u===source?list:detail,domainRequest:async()=>announcement('javdb580.com'),schedule:()=>0,unschedule:()=>{},download:(text,name)=>downloads.push({text,name}),confirm:()=>true,...extra};
 return {options,data,downloads};
}
async function until(fn){for(let i=0;i<100;i++){if(fn())return;await new Promise(r=>setImmediate(r));}throw Error('State did not settle');}
const button=(ui,action)=>ui.host.shadowRoot.querySelector(`[data-action="${action}"]`);
const text=ui=>ui.host.shadowRoot.querySelector('section').textContent;
test('panel starts a real collector through its button and exports the requested numbered TXT layout',async()=>{
 const {options,downloads}=dependencies();const ui=await c.mount(options);
 assert.equal(button(ui,'start').disabled,false);button(ui,'start').click();
 await until(()=>text(ui).includes('采集完成'));
 assert.equal(button(ui,'export').disabled,false);button(ui,'export').click();
 assert.equal(downloads.length,1);assert.equal(downloads[0].text,'-------------\r\nABC-001      magnet:?xt=urn:btih:0000000000000000000000000000000000000001\r\n-------------\r\n');assert.equal(downloads[0].name,'Sample list.txt');
});
test('restored checkpoint can resume without requesting the completed list again',async()=>{
 const d=dependencies(),job=c.createJob(source,'Saved');job.nextPage=null;job.pages=[source];job.signatures=['a'];job.status='running';job.items=[{id:'a',url:origin+'/v/a',label:'A',status:'pending'}];
 d.data.set(c.jobStorageKey(source),job);const requests=[];d.options.request=async u=>{requests.push(u);return detail;};
 const ui=await c.mount(d.options);assert.equal(button(ui,'resume').disabled,false);button(ui,'resume').click();await until(()=>text(ui).includes('采集完成'));assert.deepEqual(requests,[origin+'/v/a']);
});
test('pause control saves current work and exposes continuation, including partial export',async()=>{
 let release;const deferred=new Promise(r=>release=r);const d=dependencies({request:async u=>u===source?list:deferred});
 const ui=await c.mount(d.options);button(ui,'start').click();await until(()=>text(ui).includes('处理影片'));
 button(ui,'pause').click();release(detail);await until(()=>text(ui).includes('已暂停'));
 assert.equal(button(ui,'resume').disabled,false);button(ui,'export').click();assert.equal(d.downloads[0].name,'Sample list.txt');assert.match(text(ui),/任务尚未完成/);
});
test('a held lock in another tab prevents new requests or checkpoint mutation',async()=>{
 const d=dependencies({locks:{request:async(n,o,f)=>f(null)},request:async()=>{throw Error('Must not request');}});
 const ui=await c.mount(d.options);button(ui,'start').click();await until(()=>text(ui).includes('另一个标签页'));
 assert.equal([...d.data.keys()].filter(k=>k.includes(':job:')||k.includes(':last:')).length,0);assert.equal(button(ui,'start').disabled,false);
});
test('unsupported pages cannot start a site-wide crawl and corrupt storage is shown',async()=>{
 const d=dependencies({document:parseHTML('<html><body><h1>Actor directory</h1></body></html>'),location:new URL(origin+'/actors')});
 const ui=await c.mount(d.options);assert.equal(button(ui,'start').disabled,true);assert.match(text(ui),/作品列表/);
 const broken=dependencies({storage:{get:async()=>({schema:999}),set:async()=>{throw Error('Must not overwrite');}}});
 const other=await c.mount(broken.options);assert.match(text(other),/损坏|不兼容/);
});
test('429 cooldown prevents immediate resume and retains the original task',async()=>{
 const d=dependencies(),job=c.createJob(source,'Saved');job.status='blocked';job.retryAt=Date.now()+60000;job.error='站点限流';
 d.data.set(c.jobStorageKey(source),job);const ui=await c.mount(d.options);button(ui,'resume').click();await until(()=>text(ui).includes('冷却'));assert.equal(d.data.get(c.jobStorageKey(source)).retryAt,job.retryAt);
});
test('failed details expose a retry button and retain successful export while retrying',async()=>{
 let fail=true;const d=dependencies({request:async u=>{if(u===source)return list;if(fail)throw Error('offline');return detail;}});
 const ui=await c.mount(d.options);button(ui,'start').click();await until(()=>text(ui).includes('部分完成'));
 assert.equal(button(ui,'retry').disabled,false);assert.match(text(ui),/offline/);fail=false;button(ui,'retry').click();await until(()=>text(ui).includes('采集完成'));assert.equal(button(ui,'export').disabled,false);
});
test('latest-domain timer refreshes the homepage after 24h and updates the link without navigating',async()=>{
 let time=864000000,requests=0;const timers=[];
 const d=dependencies({now:()=>time,schedule:(fn,ms)=>{timers.push({fn,ms});return timers.length;},domainRequest:async()=>{requests++;return announcement('javdb581.com');}});
 const ui=await c.mount(d.options);await until(()=>text(ui).includes('最新站点：javdb580.com'));
 assert.equal(timers.at(-1).ms,86400000);assert.equal(requests,0);
 time+=86400000;await timers.at(-1).fn();await until(()=>text(ui).includes('最新站点：javdb581.com'));
 assert.equal(requests,1);assert.equal(ui.host.shadowRoot.querySelector('[data-field="latest-link"]').getAttribute('href'),'https://javdb581.com/lists/sample');assert.equal(d.options.location.href,source);
});
test('new-domain panel restores a permanent-domain checkpoint and requests details only on new domain',async()=>{
 const d=dependencies({location:new URL('https://javdb580.com/lists/sample')}),job=c.createJob(source,'Saved');job.nextPage=null;job.pages=[source];job.signatures=['a'];job.status='paused';job.items=[{id:'a',url:origin+'/v/a',label:'A',status:'pending'}];
 d.data.set(c.jobStorageKey(source),job);const requests=[];d.options.request=async u=>{requests.push(u);return detail;};
 const ui=await c.mount(d.options);button(ui,'resume').click();await until(()=>text(ui).includes('采集完成'));
 assert.deepEqual(requests,['https://javdb580.com/v/a']);assert.equal(d.data.get(c.jobStorageKey(source)).status,'paused');assert.equal(d.data.get(c.jobStorageKey('https://javdb580.com/lists/sample')).status,'completed');
});
