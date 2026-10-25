// ==UserScript==
// @name         JavDB 全分页磁链采集
// @namespace    local.javdb.collector
// @version      1.3.0
// @description  当前列表全分页采集，每部优选一条磁链，支持断点续采、批量导出、一键复制与 qBittorrent 推送。
// @homepageURL  https://github.com/roronoia/javdb-collector.user
// @supportURL   https://github.com/roronoia/javdb-collector.user/issues
// @updateURL    https://raw.githubusercontent.com/roronoia/javdb-collector.user/main/javdb-collector.meta.js
// @downloadURL  https://raw.githubusercontent.com/roronoia/javdb-collector.user/main/javdb-collector.user.js
// @match        https://javdb.com/*
// @match        https://www.javdb.com/*
// @match        https://javdb580.com/*
// @match        https://www.javdb580.com/*
// @include      /^https:\/\/(?:www\.)?javdb\d*\.com\/.*$/
// @run-at       document-idle
// @noframes
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @connect      *
// ==/UserScript==

(function (factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else api.mount().catch(error => console.error('[JavDB 采集]', error));
})(function () {
  'use strict';
  const compact = value => String(value || '').replace(/\s+/g, ' ').trim();
  const DAY = 86400000;
  const DOMAIN_STORAGE_KEY = 'javdb-collector:v1:domains';
  const FAMILY_LAST_KEY = 'javdb-collector:v1:family-last';
  const QBT_STORAGE_KEY = 'javdb-collector:v1:qbt';
  function isJavdbSite(value) {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && !url.port && !url.username && !url.password && /^(?:www\.)?javdb\d*\.com$/i.test(url.hostname);
    } catch (_) { return false; }
  }
  function latestAnnouncement(doc, currentURL) {
    if (!isJavdbSite(currentURL)) return null;
    for (const link of doc.querySelectorAll('.sub-header a[href]')) {
      let before = '', node = link.previousSibling;
      while (node && node.nodeName !== 'A' && before.length < 300) { before = (node.textContent || '') + before; node = node.previousSibling; }
      if (!/最新(?:域名|網址|网址|網站|网站)|latest\s+(?:domain|site)/i.test(before)) continue;
      const target = new URL(link.getAttribute('href'), currentURL);
      if (isJavdbSite(target.href) && target.pathname === '/' && !target.search && !target.hash) return target.origin;
    }
    return null;
  }
  function nextDomainCheck(state) {
    if (state?.error) return (state.attemptedAt || 0) + 3600000;
    return (state?.checkedAt || 0) + DAY;
  }
  async function syncLatestDomain({ storage, document: doc, origin, request, parseHTML = text => new DOMParser().parseFromString(text, 'text/html'), now = Date.now() }) {
    if (!isJavdbSite(origin)) throw Error('不支持的站点域名。');
    let cached = await storage.get(DOMAIN_STORAGE_KEY, null);
    if (!cached || !isJavdbSite(cached.latest) || !Number.isFinite(cached.checkedAt) || !Number.isFinite(cached.attemptedAt)) cached = null;
    if (cached && now < nextDomainCheck(cached) && cached.attemptedAt <= now) return cached;
    let state;
    try {
      let latest = doc ? latestAnnouncement(doc, origin) : null;
      if (!latest) latest = latestAnnouncement(parseHTML(await request(origin + '/')), origin);
      if (!latest) throw Error('没有找到公告中的最新网页域名。');
      state = { latest, checkedAt: now, attemptedAt: now, error: '' };
    } catch (error) {
      state = { latest: cached?.latest || origin, checkedAt: cached?.checkedAt || 0, attemptedAt: now, error: String(error.message || error) };
    }
    // A different tab may have completed a newer check while this request was waiting.
    const published = await storage.get(DOMAIN_STORAGE_KEY, null);
    if (published && isJavdbSite(published.latest) && Number.isFinite(published.checkedAt) && published.checkedAt > state.checkedAt) return published;
    await storage.set(DOMAIN_STORAGE_KEY, state);
    return state;
  }
  function latestPageURL(latest, value) {
    if (!isJavdbSite(latest) || !isJavdbSite(value)) throw Error('不支持的站点域名。');
    const source = new URL(value);
    return new URL(source.pathname + source.search + source.hash, new URL(latest).origin).href;
  }
  class CollectorError extends Error {
    constructor(message, { blocked = false, kind = 'request', retryAt = 0 } = {}) {
      super(message);
      this.name = 'CollectorError';
      this.blocked = blocked;
      this.kind = kind;
      this.retryAt = retryAt;
    }
  }
  const parseError = message => new CollectorError(message, { blocked: true, kind: 'parse' });

  function sourceURL(value) {
    const url = new URL(value);
    url.hash = '';
    url.searchParams.delete('page');
    url.searchParams.sort();
    url.pathname = url.pathname.replace(/\/$/, '') || '/';
    return url.href;
  }

  function magnetKey(value) {
    if (typeof value !== 'string' || /[\r\n\t]/.test(value)) return null;
    let url;
    try { url = new URL(value.trim()); } catch (_) { return null; }
    if (url.protocol.toLowerCase() !== 'magnet:') return null;
    for (const xt of url.searchParams.getAll('xt')) {
      const match = /^urn:btih:([a-f\d]{40}|[a-z2-7]{32})$/i.exec(xt);
      if (match) {
        const raw = match[1].toUpperCase();
        if (raw.length === 40) return 'btih:' + raw.toLowerCase();
        let bits = 0, buffer = 0, hex = '';
        for (const char of raw) {
          buffer = (buffer << 5) | 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(char);
          bits += 5;
          if (bits >= 8) {
            bits -= 8;
            hex += ((buffer >> bits) & 255).toString(16).padStart(2, '0');
          }
        }
        return 'btih:' + hex;
      }
    }
    const v2 = url.searchParams.getAll('xt').find(xt => /^urn:btmh:1220[a-f\d]{64}$/i.test(xt));
    return v2 ? v2.toLowerCase().replace('urn:', '') : null;
  }

  function filenameResolution(name) {
    const values = [];
    for (const m of name.matchAll(/(?:^|[^a-z\d])(\d{3,4})\s*[pi](?=$|[^a-z\d])/gi)) values.push(Number(m[1]));
    for (const m of name.matchAll(/(?:^|[^\d])\d{3,5}\s*[x×]\s*(\d{3,5})(?=$|[^\d])/gi)) values.push(Number(m[1]));
    if (/(?:^|[^a-z\d])8\s*k(?=$|[^a-z\d])/i.test(name)) values.push(4320);
    if (/(?:^|[^a-z\d])4\s*k(?=$|[^a-z\d])|\bUHD\b/i.test(name)) values.push(2160);
    if (/\bFHD\b/i.test(name)) values.push(1080);
    return values.length ? Math.max(...values) : null;
  }

  function classify(candidate) {
    const name = compact(candidate.name);
    const resolution = filenameResolution(name);
    const hd = resolution === null ? !!candidate.siteHD : resolution >= 1080;
    const negativeSub = /(?:无|無)(?:中文字幕|字幕|中字|字)|\bno[ ._-]*sub(?:title)?s?\b/i.test(name);
    const namedSub = /中文字幕|中字|中文(?:硬|软|軟)?字幕|简(?:体|中)|繁(?:体|中)|簡(?:體|中)|繁(?:體|中)|(?:^|[^a-z])(?:chs|cht|chinese)(?=$|[^a-z])|[._-]U?C(?=$|[.\s_\-\[])/i.test(name);
    const sub = !negativeSub && (!!candidate.siteSub || namedSub);
    return { ...candidate, url: candidate.url.trim(), hd, sub, resolution, tier: hd ? (sub ? 0 : 1) : (sub ? 2 : 3) };
  }

  function selectMagnet(candidates) {
    let best = null;
    for (const candidate of candidates) {
      if (!magnetKey(candidate.url)) continue;
      const classified = classify(candidate);
      if (best === null || classified.tier < best.tier) best = classified;
    }
    return best;
  }

  function assertContent(doc) {
    const title = compact(doc.title);
    if (doc.querySelector('#cf-challenge-running, #challenge-form, .cf-turnstile') || /just a moment|attention required|access denied|驗證|验证/i.test(title)) {
      throw new CollectorError('遇到站点验证，请在浏览器中完成验证后继续。', { blocked: true, kind: 'gate' });
    }
    if (doc.querySelector('input[type="password"]') || /\b(?:log ?in|sign ?in)\b|登入|登录/i.test(title)) {
      throw new CollectorError('需要登录，请在站点登录后继续。', { blocked: true, kind: 'gate' });
    }
    if (doc.querySelector('a[href="/over18"]')) {
      throw new CollectorError('请先在站点完成年龄确认，再继续采集。', { blocked: true, kind: 'gate' });
    }
  }

  function nextPageURL(raw, current) {
    const base = new URL(current), next = new URL(raw, current);
    if (next.origin !== base.origin || next.pathname.replace(/\/$/, '') !== base.pathname.replace(/\/$/, '')) throw parseError('分页链接跳到了其他列表，已暂停。');
    for (const [key, value] of base.searchParams) {
      if (key === 'page') continue;
      if (!next.searchParams.has(key)) next.searchParams.append(key, value);
    }
    if (sourceURL(next.href) !== sourceURL(base.href)) throw parseError('分页筛选条件发生变化，已暂停。');
    const page = Number(base.searchParams.get('page') || 1), target = Number(next.searchParams.get('page') || 1);
    if (!Number.isSafeInteger(target) || target !== page + 1) throw parseError('分页页码重复、倒退或跳页，已暂停。');
    next.hash = '';
    next.searchParams.sort();
    return next.href;
  }

  function parseList(doc, url) {
    assertContent(doc);
    const list = doc.querySelector('.movie-list');
    if (!list) throw parseError('未找到影片列表；可能不是作品列表页，或站点结构已改变。');
    const seen = new Set(), movies = [];
    for (const a of list.querySelectorAll('a[href]')) {
      const link = new URL(a.getAttribute('href'), url);
      const match = /^\/v\/([a-z\d]+)\/?$/i.exec(link.pathname);
      if (link.origin !== new URL(url).origin || !match || seen.has(match[1])) continue;
      seen.add(match[1]);
      movies.push({ id: match[1], url: link.origin + '/v/' + match[1], code: compact(a.querySelector('.video-title strong')?.textContent), label: compact(a.querySelector('.video-title')?.textContent || a.textContent).slice(0, 240) });
    }
    const nav = doc.querySelector('nav.pagination, .pagination');
    const current = nav?.querySelector('.pagination-link.is-current');
    const page = Number(new URL(url).searchParams.get('page') || 1);
    if (current && Number(compact(current.textContent)) !== page) throw parseError('返回页码与请求页码不符，已暂停。');
    const enabled = el => el && !el.classList.contains('is-disabled') && !el.hasAttribute('disabled') && el.getAttribute('aria-disabled') !== 'true';
    let next = nav?.querySelector('.pagination-next');
    if (!enabled(next)) next = nav?.querySelector('a[rel~="next"]');
    let nextURL = null;
    if (enabled(next)) {
      const href = next.getAttribute('href');
      if (!href || /^(?:javascript:|#)/i.test(href)) throw parseError('下一页按钮缺少有效链接，已暂停。');
      nextURL = nextPageURL(href, url);
    } else if (nav) {
      const later = [...nav.querySelectorAll('a.pagination-link[href]')].filter(a => Number(compact(a.textContent)) > page);
      if (later.length) {
        later.sort((a, b) => Number(compact(a.textContent)) - Number(compact(b.textContent)));
        nextURL = nextPageURL(later[0].getAttribute('href'), url);
      } else {
        const paginationNodes = [...nav.querySelectorAll('.pagination-link,.pagination-ellipsis')];
        const currentIndex = paginationNodes.findIndex(n => n === current);
        const trailing = paginationNodes.some((n, index) => n.classList.contains('pagination-ellipsis') && (currentIndex === -1 || index > currentIndex));
        if (trailing) throw parseError('当前页之后仍有省略页但缺少下一页，已暂停。');
      }
    }
    if (!movies.length) {
      const text = compact(list.textContent);
      const siblings = [...(list.parentElement?.children || [])].filter(n => n !== list && ['DIV', 'P'].includes(n.tagName) && !n.querySelector('a,input'));
      const emptyMessage = /(?:暂无|暫無|没有|沒有|未找到|找不到|無任何|无任何).{0,12}(?:影片|作品|結果|结果)|no (?:movies|results)(?: found)?/i;
      const loading = /加载|載入|讀取中|读取中|loading/i.test(text) || list.querySelector('.loading,[aria-busy="true"]');
      if (nextURL || loading || ![text, ...siblings.map(n => compact(n.textContent))].some(t => emptyMessage.test(t))) throw parseError('列表为空且没有明确的影片空结果提示，已暂停以避免漏采。');
    }
    return { movies, next: nextURL, title: compact(doc.querySelector('h1,h2,h3')?.textContent || doc.title) };
  }

  function parseDetail(doc) {
    assertContent(doc);
    const detail = doc.querySelector('.video-detail'), container = doc.querySelector('#magnets-content');
    if (!detail || !container) throw parseError('影片详情或磁链区域缺失，已暂停；请检查访问权限及站点结构。');
    const rows = [...container.querySelectorAll('.item')], candidates = [];
    for (const row of rows) {
      const a = row.querySelector('.magnet-name a[href^="magnet:"]');
      if (!a) continue;
      const tags = [...row.querySelectorAll('.magnet-name .tags .tag')].map(n => compact(n.textContent));
      candidates.push({
        url: a.getAttribute('href'), name: compact(a.querySelector('.name')?.textContent || a.textContent),
        siteHD: tags.some(t => /^(?:高清|高畫質|高画质|HD)$/i.test(t)),
        siteSub: tags.some(t => /^(?:字幕|中字|中文字幕|含字幕)$/i.test(t))
      });
    }
    const selected = selectMagnet(candidates);
    if (!selected && (rows.length || container.querySelector('a[href^="magnet:"]'))) throw parseError('磁链区域存在无法识别的资源行，已暂停，未记为“无磁链”。');
    if (!selected && !/(?:暂无|暫無|没有|沒有|尚無|尚无|無|无).{0,12}(?:磁鏈|磁链|資源|资源)|no (?:magnets|resources)/i.test(compact(container.textContent))) throw parseError('磁链区域尚未加载完成或缺少明确的无磁链提示，已暂停。');
    const codeBlock = [...detail.querySelectorAll('.panel-block')].find(n => /^番[号號]/.test(compact(n.querySelector('strong')?.textContent)));
    const code = compact(codeBlock?.querySelector('.value')?.textContent || detail.querySelector('h2 > strong:not(.current-title)')?.textContent);
    return { magnet: selected, code, label: compact(detail.querySelector('h2,h1')?.textContent), candidates: candidates.length };
  }

  function exportEntries(job) {
    const seen = new Set(), lines = [];
    for (const item of job.items) {
      if (item.status !== 'ok') continue;
      const key = magnetKey(item.magnet?.url);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      lines.push({ code: compact(item.code) || '未知番号', url: item.magnet.url.trim() });
    }
    return lines;
  }
  // Default is one bare magnet URI per line so the whole TXT can be pasted into
  // qBittorrent's "add link" box or Xunlei's batch-download dialog unchanged.
  function exportText(job, format = 'magnet') {
    const entries = exportEntries(job);
    if (!entries.length) return '';
    return entries.map(entry => format === 'code' ? entry.code + '  ' + entry.url : entry.url).join('\r\n') + '\r\n';
  }
  async function copyText(text, doc = document) {
    if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
      try { await navigator.clipboard.writeText(text); return; } catch (_) { /* fall back below */ }
    }
    const area = doc.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
    doc.body.appendChild(area);
    area.select();
    let copied = false;
    try { copied = typeof doc.execCommand === 'function' && !!doc.execCommand('copy'); }
    finally { area.remove(); }
    if (!copied) throw Error('浏览器拒绝了剪贴板访问，请改用“导出 TXT”。');
  }

  class QbtError extends Error {
    constructor(message, { status = 0 } = {}) {
      super(message);
      this.name = 'QbtError';
      this.status = status;
    }
  }
  const QBT_DEFAULTS = Object.freeze({ baseUrl: '', apiKey: '', savePath: '', category: '', tags: '', paused: false, skipExisting: true });

  function normalizeQbtUrl(value) {
    const raw = compact(value);
    if (!raw) throw new QbtError('请填写 qBittorrent WebUI 地址。');
    let url;
    try { url = new URL(raw); } catch (_) { throw new QbtError('qBittorrent 地址格式不正确。'); }
    if (!/^https?:$/.test(url.protocol)) throw new QbtError('qBittorrent 地址需以 http:// 或 https:// 开头。');
    if (url.username || url.password) throw new QbtError('地址中不要包含用户名或密码。');
    if (url.search || url.hash) throw new QbtError('地址中不要包含查询参数或片段。');
    return url.origin + url.pathname.replace(/\/+$/, '').replace(/\/api\/v2$/i, '');
  }

  function gmQbtRequest({ method, url, headers, data, timeout = 20000 }) {
    return new Promise((resolve, reject) => {
      if (typeof GM_xmlhttpRequest !== 'function') { reject(new QbtError('当前脚本管理器不支持 GM_xmlhttpRequest，无法推送 qBittorrent。')); return; }
      GM_xmlhttpRequest({
        method, url, headers, data, timeout,
        onload: response => resolve({ status: response.status, text: response.responseText || '' }),
        onerror: () => reject(new QbtError('无法连接 qBittorrent，请检查地址、端口和网络。')),
        ontimeout: () => reject(new QbtError('连接 qBittorrent 超时。')),
        onabort: () => reject(new QbtError('qBittorrent 请求已取消。'))
      });
    });
  }

  function createQbtClient({ base, apiKey, request = gmQbtRequest, timeout = 20000 }) {
    const root = normalizeQbtUrl(base);
    const key = compact(apiKey);
    if (!key) throw new QbtError('请填写 qBittorrent API Key。');
    const call = async (method, path, { data, timeout: callTimeout } = {}) => {
      const headers = { Authorization: 'Bearer ' + key };
      if (data !== undefined) headers['Content-Type'] = 'application/x-www-form-urlencoded';
      let response;
      try {
        response = await request({ method, url: root + '/api/v2' + path, headers, data, timeout: callTimeout || timeout });
      } catch (error) {
        if (error instanceof QbtError) throw error;
        throw new QbtError('无法连接 qBittorrent：' + String(error.message || error));
      }
      if (response.status === 401 || response.status === 403) throw new QbtError('qBittorrent 拒绝访问（HTTP ' + response.status + '），请检查 API Key 和 WebUI 地址。', { status: response.status });
      return response;
    };
    const fail = (response, action) => {
      const detail = String(response.text || '').trim().slice(0, 200);
      if (response.status === 404) throw new QbtError(action + '失败（HTTP 404）：接口不存在，请检查地址是否包含反向代理子路径。', { status: 404 });
      throw new QbtError(action + '失败（HTTP ' + response.status + '）' + (detail ? '：' + detail : ''), { status: response.status });
    };
    return {
      root,
      async version() {
        const response = await call('GET', '/app/version');
        if (response.status < 200 || response.status >= 300) fail(response, '读取版本');
        return compact(response.text) || '未知版本';
      },
      async existingHashes(hashes) {
        const unique = [...new Set(hashes.map(hash => String(hash).toLowerCase()).filter(Boolean))];
        if (!unique.length) return new Set();
        const response = await call('GET', '/torrents/info?hashes=' + encodeURIComponent(unique.join('|')));
        if (response.status < 200 || response.status >= 300) fail(response, '检查已有任务');
        let list;
        try { list = JSON.parse(String(response.text || '').trim()); } catch (_) { throw new QbtError('qBittorrent 返回的任务列表不是有效 JSON。'); }
        if (!Array.isArray(list)) throw new QbtError('qBittorrent 返回的任务列表格式不正确。');
        return new Set(list.map(item => String(item.hash || '').toLowerCase()).filter(Boolean));
      },
      async add(urls, options = {}) {
        const form = new URLSearchParams();
        form.set('urls', urls.join('\n'));
        if (options.savePath) { form.set('savepath', options.savePath); form.set('autoTMM', 'false'); }
        if (options.category) form.set('category', options.category);
        if (options.tags) form.set('tags', options.tags);
        const paused = !!options.paused;
        // 5.x reads "stopped"; 4.x reads "paused". Each version ignores the other key.
        form.set('stopped', String(paused));
        form.set('paused', String(paused));
        const response = await call('POST', '/torrents/add', { data: form.toString(), timeout: 60000 });
        if (response.status === 409) return { success: 0, failure: urls.length, pending: 0, ids: [], conflict: true };
        if (response.status < 200 || response.status >= 300) fail(response, '添加任务');
        const text = String(response.text || '').trim();
        if (/^ok\.?$/i.test(text)) return { success: urls.length, failure: 0, pending: 0, ids: [], conflict: false };
        let data;
        try { data = JSON.parse(text); } catch (_) { throw new QbtError('qBittorrent 返回了无法识别的结果：' + text.slice(0, 160)); }
        if (!data || typeof data !== 'object') throw new QbtError('qBittorrent 返回了无法识别的结果。');
        return {
          success: Number(data.success_count) || 0,
          failure: Number(data.failure_count) || 0,
          pending: Number(data.pending_count) || 0,
          ids: Array.isArray(data.added_torrent_ids) ? data.added_torrent_ids.map(String) : [],
          conflict: false
        };
      }
    };
  }

  async function pushMagnets({ client, urls, savePath = '', category = '', tags = '', paused = false, skipExisting = true, chunkSize = 50, onProgress = () => {} }) {
    const unique = [], failures = [], seen = new Set();
    for (const raw of urls) {
      const key = magnetKey(raw);
      if (!key) { failures.push({ url: '', error: '不是有效的磁链：' + String(raw || '').slice(0, 120) }); continue; }
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push({ url: String(raw).trim(), key });
    }
    const summary = { requested: urls.length, unique: unique.length, added: 0, skipped: 0, failed: failures.length, failures };
    if (!unique.length) return summary;
    let pending = unique;
    if (skipExisting) {
      const existing = new Set();
      for (let index = 0; index < unique.length; index += chunkSize) {
        const chunk = unique.slice(index, index + chunkSize);
        const hashes = chunk.map(item => item.key.startsWith('btih:') ? item.key.slice(5) : '').filter(Boolean);
        if (hashes.length) {
          const found = await client.existingHashes(hashes);
          for (const hash of found) existing.add(hash);
        }
        onProgress({ phase: 'checking', done: Math.min(index + chunkSize, unique.length), total: unique.length, added: 0, skipped: 0, failed: failures.length });
      }
      pending = unique.filter(item => !(item.key.startsWith('btih:') && existing.has(item.key.slice(5))));
      summary.skipped = unique.length - pending.length;
    }
    for (let index = 0; index < pending.length; index += chunkSize) {
      const chunk = pending.slice(index, index + chunkSize);
      try {
        const result = await client.add(chunk.map(item => item.url), { savePath, category, tags, paused });
        if (result.conflict) {
          summary.skipped += chunk.length;
        } else {
          const ids = new Set((result.ids || []).map(id => String(id).toLowerCase()));
          if (ids.size) {
            for (const item of chunk) {
              const hash = item.key.startsWith('btih:') ? item.key.slice(5) : '';
              if (hash && ids.has(hash)) summary.added++;
              else failures.push({ url: item.url, error: 'qBittorrent 未确认添加（可能已存在或磁链无效）' });
            }
          } else {
            summary.added += Math.min(result.success, chunk.length);
            const failed = Math.max(0, chunk.length - result.success);
            for (let count = 0; count < failed; count++) failures.push({ url: '', error: 'qBittorrent 报告本批有任务添加失败' });
          }
        }
      } catch (error) {
        for (const item of chunk) failures.push({ url: item.url, error: String(error.message || error) });
      }
      summary.failed = failures.length;
      onProgress({ phase: 'adding', done: Math.min(index + chunkSize, pending.length), total: pending.length, added: summary.added, skipped: summary.skipped, failed: summary.failed });
    }
    summary.failed = failures.length;
    return summary;
  }

  function pageName(doc, value) {
    const url = new URL(value);
    const explicit = doc.querySelector('h2.title .actor-section-name, h2.title .section-name');
    const cleanTitle = compact(doc.title).replace(/\s*[|｜]\s*JavDB.*$/i, '');
    const base = compact(explicit?.textContent) || cleanTitle || compact(doc.querySelector('h1,h2,h3')?.textContent) || '当前列表';
    const filters = [], missing = [];
    for (const [key, selected] of url.searchParams) {
      if (!/^c\d+$/.test(key)) continue;
      const group = doc.getElementById('tag-category-' + key.slice(1));
      let label = compact(group?.querySelector('.tag.is-info, .tag.is-selected, .tag.is-active')?.textContent);
      if (!label) {
        const control = [...doc.querySelectorAll('input[name],select[name]')].find(n => n.getAttribute('name') === key && (n.tagName === 'SELECT' || n.getAttribute('value') === selected));
        if (control?.tagName === 'SELECT') label = compact([...control.querySelectorAll('option')].find(n => n.getAttribute('value') === selected)?.textContent);
        else if (control) {
          const associated = [...doc.querySelectorAll('label')].find(n => n.getAttribute('for') === control.id);
          label = compact(associated?.textContent || control.closest('label')?.textContent);
        }
      }
      if (!label) { label = key + '=' + selected; missing.push(label); }
      filters.push(label);
    }
    const extra = [...new Set(filters)].filter(label => !base.includes(label));
    return { name: [base, ...extra].join('_'), filters, missing };
  }
  function fileName(value) {
    const safe = compact(value).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '');
    const name = safe || '当前列表';
    if (name.length > 230) throw Error('文件名过长，请在面板中缩短后导出；请保留所需分类名称。');
    return (/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(name) ? '_' : '') + name.replace(/\.txt$/i, '') + '.txt';
  }

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  function createJob(url, title) {
    const source = sourceURL(url);
    return {
      schema: 1, id: (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : Date.now() + '-' + Math.random().toString(36).slice(2),
      source, title: compact(title) || '当前列表', created: Date.now(), updated: Date.now(),
      nextPage: source, pages: [], signatures: [], items: [], status: 'idle', error: '', current: '', retryAt: 0
    };
  }

  function createRequester({ origin, fetchImpl = (...args) => fetch(...args), wait = sleep, now = Date.now, shouldStop = () => false, onStatus = () => {} }) {
    let lastStart = -Infinity;
    const checkPause = () => { if (shouldStop()) throw new CollectorError('已暂停。', { kind: 'pause' }); };
    return async function request(value) {
      const target = new URL(value);
      if (target.origin !== origin || !/^https?:$/.test(target.protocol)) throw new CollectorError('已阻止跨站请求。', { blocked: true });
      for (let attempt = 0; attempt < 3; attempt++) {
        checkPause();
        const gap = 2000 - (now() - lastStart);
        if (gap > 0) await wait(gap);
        checkPause();
        lastStart = now();
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 30000);
        let transient = null;
        try {
          const response = await fetchImpl(target.href, { credentials: 'same-origin', cache: 'no-store', redirect: 'follow', signal: controller.signal });
          const final = new URL(response.url || target.href);
          if (final.origin !== origin || sourceURL(final.href) !== sourceURL(target.href) || (final.searchParams.get('page') || '1') !== (target.searchParams.get('page') || '1')) {
            throw new CollectorError('请求被重定向到其他页面；请检查登录、验证或站点域名后继续。', { blocked: true, kind: 'gate' });
          }
          if (response.status === 429) {
            const raw = response.headers.get('Retry-After');
            const numeric = raw && /^\d+$/.test(raw.trim());
            const parsed = raw ? Date.parse(raw) : NaN;
            const retryAt = numeric ? now() + Number(raw) * 1000 : (Number.isFinite(parsed) ? Math.max(now(), parsed) : now() + 60000);
            throw new CollectorError('站点限流（429），请等待冷却后继续。', { blocked: true, kind: 'rate', retryAt });
          }
          if (response.status === 401 || response.status === 403) throw new CollectorError(`站点拒绝访问（${response.status}），请在浏览器检查登录或验证后继续。`, { blocked: true, kind: 'gate' });
          if (!response.ok) throw new CollectorError(`HTTP ${response.status}`, { kind: response.status >= 500 ? 'transient' : 'http' });
          const type = response.headers.get('Content-Type') || '';
          if (type && !/text\/html|application\/xhtml\+xml/i.test(type)) throw parseError('站点返回的不是 HTML 页面，已暂停。');
          return await response.text();
        } catch (error) {
          if (error.blocked || error.kind === 'http' || error.kind === 'pause') throw error;
          transient = error;
        } finally {
          clearTimeout(timer);
        }
        if (attempt === 2) throw new CollectorError(`请求失败（已尝试 3 次）：${transient.message || transient}`);
        const delay = attempt === 0 ? 5000 : 15000;
        onStatus(`请求失败，${delay / 1000} 秒后重试（${attempt + 2}/3）。`);
        await wait(delay);
        checkPause();
      }
    };
  }

  class Collector {
    constructor({ request, parseHTML, save, onChange = () => {} }) {
      this.request = request;
      this.parseHTML = parseHTML;
      this.save = save;
      this.onChange = onChange;
      this.stopped = false;
      this.busy = false;
    }
    pause() { this.stopped = true; }
    async persist(job) {
      job.updated = Date.now();
      try { await this.save(job); }
      catch (error) { throw new CollectorError(`进度保存失败：${error.message || error}。已停止请求，可先导出内存中的结果。`, { blocked: true, kind: 'storage' }); }
      this.onChange(job);
    }
    async run(job, { retryFailed = false } = {}) {
      if (this.busy) throw new CollectorError('该任务正在运行。', { blocked: true });
      this.busy = true;
      this.stopped = false;
      try {
        job.status = 'running';
        job.error = '';
        job.retryAt = 0;
        if (retryFailed) for (const item of job.items) if (item.status === 'failed') { item.status = 'pending'; item.error = ''; }
        await this.persist(job);
        const ids = new Set(job.items.map(item => item.id));
        while (job.nextPage && !this.stopped) {
          const pageURL = job.nextPage;
          if (job.pages.includes(pageURL)) throw parseError('分页链接重复，已暂停。');
          job.current = `读取列表第 ${job.pages.length + 1} 页`;
          this.onChange(job);
          const result = parseList(this.parseHTML(await this.request(pageURL)), pageURL);
          const signature = result.movies.map(movie => movie.id).join('|');
          if (signature && job.signatures.includes(signature)) throw parseError('不同分页返回了重复影片列表，已暂停，未视为采集结束。');
          for (const movie of result.movies) if (!ids.has(movie.id)) {
            ids.add(movie.id);
            job.items.push({ ...movie, status: 'pending', magnet: null, error: '' });
          }
          job.pages.push(pageURL);
          job.signatures.push(signature);
          job.nextPage = result.next;
          await this.persist(job);
        }
        if (!job.nextPage) for (let index = 0; index < job.items.length && !this.stopped; index++) {
          const item = job.items[index];
          if (item.status !== 'pending') continue;
          job.current = `处理影片 ${index + 1}/${job.items.length}：${item.label || item.id}`;
          this.onChange(job);
          let result;
          try { result = parseDetail(this.parseHTML(await this.request(item.url)), item.url); }
          catch (error) {
            if (error.blocked || error.kind === 'pause') throw error;
            item.status = 'failed';
            item.error = String(error.message || error);
          }
          if (result) {
            item.status = result.magnet ? 'ok' : 'none';
            item.magnet = result.magnet;
            if (result.code) item.code = result.code;
            item.error = '';
          }
          await this.persist(job);
        }
        job.status = this.stopped ? 'paused' : (job.items.some(item => item.status === 'failed') ? 'partial' : 'completed');
        job.current = '';
        await this.persist(job);
      } catch (error) {
        job.status = error.kind === 'pause' ? 'paused' : 'blocked';
        job.error = error.kind === 'pause' ? '' : String(error.message || error);
        job.retryAt = error.retryAt || 0;
        if (error.kind !== 'storage') {
          try { await this.persist(job); }
          catch (savingError) { job.error += '；' + savingError.message; }
        }
        this.onChange(job);
      } finally {
        this.busy = false;
      }
      return job;
    }
  }

  const jobStorageKey = source => 'javdb-collector:v1:job:' + sourceURL(source);
  const lastStorageKey = origin => 'javdb-collector:v1:last:' + origin;
  function mirrorIndexKey(source) {
    return 'javdb-collector:v1:mirror:' + sourceURL(latestPageURL('https://javdb.com', source));
  }
  function validateJob(job, source, origin) {
    if (!job || job.schema !== 1 || typeof job.id !== 'string' || job.source !== source || !Array.isArray(job.pages) || !Array.isArray(job.signatures) || !Array.isArray(job.items)) throw Error('保存的任务损坏或版本不兼容，请先保留已有存储数据。');
    if (new URL(source).origin !== origin || (job.nextPage && sourceURL(job.nextPage) !== source)) throw Error('保存的任务来源不兼容。');
    for (const item of job.items) {
      if (!item.id || new URL(item.url).origin !== origin || !['pending', 'ok', 'none', 'failed'].includes(item.status)) throw Error('保存的影片记录损坏。');
    }
    return job;
  }
  function rebaseJob(job, origin) {
    if (!isJavdbSite(job.source) || !isJavdbSite(origin)) throw Error('任务域名来源不兼容。');
    const oldOrigin = new URL(job.source).origin;
    validateJob(job, job.source, oldOrigin);
    const copy = JSON.parse(JSON.stringify(job));
    const rewrite = value => {
      if (new URL(value).origin !== oldOrigin) throw Error('保存的任务包含不兼容的域名来源。');
      return latestPageURL(origin, value);
    };
    copy.source = sourceURL(rewrite(copy.source));
    copy.nextPage = copy.nextPage ? rewrite(copy.nextPage) : null;
    copy.pages = copy.pages.map(rewrite);
    for (const item of copy.items) item.url = rewrite(item.url);
    return validateJob(copy, copy.source, origin);
  }
  async function loadJob(storage, value) {
    const source = sourceURL(value), origin = new URL(source).origin;
    const local = await storage.get(jobStorageKey(source), null);
    if (local) return validateJob(local, source, origin);
    if (!isJavdbSite(source)) return null;
    const indexed = await storage.get(mirrorIndexKey(source), null);
    const candidates = [indexed, latestPageURL('https://javdb.com', source), latestPageURL('https://www.javdb.com', source)].filter(Boolean);
    for (const oldSource of [...new Set(candidates)]) {
      if (!isJavdbSite(oldSource) || mirrorIndexKey(oldSource) !== mirrorIndexKey(source)) continue;
      const oldJob = await storage.get(jobStorageKey(oldSource), null);
      if (oldJob) return rebaseJob(validateJob(oldJob, sourceURL(oldSource), new URL(oldSource).origin), origin);
    }
    return null;
  }
  async function saveJob(storage, job) {
    await storage.set(jobStorageKey(job.source), job);
    if (isJavdbSite(job.source)) await storage.set(mirrorIndexKey(job.source), job.source);
  }
  function defaultStorage() {
    return {
      async get(key, fallback = null) {
        const raw = await GM_getValue(key, null);
        return raw === null ? fallback : JSON.parse(raw);
      },
      async set(key, value) { await GM_setValue(key, JSON.stringify(value)); }
    };
  }
  function downloadTXT(text, name, doc = document) {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
    const link = doc.createElement('a');
    link.href = url;
    link.download = name;
    doc.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  async function mount(options = {}) {
    const doc = options.document || document;
    const loc = options.location || window.location;
    const origin = loc.origin;
    if (!options.document && !isJavdbSite(loc.href)) return null;
    if (doc.getElementById('javdb-collector-panel')) return null;
    const parseHTML = options.parseHTML || (text => new DOMParser().parseFromString(text, 'text/html'));
    const storage = options.storage || defaultStorage();
    const locks = options.locks || navigator.locks;
    const download = options.download || ((text, name) => downloadTXT(text, name, doc));
    const copy = options.copy || (text => copyText(text, doc));
    const ask = options.confirm || (message => window.confirm(message));
    const eligible = !!doc.querySelector('.movie-list') && !/^\/v\//.test(loc.pathname);
    const currentSource = sourceURL(loc.href);
    const nameInfo = pageName(doc, loc.href);
    const currentTitle = nameInfo.name;
    const host = doc.createElement('div');
    host.id = 'javdb-collector-panel';
    // Shadow DOM isolates the panel from site styles and keeps scraped text inert.
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>
        :host{all:initial;position:fixed;z-index:2147483000;right:16px;bottom:16px;width:min(368px,calc(100vw - 32px));color-scheme:light dark;font-family:system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;font-size:14px;line-height:1.6}
        *{box-sizing:border-box} .panel{--bg:#fff;--fg:#172033;--muted:#536177;--line:#d9e1ed;--accent:#1555b5;background:var(--bg);color:var(--fg);border:1px solid var(--line);border-radius:14px;box-shadow:0 8px 32px #0003;overflow:hidden}
        header{display:flex;align-items:center;justify-content:space-between;padding:6px 10px 6px 16px;border-bottom:1px solid var(--line)}
        header strong{font-size:15px}button{font:inherit;min-height:44px;padding:8px 12px;border:1px solid var(--line);border-radius:8px;color:var(--fg);background:var(--bg);cursor:pointer}
        button:hover:enabled{border-color:var(--accent);background:#edf4ff;color:#133b76}button:focus-visible,a:focus-visible,summary:focus-visible{outline:3px solid #438af4;outline-offset:2px}button:disabled{opacity:.5;cursor:default}
        header button{border:0;min-width:58px}main{padding:14px 16px;max-height:min(630px,75vh);overflow:auto}p{margin:0 0 10px}.muted{color:var(--muted);font-size:12px}.source{font-weight:600;overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
        .state{font-weight:650}.error{color:#a3221d;background:#fff1f0;border-radius:7px;padding:8px;white-space:pre-wrap;overflow-wrap:anywhere}.error.success{color:#17613d;background:#eaf8ef}.error:empty{display:none}.counts{font-variant-numeric:tabular-nums;font-size:13px}label{display:block;font-size:12px;color:var(--muted);margin:8px 0 4px}input,select{font:inherit;width:100%;min-height:40px;padding:7px 9px;border:1px solid var(--line);border-radius:7px;background:var(--bg);color:var(--fg);margin-bottom:10px}
        progress{display:block;width:100%;height:9px;margin:8px 0 12px;accent-color:var(--accent)}.actions{display:grid;grid-template-columns:1fr 1fr;gap:8px}.primary{background:var(--accent);border-color:var(--accent);color:#fff}.primary:hover:enabled{background:#10438f;color:#fff}
        .wide{grid-column:1/-1}details{margin-top:12px;font-size:12px}summary{cursor:pointer;min-height:32px}ul{margin:4px 0;padding-left:20px;max-height:150px;overflow:auto}li{margin:6px 0;overflow-wrap:anywhere}a{color:var(--accent);overflow-wrap:anywhere}a[hidden],main[hidden]{display:none}.foot{margin:12px 0 0;font-size:12px;color:var(--muted)}
        input[type="checkbox"]{width:auto;min-height:0;margin:0;padding:0;accent-color:var(--accent)}.check{display:flex;align-items:center;gap:7px;margin:7px 0;color:var(--fg);font-size:13px}.check input{margin:0}.qbt-status{font-size:12px;color:var(--muted);white-space:pre-wrap;overflow-wrap:anywhere;margin:6px 0}.qbt-status.bad{color:#a3221d}.qbt-failures{max-height:120px;overflow:auto;font-size:12px}
        @media(prefers-color-scheme:dark){.panel{--bg:#192232;--fg:#f0f4fb;--muted:#b7c5db;--line:#3d4c62;--accent:#91bbff}.primary{background:#2866bf;border-color:#2866bf;color:#fff}.error{background:#472525;color:#ffc3bb}.error.success{background:#1b3e2d;color:#b4f2cd}button:hover:enabled{background:#263c5b;color:#fff}}
        @media(max-width:440px){:host{right:10px;bottom:10px;width:calc(100vw - 20px)}main{max-height:65vh}}
      </style>
      <section class="panel" aria-label="JavDB 磁链采集">
        <header><strong>JavDB 磁链采集</strong><button type="button" data-action="collapse" aria-expanded="true" aria-controls="collector-body">收起</button></header>
        <main id="collector-body">
          <p class="source" data-field="title"></p>
          <p class="muted" data-field="scope"></p>
          <p class="state" data-field="status" role="status" aria-atomic="true">正在读取已保存任务…</p>
          <p class="counts" data-field="counts"></p>
          <progress data-field="progress" aria-label="影片处理进度" max="1" value="0"></progress>
          <p class="muted" data-field="current"></p>
          <p class="error" data-field="error"></p>
          <p><a data-field="problem-link" target="_blank" rel="noopener noreferrer" hidden>打开待处理页面检查</a></p>
          <label for="collector-filename">TXT 文件名（自动使用页面名称，可修改）</label><input id="collector-filename" data-field="filename" type="text" autocomplete="off">
          <label for="collector-format">导出格式</label><select id="collector-format" data-field="format">
            <option value="magnet">每行一条磁链（qBittorrent / 迅雷批量下载）</option>
            <option value="code">番号 + 磁链（每行一条，便于核对）</option>
          </select>
          <details data-field="qbt-settings">
            <summary>qBittorrent 推送设置（5.2+，可选）</summary>
            <p class="muted">API Key 在 qBittorrent 设置 → WebUI → API Key 生成；密钥只保存在本机油猴存储。</p>
            <label for="qbt-url">WebUI 地址</label>
            <input id="qbt-url" data-field="qbt-url" type="url" placeholder="http://192.168.1.10:8080" autocomplete="off">
            <label for="qbt-key">API Key</label>
            <input id="qbt-key" data-field="qbt-key" type="password" placeholder="qbt_..." autocomplete="off">
            <label for="qbt-savepath">保存路径（留空使用 qBittorrent 默认路径）</label>
            <input id="qbt-savepath" data-field="qbt-savepath" type="text" placeholder="/downloads/JavDB" autocomplete="off">
            <label for="qbt-category">分类（留空不分类）</label>
            <input id="qbt-category" data-field="qbt-category" type="text" placeholder="JavDB" autocomplete="off">
            <label for="qbt-tags">标签（逗号分隔，留空不添加）</label>
            <input id="qbt-tags" data-field="qbt-tags" type="text" placeholder="javdb" autocomplete="off">
            <label class="check"><input type="checkbox" data-field="qbt-paused"> 添加后暂停，不自动下载</label>
            <label class="check"><input type="checkbox" data-field="qbt-skip" checked> 跳过 qBittorrent 中已存在的任务</label>
            <div class="actions">
              <button type="button" data-action="qbt-test">测试连接</button>
              <button type="button" data-action="qbt-save">保存设置</button>
            </div>
            <p class="qbt-status" data-field="qbt-status"></p>
            <ul class="qbt-failures" data-field="qbt-failures"></ul>
          </details>
          <div class="actions">
            <button type="button" data-action="start" class="primary">开始采集</button>
            <button type="button" data-action="pause" disabled>暂停</button>
            <button type="button" data-action="resume" disabled>继续采集</button>
            <button type="button" data-action="retry" disabled>重试失败项</button>
            <button type="button" data-action="export" class="wide" disabled>导出 TXT</button>
            <button type="button" data-action="copy" class="wide" disabled>复制磁链（可直接粘贴批量下载）</button>
            <button type="button" data-action="push" class="wide" disabled>推送 qBittorrent</button>
          </div>
          <details><summary data-field="failure-summary">问题与失败项</summary><ul data-field="failures"></ul></details>
          <p class="foot">优先：高清＋中字 → 高清 → 中字 → 第一条。名称明确时以 1080P 为高清门槛，否则用站点标签。串行请求，间隔至少 2 秒。</p>
          <p class="foot">导出默认每行一条磁链，可直接粘贴到 qBittorrent 或迅雷批量下载。</p>
          <p class="foot" data-field="domain-status">最新地址：正在检查…</p>
          <p class="foot"><a data-field="latest-link" target="_blank" rel="noopener noreferrer" hidden></a></p>
        </main>
      </section>`;
    doc.documentElement.appendChild(host);
    const field = name => root.querySelector(`[data-field="${name}"]`);
    const button = name => root.querySelector(`[data-action="${name}"]`);
    let job = null, engine = null, busy = false, notice = '', noticeKind = 'error', ready = false, storageBroken = false;
    let qbtConfig = { ...QBT_DEFAULTS }, qbtMessage = '', qbtBad = false, pushing = false, pushFailures = [];
    field('filename').value = currentTitle;
    const states = { idle: '待开始', running: '正在采集', paused: '已暂停', blocked: '已暂停，需要处理', partial: '部分完成，有失败项', completed: '采集完成' };
    function readQbtSettings() {
      return {
        baseUrl: field('qbt-url').value.trim(),
        apiKey: field('qbt-key').value.trim(),
        savePath: field('qbt-savepath').value.trim(),
        category: field('qbt-category').value.trim(),
        tags: field('qbt-tags').value.trim(),
        paused: !!field('qbt-paused').checked,
        skipExisting: !!field('qbt-skip').checked
      };
    }
    function fillQbtSettings() {
      field('qbt-url').value = qbtConfig.baseUrl || '';
      field('qbt-key').value = qbtConfig.apiKey || '';
      field('qbt-savepath').value = qbtConfig.savePath || '';
      field('qbt-category').value = qbtConfig.category || '';
      field('qbt-tags').value = qbtConfig.tags || '';
      field('qbt-paused').checked = !!qbtConfig.paused;
      field('qbt-skip').checked = qbtConfig.skipExisting !== false;
    }
    async function saveQbtSettings(config = readQbtSettings()) {
      qbtConfig = config;
      try { await storage.set(QBT_STORAGE_KEY, config); return true; }
      catch (error) { qbtMessage = '保存 qBittorrent 设置失败：' + (error.message || error); qbtBad = true; render(); return false; }
    }
    async function testQbt() {
      if (pushing) return;
      field('qbt-settings').open = true;
      const config = readQbtSettings();
      qbtMessage = '正在连接 qBittorrent…'; qbtBad = false; render();
      try {
        const client = createQbtClient({ base: config.baseUrl, apiKey: config.apiKey, request: options.qbtRequest || gmQbtRequest });
        const version = await client.version();
        if (!await saveQbtSettings(config)) return;
        qbtMessage = '连接成功：qBittorrent ' + version;
      } catch (error) { qbtMessage = '连接失败：' + String(error.message || error); qbtBad = true; }
      render();
    }
    async function pushQbt() {
      if (pushing || !job) return;
      field('qbt-settings').open = true;
      const config = readQbtSettings();
      const entries = exportEntries(job);
      if (!entries.length) { qbtMessage = '当前没有可推送的磁链。'; qbtBad = true; render(); return; }
      let client;
      try { client = createQbtClient({ base: config.baseUrl, apiKey: config.apiKey, request: options.qbtRequest || gmQbtRequest }); }
      catch (error) { qbtMessage = '无法推送：' + String(error.message || error); qbtBad = true; render(); return; }
      const destination = (config.savePath ? '保存到 ' + config.savePath : '使用 qBittorrent 默认路径') + '，' + (config.category ? '分类 ' + config.category : '不分类') + (config.paused ? '，添加后暂停' : '，自动开始下载');
      if (!ask(`将 ${entries.length} 条磁链推送到 qBittorrent（${destination}）？`)) return;
      pushing = true; pushFailures = []; qbtBad = false;
      qbtMessage = `准备推送 ${entries.length} 条磁链…`;
      render();
      try {
        if (!await saveQbtSettings(config)) return;
        const summary = await pushMagnets({
          client, urls: entries.map(entry => entry.url),
          savePath: config.savePath, category: config.category, tags: config.tags,
          paused: config.paused, skipExisting: config.skipExisting,
          onProgress: progress => {
            qbtMessage = progress.phase === 'checking'
              ? `检查已存在：${progress.done}/${progress.total}…`
              : `推送中：${progress.done}/${progress.total} · 成功 ${progress.added} · 跳过 ${progress.skipped} · 失败 ${progress.failed}`;
            render();
          }
        });
        const codeByUrl = new Map(entries.map(entry => [entry.url, entry.code]));
        pushFailures = summary.failures.map(failure => ({ code: failure.url ? codeByUrl.get(failure.url) || '' : '', url: failure.url, error: failure.error }));
        const parts = [`成功 ${summary.added} 条`];
        if (summary.skipped) parts.push(`跳过 ${summary.skipped} 条`);
        if (summary.failed) parts.push(`失败 ${summary.failed} 条`);
        qbtMessage = `qBittorrent 推送完成：${parts.join('，')}。`;
        qbtBad = summary.failed > 0;
        noticeKind = qbtBad ? 'error' : 'success';
        notice = qbtBad ? qbtMessage + ' 详情见推送设置。' : qbtMessage;
      } catch (error) {
        qbtMessage = '推送失败：' + String(error.message || error);
        qbtBad = true;
        noticeKind = 'error'; notice = qbtMessage;
      } finally {
        pushing = false;
        render();
      }
    }
    function render() {
      const items = job?.items || [];
      const selected = items.filter(item => item.status === 'ok').length;
      const none = items.filter(item => item.status === 'none').length;
      const failed = items.filter(item => item.status === 'failed');
      const done = selected + none + failed.length;
      const unique = job ? exportEntries(job).length : 0;
      field('title').textContent = job?.title || currentTitle || '当前页面';
      field('scope').textContent = eligible ? '当前列表全部分页 · 保留筛选与排序 · 每部一条' : '请打开排行榜、清单、演员、片商或番号前缀作品列表；已保存任务仍可继续或导出。';
      field('status').textContent = !ready ? '正在读取已保存任务…' : (busy && engine?.stopped ? '正在暂停，当前请求保存后停止…' : (job?.status === 'running' && !busy ? '已恢复保存的任务，可继续采集' : states[job?.status] || '准备就绪'));
      field('counts').textContent = `分页已读 ${job?.pages.length || 0} · 影片 ${done}/${items.length}\n已选 ${selected} · 去重后 ${unique} · 无磁链 ${none} · 失败 ${failed.length}`;
      field('counts').style.whiteSpace = 'pre-line';
      field('current').textContent = busy ? job?.current || '' : (job?.nextPage ? '分页尚未全部读取，继续时会从未完成页恢复。' : (job?.status === 'completed' && !unique ? '任务已完成，没有可导出的磁链。' : ''));
      field('error').textContent = [notice, job?.error, nameInfo.missing.length ? '未识别的分类名称：' + nameInfo.missing.join('、') + '。请在文件名中补充。' : ''].filter(Boolean).join('\n');
      field('error').classList.toggle('success', noticeKind === 'success' && !job?.error && !nameInfo.missing.length);
      const progress = field('progress');
      progress.max = Math.max(1, items.length);
      if (busy && job?.nextPage) progress.removeAttribute('value'); else progress.value = done;
      button('start').disabled = !ready || busy || !eligible || storageBroken;
      button('start').textContent = job && job.source === currentSource ? '重新采集' : '开始采集';
      button('pause').disabled = !busy || !engine || engine.stopped;
      button('resume').disabled = !ready || busy || !job || job.status === 'completed' || storageBroken;
      button('retry').disabled = !ready || busy || !failed.length || storageBroken;
      button('export').disabled = unique === 0;
      button('export').textContent = job?.status === 'completed' ? '导出 TXT' : '导出已有结果 TXT（未完成）';
      button('copy').disabled = unique === 0;
      const qbtReady = !!field('qbt-url').value.trim() && !!field('qbt-key').value.trim();
      button('push').disabled = !ready || pushing || unique === 0 || !qbtReady;
      button('push').textContent = pushing ? '正在推送 qBittorrent…' : '推送 qBittorrent';
      button('push').title = qbtReady ? '把当前磁链推送到 qBittorrent' : '请先在“qBittorrent 推送设置”中填写 WebUI 地址和 API Key';
      button('qbt-test').disabled = pushing;
      button('qbt-save').disabled = pushing;
      field('qbt-status').textContent = qbtMessage;
      field('qbt-status').classList.toggle('bad', qbtBad);
      const qbtFailures = field('qbt-failures');
      qbtFailures.textContent = '';
      for (const failure of pushFailures.slice(0, 50)) {
        const li = doc.createElement('li');
        li.textContent = (failure.code ? failure.code + '：' : '') + failure.error;
        qbtFailures.appendChild(li);
      }
      if (pushFailures.length > 50) { const li = doc.createElement('li'); li.textContent = '仅展示前 50 条失败记录。'; qbtFailures.appendChild(li); }
      field('failure-summary').textContent = `问题与失败项（${failed.length}${job?.error ? '，任务已暂停' : ''}）`;
      const failures = field('failures');
      failures.textContent = '';
      for (const item of failed.slice(0, 100)) {
        const li = doc.createElement('li'), a = doc.createElement('a');
        a.href = item.url; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.textContent = item.label || item.id;
        li.append(a, doc.createTextNode('：' + item.error)); failures.appendChild(li);
      }
      if (failed.length > 100) { const li = doc.createElement('li'); li.textContent = '仅展示前 100 项；“重试失败项”将处理所有失败项。'; failures.appendChild(li); }
      const problem = field('problem-link');
      problem.hidden = !job?.error;
      if (job?.error) problem.href = job.nextPage || items.find(item => item.status === 'pending')?.url || job.source;
    }
    render();
    const save = value => saveJob(storage, value);
    let domainPending = null, domainTimer = null;
    const schedule = options.schedule || ((fn, ms) => { const timer = setTimeout(fn, ms); timer.unref?.(); return timer; });
    const unschedule = options.unschedule || clearTimeout;
    const now = options.now || Date.now;
    const domainRequest = options.domainRequest || (async url => {
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15000);
      try {
        const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
        if (!response.ok || new URL(response.url).origin !== origin) throw Error('公告访问失败（' + response.status + '），稍后自动重试。');
        return await response.text();
      } finally { clearTimeout(timer); }
    });
    async function checkDomain(useCurrentDocument = false) {
      if (!isJavdbSite(loc.href)) { field('domain-status').textContent = '域名自动检查仅在 JavDB 网页运行。'; return; }
      if (!host.isConnected || domainPending) return;
      unschedule(domainTimer);
      if (busy) { domainTimer = schedule(() => { void checkDomain(); }, 60000); return; }
      let delay = 3600000;
      domainPending = (async () => {
        try {
          const state = await syncLatestDomain({ storage, document: useCurrentDocument ? doc : null, origin, request: domainRequest, parseHTML, now: now() });
          const link = field('latest-link');
          link.href = latestPageURL(state.latest, loc.href); link.textContent = (state.error ? '已知站点（待核对）：' : '最新站点：') + new URL(state.latest).hostname; link.hidden = false;
          field('domain-status').textContent = state.error ? '最新地址检查失败，沿用已知地址；1 小时后自动重试。' : '最新地址已核对，每 24 小时自动更新。';
          delay = Math.max(1000, nextDomainCheck(state) - now());
        } catch (error) { field('domain-status').textContent = '最新地址检查暂不可用：' + error.message; }
      })();
      await domainPending;
      domainPending = null;
      if (host.isConnected) domainTimer = schedule(() => { void checkDomain(); }, delay);
    }
    async function execute(mode) {
      if (busy || !ready || storageBroken) return;
      busy = true; notice = ''; noticeKind = 'error'; render();
      try {
        if (domainPending) await domainPending;
        if (!locks?.request) throw Error('当前浏览器不支持安全任务锁，请使用新版 Chrome 或 Edge。');
        await locks.request('javdb-collector:' + origin, { ifAvailable: true, mode: 'exclusive' }, async lock => {
          if (!lock) throw Error('另一个标签页正在采集，请先在那个标签页暂停或关闭它。');
          if (mode === 'new') {
            if (!eligible) throw Error('请打开影片作品列表。');
            parseList(doc, loc.href);
            const existing = await loadJob(storage, currentSource);
            if (existing && !ask('将重新采集当前列表并替换该列表的已保存进度。请先导出需要保留的结果。继续？')) return;
            if (existing?.retryAt > Date.now()) throw Error('该列表仍在限流冷却中，请稍后继续已有任务。');
            job = createJob(currentSource, currentTitle);
          } else {
            const stored = await loadJob(storage, job.source);
            if (stored) job = validateJob(stored, job.source, origin);
            if (job.retryAt > Date.now()) throw Error(`仍在限流冷却中，请在 ${new Date(job.retryAt).toLocaleTimeString()} 后继续。`);
          }
          await storage.set(lastStorageKey(origin), job.source);
          if (isJavdbSite(job.source)) await storage.set(FAMILY_LAST_KEY, job.source);
          engine = new Collector({ parseHTML, save, onChange: value => { job = value; render(); }, request: options.request || createRequester({
            origin, shouldStop: () => engine.stopped,
            wait: async ms => { const until = Date.now() + ms; while (Date.now() < until && !engine.stopped) await sleep(Math.min(200, until - Date.now())); },
            onStatus: message => { notice = message; render(); }
          }) });
          await engine.run(job, { retryFailed: mode === 'retry' });
        });
      } catch (error) { notice = String(error.message || error); }
      finally { busy = false; engine = null; render(); }
    }
    button('start').addEventListener('click', () => { void execute('new'); });
    button('resume').addEventListener('click', () => { void execute('resume'); });
    button('retry').addEventListener('click', () => { void execute('retry'); });
    button('pause').addEventListener('click', () => { engine?.pause(); render(); });
    button('collapse').addEventListener('click', () => {
      const body = root.querySelector('main'); body.hidden = !body.hidden;
      button('collapse').textContent = body.hidden ? '展开' : '收起';
      button('collapse').setAttribute('aria-expanded', String(!body.hidden));
    });
    button('export').addEventListener('click', () => {
      if (!job) return;
      const format = field('format').value === 'code' ? 'code' : 'magnet';
      const text = exportText(job, format);
      if (!text) return;
      try {
        download(text, fileName(field('filename').value || job.title));
        noticeKind = 'success';
        notice = format === 'magnet'
          ? '已导出纯磁链 TXT（每行一条），可直接全选复制到 qBittorrent 或迅雷批量下载。'
          : '已导出番号 + 磁链 TXT，请查看浏览器下载文件夹。';
        if (job.status !== 'completed') notice += '任务尚未完成，可继续采集后再次导出。';
        render();
      }
      catch (error) { noticeKind = 'error'; notice = '导出失败：' + error.message; render(); }
    });
    button('copy').addEventListener('click', async () => {
      if (!job) return;
      const text = exportText(job);
      if (!text) return;
      try {
        await copy(text);
        noticeKind = 'success';
        notice = '已复制 ' + exportEntries(job).length + ' 条磁链，可直接粘贴到 qBittorrent 或迅雷批量下载。';
        if (job.status !== 'completed') notice += '任务尚未完成，仅包含当前已有结果。';
      } catch (error) { noticeKind = 'error'; notice = '复制失败：' + error.message; }
      render();
    });
    button('qbt-save').addEventListener('click', async () => {
      field('qbt-settings').open = true;
      if (await saveQbtSettings()) { qbtBad = false; qbtMessage = 'qBittorrent 设置已保存。'; render(); }
    });
    button('qbt-test').addEventListener('click', () => { void testQbt(); });
    button('push').addEventListener('click', () => { void pushQbt(); });
    for (const name of ['qbt-url', 'qbt-key']) field(name).addEventListener('input', () => render());
    try {
      let source = eligible ? currentSource : await storage.get(lastStorageKey(origin), null);
      if (!source && !eligible && isJavdbSite(loc.href)) {
        const oldSource = await storage.get(FAMILY_LAST_KEY, null) || await storage.get(lastStorageKey('https://javdb.com'), null) || await storage.get(lastStorageKey('https://www.javdb.com'), null);
        if (oldSource && isJavdbSite(oldSource)) source = latestPageURL(origin, oldSource);
      }
      if (source) {
        const stored = await loadJob(storage, source);
        if (stored) { job = validateJob(stored, source, origin); field('filename').value = job.title; }
      }
    } catch (error) { storageBroken = true; notice = '读取已保存任务失败：' + error.message; }
    try {
      const storedQbt = await storage.get(QBT_STORAGE_KEY, null);
      if (storedQbt && typeof storedQbt === 'object') { qbtConfig = { ...QBT_DEFAULTS, ...storedQbt }; fillQbtSettings(); }
    } catch (error) { qbtBad = true; qbtMessage = '读取 qBittorrent 设置失败：' + (error.message || error); }
    ready = true; render();
    void checkDomain(true);
    doc.addEventListener('visibilitychange', () => { if (doc.visibilityState === 'visible') void checkDomain(); });
    return { host };
  }

  return { sourceURL, magnetKey, selectMagnet, parseList, parseDetail, exportText, exportEntries, copyText, pageName, fileName, CollectorError, QbtError, normalizeQbtUrl, createQbtClient, pushMagnets, createJob, createRequester, Collector, mount, jobStorageKey, validateJob, isJavdbSite, latestAnnouncement, nextDomainCheck, syncLatestDomain, latestPageURL, rebaseJob, loadJob, saveJob, DOMAIN_STORAGE_KEY, QBT_STORAGE_KEY };
});
