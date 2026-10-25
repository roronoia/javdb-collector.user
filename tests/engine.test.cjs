const {test}=require('node:test');
const assert=require('node:assert/strict');
const {DOMParser}=require('linkedom');
const c=require('../javdb-collector.user.js');
const parseHTML=html=>new DOMParser().parseFromString(html,'text/html');
const origin='https://javdb.com';
const src=origin+'/lists/sample?sort=release';
const hash=n=>n.toString(16).padStart(40,'0');
const uri=n=>'magnet:?xt=urn:btih:'+hash(n);
const txt=(...ns)=>''+ns.map(n=>'未知番号  '+uri(n)+'\r\n').join('');
const list=(ids,next='')=>`<html><body><div class="movie-list">${ids.map(id=>`<div class="item"><a href="/v/${id}">${id}</a></div>`).join('')}</div>${next?`<nav class="pagination"><a rel="next" class="pagination-next" href="${next}">Next</a></nav>`:''}</body></html>`;
const detail=n=>`<html><body><div class="video-detail"><h2>TEST</h2></div><div id="magnets-content">${n?`<div class="item"><div class="magnet-name"><a href="${uri(n)}"><span class="name">TEST 1080P CHS</span></a></div></div>`:'暫無磁鏈'}</div></body></html>`;
function setup(responses,custom={}) {
 const requests=[],saved=[];
 const engine=new c.Collector({parseHTML,request:async url=>{requests.push(url);const result=responses[url];if(result instanceof Error)throw result;if(typeof result==='function')return result(url);if(result===undefined)throw Error('Unexpected URL: '+url);return result;},save:async job=>saved.push(structuredClone(job)),...custom});
 return {engine,requests,saved};
}
test('discovers all pages, deduplicates films, selects one magnet and completes with explicit counts',async()=>{
 const {engine,requests,saved}=setup({[src]:list(['a','b'],'/lists/sample?page=2'),[origin+'/lists/sample?page=2&sort=release']:list(['b','c']),[origin+'/v/a']:detail(1),[origin+'/v/b']:detail(null),[origin+'/v/c']:detail(1)});
 const job=c.createJob(src,'Sample');await engine.run(job);
 assert.equal(job.status,'completed');assert.equal(job.pages.length,2);assert.deepEqual(job.items.map(i=>i.status),['ok','none','ok']);
 assert.equal(c.exportText(job),txt(1));assert.equal(requests.length,5);assert.equal(saved.at(-1).status,'completed');
});
test('failed list page preserves next page and cannot become completed',async()=>{
 const {engine}=setup({[src]:list(['a'],'?page=2'),[origin+'/lists/sample?page=2&sort=release']:new Error('Network down')});
 const job=c.createJob(src,'Sample');await engine.run(job);
 assert.equal(job.status,'blocked');assert.equal(job.pages.length,1);assert.equal(job.nextPage,origin+'/lists/sample?page=2&sort=release');assert.match(job.error,/Network down/);
});
test('ordinary detail failure produces partial results, retry succeeds without revisiting completed details',async()=>{
 const responses={[src]:list(['a','b']),[origin+'/v/a']:detail(1),[origin+'/v/b']:new Error('Network down')};
 const {engine,requests}=setup(responses);const job=c.createJob(src,'Sample');await engine.run(job);
 assert.equal(job.status,'partial');assert.deepEqual(job.items.map(i=>i.status),['ok','failed']);
 responses[origin+'/v/b']=detail(2);await engine.run(job,{retryFailed:true});
 assert.equal(job.status,'completed');assert.equal(requests.filter(u=>u===origin+'/v/a').length,1);assert.equal(c.exportText(job),txt(1,2));
});
test('pause saves the current film, reconstructed engine resumes from checkpoint without duplicates',async()=>{
 let first;const responses={[src]:list(['a','b']),[origin+'/v/a']:()=>{first.engine.pause();return detail(1);},[origin+'/v/b']:detail(2)};
 first=setup(responses);const job=c.createJob(src,'Sample');await first.engine.run(job);
 assert.equal(job.status,'paused');assert.deepEqual(job.items.map(i=>i.status),['ok','pending']);
 const restored=structuredClone(first.saved.at(-1));const second=setup(responses);await second.engine.run(restored);
 assert.equal(restored.status,'completed');assert.deepEqual(second.requests,[origin+'/v/b']);
});
test('rate limit blocks pending film and keeps retry-after, instead of skipping it',async()=>{
 const {engine}=setup({[src]:list(['a','b']),[origin+'/v/a']:new c.CollectorError('HTTP 429',{blocked:true,kind:'rate',retryAt:12345})});
 const job=c.createJob(src,'Sample');await engine.run(job);
 assert.equal(job.status,'blocked');assert.equal(job.retryAt,12345);assert.equal(job.items[0].status,'pending');
});
test('failed persistence stops requests and leaves the error visible with results retained in memory',async()=>{
 let calls=0;const {engine,requests}=setup({[src]:list(['a','b']),[origin+'/v/a']:detail(1)}, {save:async()=>{if(++calls>=3)throw Error('Quota full');}});
 const job=c.createJob(src,'Sample');await engine.run(job);
 assert.equal(job.status,'blocked');assert.match(job.error,/保存.*Quota full/);assert.deepEqual(requests,[src,origin+'/v/a']);assert.equal(c.exportText(job),txt(1));
});
test('repeated page content pauses at the unresolved page instead of claiming completion',async()=>{
 const {engine}=setup({[src]:list(['a'],'?page=2'),[origin+'/lists/sample?page=2&sort=release']:list(['a'])});
 const job=c.createJob(src,'Sample');await engine.run(job);
 assert.equal(job.status,'blocked');assert.equal(job.pages.length,1);assert.match(job.error,/重复/);
});
test('unrecognizable detail HTML pauses without marking a film as no magnets',async()=>{
 const {engine}=setup({[src]:list(['a']),[origin+'/v/a']:'<html><body><h1>Structure changed</h1></body></html>'});
 const job=c.createJob(src,'Sample');await engine.run(job);
 assert.equal(job.status,'blocked');assert.equal(job.items[0].status,'pending');
});
function transport(sequence,extra={}){
 let time=10000;const waits=[],starts=[];
 const request=c.createRequester({origin,fetchImpl:async(url,options)=>{starts.push(time);assert.equal(options.credentials,'same-origin');const result=sequence.shift();if(result instanceof Error)throw result;return {...result,url:result.url||url};},now:()=>time,wait:async ms=>{waits.push(ms);time+=ms;},...extra});
 return {request,waits,starts};
}
const response=(status,text='ok',url='')=>({status,ok:status>=200&&status<300,url,headers:new Headers({'Content-Type':'text/html'}),text:async()=>text});
test('request boundary uses cookies, keeps request starts at least 2 seconds apart and returns HTML',async()=>{
 const {request,starts}=transport([response(200,'one'),response(200,'two')]);
 assert.equal(await request(src),'one');assert.equal(await request(src),'two');assert.deepEqual(starts,[10000,12000]);
});
test('transient network errors retry at most three attempts and later recover',async()=>{
 const first=transport([new Error('offline'),response(503),response(200,'recovered')]);
 assert.equal(await first.request(src),'recovered');assert.equal(first.starts.length,3);
 const second=transport([new Error('offline'),new Error('offline'),new Error('offline')]);
 await assert.rejects(second.request(src),/offline/);assert.equal(second.starts.length,3);
});
test('429 exposes Retry-After without automatic retries; login redirects and cross-origin URLs block',async()=>{
 const rate=response(429);rate.headers.set('Retry-After','60');const limited=transport([rate]);
 await assert.rejects(limited.request(src),e=>e.blocked&&e.kind==='rate'&&e.retryAt===70000);assert.equal(limited.starts.length,1);
 const login=transport([response(200,'login',origin+'/login')]);await assert.rejects(login.request(src),e=>e.blocked);
 const other=transport([]);await assert.rejects(other.request('https://evil.test/'),e=>e.blocked);assert.equal(other.starts.length,0);
});
test('pause during retry wait prevents another request',async()=>{
 let stop=false;
 const {request,starts}=transport([new Error('offline'),response(200)],{shouldStop:()=>stop,wait:async()=>{stop=true;}});
 await assert.rejects(request(src),e=>e.kind==='pause');assert.equal(starts.length,1);
});
