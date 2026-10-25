const {test}=require('node:test');
const assert=require('node:assert/strict');
const c=require('../javdb-collector.user.js');
const hash=n=>n.toString(16).padStart(40,'0');
const magnet=n=>`magnet:?xt=urn:btih:${hash(n)}`;
const response=(status,text='')=>({status,text});
function transport(handler){
 const calls=[];
 return {calls,request:async options=>{calls.push(options);const result=handler(options);if(result instanceof Error)throw result;return result;}};
}

test('normalizes qBittorrent base URLs and rejects unsafe forms',()=>{
 assert.equal(c.normalizeQbtUrl('http://192.168.1.10:8080/'),'http://192.168.1.10:8080');
 assert.equal(c.normalizeQbtUrl(' https://qbt.example.com/qbt/ '),'https://qbt.example.com/qbt');
 assert.equal(c.normalizeQbtUrl('http://qbt:8080/api/v2/'),'http://qbt:8080');
 assert.equal(c.normalizeQbtUrl('https://qbt.example.com/qbt/api/v2'),'https://qbt.example.com/qbt');
 for(const bad of ['','ftp://qbt','http://user:pass@qbt:8080','http://qbt:8080/?x=1']){
  assert.throws(()=>c.normalizeQbtUrl(bad),c.QbtError);
 }
});

test('sends Bearer API key and download parameters to torrents/add',async()=>{
 const t=transport(()=>response(200,JSON.stringify({success_count:2,failure_count:0,pending_count:0,added_torrent_ids:[hash(1),hash(2)]})));
 const client=c.createQbtClient({base:'http://qbt:8080',apiKey:'qbt_test',request:t.request});
 const result=await client.add([magnet(1),magnet(2)],{savePath:'/downloads/JavDB',category:'JavDB',tags:'javdb,auto',paused:false});
 assert.deepEqual(result,{success:2,failure:0,pending:0,ids:[hash(1),hash(2)],conflict:false});
 const call=t.calls[0];
 assert.equal(call.method,'POST');
 assert.equal(call.url,'http://qbt:8080/api/v2/torrents/add');
 assert.equal(call.headers.Authorization,'Bearer qbt_test');
 assert.equal(call.headers['Content-Type'],'application/x-www-form-urlencoded');
 const form=new URLSearchParams(call.data);
 assert.equal(form.get('urls'),magnet(1)+'\n'+magnet(2));
 assert.equal(form.get('savepath'),'/downloads/JavDB');
 assert.equal(form.get('autoTMM'),'false');
 assert.equal(form.get('category'),'JavDB');
 assert.equal(form.get('tags'),'javdb,auto');
 assert.equal(form.get('stopped'),'false');
 assert.equal(form.get('paused'),'false');
});

test('maps the paused option to qBittorrent 5.x stopped and keeps 4.x paused',async()=>{
 const t=transport(()=>response(200,'Ok.'));
 const client=c.createQbtClient({base:'http://qbt:8080',apiKey:'qbt_test',request:t.request});
 assert.deepEqual(await client.add([magnet(1)],{paused:true}),{success:1,failure:0,pending:0,ids:[],conflict:false});
 const form=new URLSearchParams(t.calls[0].data);
 assert.equal(form.get('stopped'),'true');
 assert.equal(form.get('paused'),'true');
});

test('reports API key failures, conflicts and malformed add responses',async()=>{
 const denied=transport(()=>response(403,'Forbidden'));
 const client=c.createQbtClient({base:'http://qbt:8080',apiKey:'qbt_bad',request:denied.request});
 await assert.rejects(client.version(),error=>error instanceof c.QbtError&&error.status===403&&/API Key/.test(error.message));

 const conflict=transport(()=>response(409,''));
 const conflicting=c.createQbtClient({base:'http://qbt:8080',apiKey:'qbt_test',request:conflict.request});
 assert.equal((await conflicting.add([magnet(1)])).conflict,true);

 const malformed=transport(()=>response(200,'<html>proxy error</html>'));
 const broken=c.createQbtClient({base:'http://qbt:8080',apiKey:'qbt_test',request:malformed.request});
 await assert.rejects(broken.add([magnet(1)]),/无法识别/);
});

test('checks existing hashes with the documented pipe separator',async()=>{
 const t=transport(()=>response(200,JSON.stringify([{hash:hash(1).toUpperCase()}])));
 const client=c.createQbtClient({base:'http://qbt:8080',apiKey:'qbt_test',request:t.request});
 const found=await client.existingHashes([hash(0),hash(1)]);
 assert.deepEqual([...found],[hash(1)]);
 assert.equal(t.calls[0].url,'http://qbt:8080/api/v2/torrents/info?hashes='+encodeURIComponent(hash(0)+'|'+hash(1)));
});

test('pushMagnets deduplicates, skips existing and batches the rest',async()=>{
 const adds=[];
 const client={
  async existingHashes(hashes){return new Set(hashes.filter(value=>value===hash(0)));},
  async add(urls,options){
   adds.push({urls,options});
   return {success:urls.length,failure:0,pending:0,ids:urls.map(url=>url.match(/btih:([a-f\d]{40})/i)[1]),conflict:false};
  }
 };
 const urls=[magnet(0),magnet(1),magnet(1)+'&dn=duplicate',magnet(2),magnet(3),magnet(4)];
 const phases=[];
 const summary=await c.pushMagnets({client,urls,chunkSize:2,onProgress:progress=>phases.push(progress.phase)});
 assert.equal(summary.requested,6);
 assert.equal(summary.unique,5);
 assert.equal(summary.skipped,1);
 assert.equal(summary.added,4);
 assert.equal(summary.failed,0);
 assert.deepEqual(adds.map(call=>call.urls),[ [magnet(1),magnet(2)], [magnet(3),magnet(4)] ]);
 assert.ok(phases.includes('checking'));
 assert.ok(phases.includes('adding'));
});

test('pushMagnets reports invalid magnets and per-chunk failures without stopping',async()=>{
 const client={
  async existingHashes(){return new Set();},
  async add(urls){if(urls[0]===magnet(1))throw Error('qBittorrent 无法解析本批磁链');return {success:urls.length,failure:0,pending:0,ids:urls.map(url=>url.match(/btih:([a-f\d]{40})/i)[1]),conflict:false};}
 };
 const summary=await c.pushMagnets({client,urls:['not-a-magnet',magnet(1),magnet(2),magnet(3)],chunkSize:2,skipExisting:false});
 assert.equal(summary.failed,3);
 assert.equal(summary.added,1);
 assert.match(summary.failures[0].error,/不是有效的磁链/);
 assert.match(summary.failures.at(-1).error,/无法解析/);
});
