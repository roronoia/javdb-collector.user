const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DOMParser } = require('linkedom');
const core = require('../javdb-collector.user.js');
const doc = html => new DOMParser().parseFromString(`<html><head>${html.match(/<title>.*?<\/title>/s)?.[0]||''}</head><body>${html.replace(/<title>.*?<\/title>/s,'')}</body></html>`, 'text/html');
const hash = n => n.toString(16).padStart(40,'0');
const magnet = n => `magnet:?xt=urn:btih:${hash(n)}`;
const candidate = (n, name, hd=false, sub=false) => ({url:magnet(n), name, siteHD:hd, siteSub:sub});

test('selects HD+Chinese before HD before Chinese before the first valid fallback', () => {
  const a=candidate(1,'SD'), b=candidate(2,'SUB',false,true), c=candidate(3,'HD',true), d=candidate(4,'BOTH',true,true);
  assert.equal(core.selectMagnet([a,b,c,d]).url,magnet(4));
  assert.equal(core.selectMagnet([a,b,c]).url,magnet(3));
  assert.equal(core.selectMagnet([a,b]).url,magnet(2));
  assert.equal(core.selectMagnet([a,candidate(5,'SD')]).url,magnet(1));
  assert.equal(core.selectMagnet([a]).url,magnet(1));
  assert.equal(core.selectMagnet([]),null);
});
test('explicit filename resolution overrides site HD; same tier preserves page order', () => {
  for (const name of ['ABC-001 720p','ABC-001 480P','ABC-001 1920x720']) {
    assert.equal(core.selectMagnet([candidate(1,name,true,true),candidate(2,'1080P',false,true)]).url,magnet(2));
  }
  for (const name of ['ABC-001 1080p','ABC-001 2160P','ABC-001 4K','ABC-001 3840x2160','ABC-001 FHD']) {
    assert.equal(core.selectMagnet([candidate(1,'SD',false,true),candidate(2,name,false,true)]).url,magnet(2));
  }
  assert.equal(core.selectMagnet([candidate(1,'no resolution',true,true),candidate(2,'4K',true,true)]).url,magnet(1));
});
test('recognizes Chinese filenames without treating English subtitles or uncensored as Chinese', () => {
  for (const name of ['ABC-001 中文字幕','ABC-001 中字','ABC-001 CHS','ABC-001-C.torrent','ABC-001-UC']) {
    assert.equal(core.selectMagnet([candidate(1,'HD',true),candidate(2,name,true)]).url,magnet(2));
  }
  for (const name of ['ABC-001 ENG SUB','ABC-001 uncensored','ABC-001 无字幕']) {
    assert.equal(core.selectMagnet([candidate(1,'HD',true),candidate(2,name,true)]).url,magnet(1));
  }
  assert.equal(core.selectMagnet([candidate(1,'1080P 无字幕',true,true),candidate(2,'1080P 中文字幕',true)]).url,magnet(2));
});
test('validates hashes and canonicalizes equivalent hex/base32 magnets for TXT deduplication', () => {
  assert.equal(core.magnetKey('magnet:?xt=urn:btih:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'), 'btih:'+ '0'.repeat(40));
  assert.equal(core.magnetKey('magnet:?xt=urn:btih:'+ 'AB'.repeat(20)), 'btih:'+ 'ab'.repeat(20));
  assert.equal(core.magnetKey('https://example.com'),null);
  assert.equal(core.magnetKey('magnet:?xt=urn:btih:xyz'),null);
  assert.equal(core.magnetKey(magnet(1)+'\nother'),null);
  assert.equal(core.selectMagnet([{...candidate(1,'1080P 中字'),url:'magnet:?xt=broken'},candidate(2,'only')]).url,magnet(2));
  const job={items:[{status:'ok',magnet:{url:magnet(0)}},{status:'ok',magnet:{url:'magnet:?xt=urn:btih:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'}},{status:'none'},{status:'ok',magnet:{url:magnet(2)}}]};
  assert.equal(core.exportText(job),magnet(0)+'\r\n'+magnet(2)+'\r\n');
  assert.equal(core.exportText(job,'code'),'未知番号  '+magnet(0)+'\r\n未知番号  '+magnet(2)+'\r\n');
});
test('page 1 normalization preserves search, category and sort parameters', () => {
  assert.equal(core.sourceURL('https://javdb.com/rankings/movies?sort=score&page=9&t=m#top'), 'https://javdb.com/rankings/movies?sort=score&t=m');
});
const listing=(next='') => doc(`<h2 class="title">Collection</h2><div class="movie-list h cols-4 vcols-8"><div class="item"><a class="box" href="/v/aa"><div class="video-title"><strong>ABC-001</strong> Sample</div></a></div><div class="item"><a class="box" href="/v/aa">Duplicate</a></div><div class="item"><a class="box" href="/v/bb">Second</a></div></div>${next}`);
test('parses observed movie cards, deduplicates IDs and fills missing next-page filters', () => {
  const result=core.parseList(listing('<nav class="pagination"><a class="pagination-next" rel="next" href="/actors/actor?page=2">下一頁</a></nav>'),'https://javdb.com/actors/actor?sort=release&t=s');
  assert.deepEqual(result.movies.map(m=>m.id),['aa','bb']);
  assert.equal(result.next,'https://javdb.com/actors/actor?page=2&sort=release&t=s');
});
test('rejects next-page collection changes, loops and backwards links', () => {
  for(const href of ['/lists/other?page=2','https://evil.test/actors/actor?page=2','/actors/actor?page=1','/actors/actor?page=3&sort=size']) {
    assert.throws(()=>core.parseList(listing(`<nav class="pagination"><a class="pagination-next" href="${href}">Next</a></nav>`),'https://javdb.com/actors/actor?page=2&sort=release'));
  }
});
test('an enabled next control without a link is a parse failure, not completion', () => {
  assert.throws(()=>core.parseList(listing('<nav class="pagination"><a class="pagination-next">Next</a></nav>'),'https://javdb.com/lists/sample'));
});
test('missing list markup, login and challenge documents do not count as empty results', () => {
  for(const html of ['<h1>Login</h1><form action="/login"><input type="password"></form>', '<title>Just a moment...</title><div id="cf-challenge-running"></div>', '<h2>Changed markup</h2>']) {
    assert.throws(()=>core.parseList(doc(html),'https://javdb.com/lists/sample'));
  }
  assert.deepEqual(core.parseList(doc('<div class="movie-list"></div><div>暫無影片</div>'),'https://javdb.com/lists/empty').movies,[]);
});
test('parses live magnet-name/name/tags structure, with site subtitle tag and invalid links reported', () => {
  const d=doc(`<div class="video-detail"><h2 class="title">ABC-001 Sample</h2></div><div id="magnets-content"><div class="item"><div class="magnet-name"><a href="${magnet(1)}"><span class="name">ABC-001 720P</span><div class="tags"><span class="tag">高清</span><span class="tag">字幕</span></div><span class="meta">20GB</span></a></div></div><div class="item"><div class="magnet-name"><a href="${magnet(2)}"><span class="name">ABC-001 1080P CHS</span></a></div></div></div>`);
  assert.equal(core.parseDetail(d,'https://javdb.com/v/aa').magnet.url,magnet(2));
  assert.equal(core.parseDetail(doc('<div class="video-detail"><h2>ABC-001</h2></div><div id="magnets-content">暫無磁鏈</div>'),'https://javdb.com/v/aa').magnet,null);
  assert.throws(()=>core.parseDetail(doc('<div class="video-detail"><h2>ABC-001</h2></div>'),'https://javdb.com/v/aa'));
  assert.throws(()=>core.parseDetail(doc('<div class="video-detail"><h2>ABC-001</h2></div><div id="magnets-content"><div class="item"><div class="magnet-name"><a href="magnet:broken">bad</a></div></div></div>'),'https://javdb.com/v/aa'));
});
test('final page with a leading historical ellipsis is complete; a trailing unresolved ellipsis is not',()=>{
 const end='<nav class="pagination"><a class="pagination-next is-disabled">Next</a><ul><li><a class="pagination-link" href="?page=1">1</a></li><li><span class="pagination-ellipsis">…</span></li><li><a class="pagination-link is-current" href="?page=50">50</a></li></ul></nav>';
 assert.equal(core.parseList(listing(end),'https://javdb.com/lists/sample?page=50').next,null);
 assert.throws(()=>core.parseList(listing('<nav class="pagination"><a class="pagination-link is-current">1</a><span class="pagination-ellipsis">…</span></nav>'),'https://javdb.com/lists/sample'),{name:'CollectorError'});
});
test('loading magnets and empty containers are unresolved, never no-magnet success',()=>{
 for(const contents of ['', '<span class="loading">加载中…</span>','Unknown layout']) {
  assert.throws(()=>core.parseDetail(doc(`<div class="video-detail"><h2>ABC-001</h2></div><div id="magnets-content">${contents}</div>`)),{name:'CollectorError'});
 }
});
test('unrelated empty comments do not legitimize a loading or empty movie list',()=>{
 for(const contents of ['','<span class="loading">加载中…</span>']) {
  assert.throws(()=>core.parseList(doc(`<div class="movie-list">${contents}</div><aside>暂无评论</aside>`),'https://javdb.com/lists/sample'),{name:'CollectorError'});
 }
});
test('explicit 900p and 960p filenames override an inaccurate site HD tag',()=>{
 for(const res of ['900p','960p']) assert.equal(core.selectMagnet([candidate(1,res+' CHS',true),candidate(2,'1080p CHS',true)]).url,magnet(2));
});
test('TXT preserves film codes and one record per line without separators',()=>{
 assert.equal(core.parseList(listing(),'https://javdb.com/lists/sample').movies[0].code,'ABC-001');
 assert.equal(core.exportText({items:[{code:'ABC-001',status:'ok',magnet:{url:magnet(1)}},{code:'BBAN-612',status:'ok',magnet:{url:magnet(2)}}]}),magnet(1)+'\r\n'+magnet(2)+'\r\n');
 assert.equal(core.exportText({items:[{code:'ABC-001',status:'ok',magnet:{url:magnet(1)}},{code:'BBAN-612',status:'ok',magnet:{url:magnet(2)}}]},'code'),'ABC-001  '+magnet(1)+'\r\nBBAN-612  '+magnet(2)+'\r\n');
 const d=doc('<div class="video-detail"><div class="panel-block first-block"><strong>番號:</strong><span class="value"><a>ROE</a>-559</span></div></div><div id="magnets-content">暫無磁鏈</div>');
 assert.equal(core.parseDetail(d).code,'ROE-559');
});
test('batch download export is one bare magnet per line, deduplicated and without film codes',()=>{
 const job={items:[
  {code:'ABC-001',status:'ok',magnet:{url:magnet(1)}},
  {code:'ABC-002',status:'ok',magnet:{url:magnet(1)+'&dn=duplicate'}},
  {code:'ABC-003',status:'failed',magnet:{url:magnet(3)}},
  {code:'ABC-004',status:'ok',magnet:{url:magnet(4)}}
 ]};
 assert.equal(core.exportText(job),magnet(1)+'\r\n'+magnet(4)+'\r\n');
 assert.equal(core.exportText({items:[]}),'');
});
test('clipboard fallback uses a temporary textarea and reports refused access',async()=>{
 const makeDoc=result=>{const appended=[];const area={value:'',style:{},setAttribute(){},select(){},remove(){}};return {area,appended,doc:{createElement:()=>area,body:{appendChild:node=>appended.push(node)},execCommand:()=>result}};};
 const ok=makeDoc(true);await core.copyText(magnet(1),ok.doc);
 assert.equal(ok.area.value,magnet(1));assert.deepEqual(ok.appended,[ok.area]);
 const denied=makeDoc(false);await assert.rejects(core.copyText('x',denied.doc),/剪贴板/);
});
test('page naming uses actual list, actor, prefix and maker name fields',()=>{
 for(const [path,html,want] of [
  ['/lists/QzJMK','<h2 class="title"><span class="actor-section-name">经典不可超越</span><span class="section-meta">333部影片</span></h2>','经典不可超越'],
  ['/actors/demo','<h2 class="title"><span class="actor-section-name">演员名字</span><span class="section-meta">800部影片</span></h2>','演员名字'],
  ['/video_codes/BBAN','<h2 class="title"><span class="section-subtitle">番號</span><span class="section-name">BBAN</span></h2>','BBAN'],
  ['/makers/J0R','<h2 class="title"><span class="section-subtitle">片商</span><span class="section-name">ビビアン</span></h2>','ビビアン']
 ]) assert.equal(core.pageName(doc(html),'https://javdb.com'+path).name,want);
});
test('all category filters appear in filename from live tag-category selected divs',()=>{
 const url='https://javdb.com/tags?c1=64&c2=48&c5=74&c10=1';
 const d=doc('<title>有碼分類 | JavDB 成人影片數據庫</title><div class="tag-category" id="tag-category-10"><div class="tag is-info">含磁鏈<button class="delete"></button></div></div><div class="tag-category" id="tag-category-1"><div class="tag is-info">分类甲<button class="delete"></button></div></div><div class="tag-category" id="tag-category-2"><div class="tag is-info">分类乙<button class="delete"></button></div></div><div class="tag-category" id="tag-category-5"><div class="tag is-info">分类丙<button class="delete"></button></div></div>');
 const result=core.pageName(d,url);
 assert.deepEqual(result.filters,['分类甲','分类乙','分类丙','含磁鏈']);assert.deepEqual(result.missing,[]);assert.equal(result.name,'有碼分類_分类甲_分类乙_分类丙_含磁鏈');
});
test('category names can come from labelled controls, unresolved names remain explicit',()=>{
 const d=doc('<title>分类筛选</title><label for="one">分类甲</label><input id="one" type="checkbox" name="c1" value="64" checked><select name="c2"><option value="48" selected>分类乙</option></select>');
 const result=core.pageName(d,'https://javdb.com/tags?c1=64&c2=48&c5=74');
 assert.deepEqual(result.filters,['分类甲','分类乙','c5=74']);assert.deepEqual(result.missing,['c5=74']);assert.match(result.name,/分类甲_分类乙_c5=74/);
});
test('prefix and maker pagination preserve their own collection and filters',()=>{
 assert.equal(core.parseList(listing('<nav class="pagination"><a class="pagination-next" href="/video_codes/BBAN?page=2">Next</a></nav>'),'https://javdb.com/video_codes/BBAN').next,'https://javdb.com/video_codes/BBAN?page=2');
 assert.equal(core.parseList(listing('<nav class="pagination"><a class="pagination-next" href="/makers/J0R?f=download&page=2">Next</a></nav>'),'https://javdb.com/makers/J0R?f=download').next,'https://javdb.com/makers/J0R?f=download&page=2');
});
test('full collection name survives checkpoint creation, including long combinations of filters',()=>{
 const name='分类'.repeat(105);
 assert.equal(core.createJob('https://javdb.com/tags?c1=64',name).title,name);
 assert.equal(core.fileName('BBAN'),'BBAN.txt');
 assert.equal(core.fileName('演员:测试/名称'),'演员_测试_名称.txt');
 assert.throws(()=>core.fileName('长'.repeat(231)),/过长/);
});
