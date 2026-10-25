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
