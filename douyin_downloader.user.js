// ==UserScript==
// @name         抖音一键下载（本地服务）
// @namespace    local.douyin.downloader
// @version      1.3.2
// @description  抖音一键下载、复制 UID、指定归档、快捷键 C、自动连播挂机（调用本机 127.0.0.1:5001）
// @author       local
// @match        https://douyin.com/*
// @match        https://*.douyin.com/*
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      127.0.0.1
// @connect      localhost
// @run-at       document-start
// @sandbox      raw
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  const API_BASE = 'http://127.0.0.1:5001';
  const HOST_ID = 'dy-local-downloader-host';
  const MODAL_HOST_ID = 'dy-local-downloader-modal';
  const POLL_INTERVAL_MS = 1000;
  const POLL_TIMEOUT_MS = 5 * 60 * 1000;

  class HttpError extends Error {
    constructor(message, status) {
      super(message);
      this.name = 'HttpError';
      this.status = status;
    }
  }

  let ui = null;
  let pollGeneration = 0;
  let toastTimer = 0;
  let busy = false;
  let copyBusy = false;
  let archiveBusy = false;
  let folders = [];
  let filteredFolders = [];
  let selectedFolder = '';
  let activeFolderIndex = -1;
  let modalMode = null;
  let archiveSubmitting = false;
  let shortcutEnabled = true;
  let shortcutDebounceTimer = 0;
  let suppressSyntheticShortcut = false;
  let autoLoopRunning = false;
  let autoLoopToken = 0;
  let autoSleepTimer = 0;
  let autoSleepResolver = null;

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  const page = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  const VIDEO_ID_RE = /^\d{10,25}$/;
  const CAPTURE_LIMIT = 100;
  const ID_ATTR_SELECTOR = [
    '[data-e2e-vid]',
    '[data-aweme-id]',
    '[data-awemeid]',
    '[data-video-id]',
    '[data-item-id]',
    '[data-modal-id]',
    '[data-vid]',
  ].join(',');
  const ID_ATTRIBUTES = [
    'data-e2e-vid',
    'data-aweme-id',
    'data-awemeid',
    'data-video-id',
    'data-item-id',
    'data-modal-id',
    'data-vid',
  ];

  // 推荐/关注/朋友页不会把 aweme_id 写进地址栏。
  // 这里缓存页面自己请求到的作品，最后用当前 <video> 的 CDN 地址反查 ID。
  const capturedItems = new Map();

  function normalizeVideoId(value) {
    if (value === null || value === undefined) return '';
    const text = String(value).trim();
    if (!text) return '';
    if (VIDEO_ID_RE.test(text)) return text;
    const match = text.match(
      /(?:modal_id|aweme_id|item_id|vid|video_id)=(\d{10,25})|(?:\/|^)(?:share\/)?(?:video|note)\/(\d{10,25})(?:\/|$)/i,
    );
    return match ? match[1] || match[2] || '' : '';
  }

  function getVideoId() {
    const url = new URL(window.location.href);
    const fromUrl = normalizeVideoId(url.pathname);
    if (fromUrl) return fromUrl;

    for (const key of ['modal_id', 'aweme_id', 'item_id', 'vid']) {
      const id = normalizeVideoId(url.searchParams.get(key));
      if (id) return id;
    }

    const hash = url.hash.replace(/^#/, '');
    if (hash) {
      const hashParams = new URLSearchParams(hash);
      for (const key of ['modal_id', 'aweme_id', 'item_id', 'vid']) {
        const id = normalizeVideoId(hashParams.get(key));
        if (id) return id;
      }
      const fromHash = normalizeVideoId(hash);
      if (fromHash) return fromHash;
    }
    return '';
  }

  function canonicalVideoUrl(id) {
    return id ? `https://www.douyin.com/video/${id}` : null;
  }

  function isFeedRoute() {
    const path = window.location.pathname.replace(/\/+$/, '') || '/';
    return path === '/' || path === '/follow' || path === '/friend' || path === '/recommend';
  }

  function isSupportedPage() {
    return (
      isFeedRoute() ||
      Boolean(getVideoId()) ||
      Boolean(document.querySelector('[data-e2e="feed-active-video"], [data-e2e-vid]'))
    );
  }

  function idFromHref(value) {
    if (typeof value !== 'string' || !value) return '';
    try {
      const url = new URL(value, window.location.href);
      if (url.hostname !== 'douyin.com' && !url.hostname.endsWith('.douyin.com')) return '';
      return (
        normalizeVideoId(url.searchParams.get('modal_id')) ||
        normalizeVideoId(url.searchParams.get('aweme_id')) ||
        normalizeVideoId(url.searchParams.get('item_id')) ||
        normalizeVideoId(url.pathname)
      );
    } catch (_) {
      return normalizeVideoId(value);
    }
  }

  function readOwnId(element) {
    if (!element || typeof element.getAttribute !== 'function') return '';
    for (const name of ID_ATTRIBUTES) {
      const raw = element.getAttribute(name);
      const id = normalizeVideoId(raw);
      if (id) return id;
    }
    return '';
  }

  function idFromElementTree(element) {
    if (!(element instanceof Element)) return '';
    const ownId = readOwnId(element);
    if (ownId) return ownId;

    const ids = new Set();
    const idNodes = element.querySelectorAll(ID_ATTR_SELECTOR);
    for (let index = 0; index < idNodes.length && index < 120; index += 1) {
      const id = readOwnId(idNodes[index]);
      if (id) ids.add(id);
      if (ids.size > 2) break;
    }

    const links = element.querySelectorAll('a[href]');
    for (let index = 0; index < links.length && index < 120; index += 1) {
      const id = idFromHref(links[index].getAttribute('href'));
      if (id) ids.add(id);
      if (ids.size > 2) break;
    }

    return ids.size === 1 ? [...ids][0] : '';
  }

  function identityFromElement(element) {
    let current = element;
    for (
      let depth = 0;
      current && current !== document.body && current !== document.documentElement && depth < 8;
      depth += 1, current = current.parentElement
    ) {
      const id = idFromElementTree(current);
      if (id) return id;
      if (current !== element && current.querySelectorAll('video').length > 1) break;
    }
    return '';
  }

  function elementVisible(element) {
    if (!(element instanceof Element)) return false;
    const style = window.getComputedStyle(element);
    if (
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      Number.parseFloat(style.opacity || '1') === 0
    ) {
      return false;
    }
    return element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0;
  }

  function visibleArea(element) {
    const box = element.getBoundingClientRect();
    const width = Math.max(0, Math.min(window.innerWidth, box.right) - Math.max(0, box.left));
    const height = Math.max(0, Math.min(window.innerHeight, box.bottom) - Math.max(0, box.top));
    return width * height;
  }

  function currentWorkElement() {
    const candidates = new Set();
    document.querySelectorAll('[data-e2e="feed-active-video"]').forEach((node) => candidates.add(node));
    document.querySelectorAll('[data-e2e-vid]').forEach((node) => {
      candidates.add(node);
      const video = node.querySelector('video');
      if (video) candidates.add(video);
    });
    document.querySelectorAll('video').forEach((video) => {
      candidates.add(video.closest('[data-e2e-vid]') || video);
    });

    const entries = [];
    for (const element of candidates) {
      const area = elementVisible(element) ? visibleArea(element) : 0;
      if (area < 2500) continue;
      const video = element.tagName === 'VIDEO' ? element : element.querySelector('video');
      const active = Boolean(element.closest('[data-e2e="feed-active-video"]'));
      const playing = Boolean(
        video && !video.paused && !video.ended && video.readyState >= 2,
      );
      entries.push({
        element,
        video,
        active,
        score: area * (playing ? 3 : 1),
      });
    }

    entries.sort(
      (a, b) => Number(b.active) - Number(a.active) || b.score - a.score,
    );
    return entries[0] || null;
  }

  function videoSources(video) {
    if (!video) return [];
    const sources = new Set();
    for (const value of [video.currentSrc, video.src]) {
      if (value) sources.add(value);
    }
    for (const source of video.querySelectorAll('source')) {
      if (source.src) sources.add(source.src);
      const raw = source.getAttribute('src');
      if (raw) sources.add(raw);
    }
    return [...sources];
  }

  function mediaKey(value) {
    try {
      const url = new URL(value, window.location.href);
      if (url.protocol !== 'https:' && url.protocol !== 'http:') return '';
      const marker = url.pathname.indexOf('/video/tos/');
      return marker >= 0 ? url.pathname.slice(marker) : `${url.hostname}${url.pathname}`;
    } catch (_) {
      return '';
    }
  }

  function collectMediaUrls(address, bucket, depth) {
    if (!address || depth > 4) return;
    if (typeof address === 'string') {
      if (/^https?:\/\//i.test(address)) bucket.add(address);
      return;
    }
    if (Array.isArray(address)) {
      for (let index = 0; index < address.length && index < 24; index += 1) {
        collectMediaUrls(address[index], bucket, depth + 1);
      }
      return;
    }
    if (typeof address !== 'object') return;
    for (const key of ['url_list', 'urlList', 'url', 'src']) {
      if (address[key]) collectMediaUrls(address[key], bucket, depth + 1);
    }
  }

  function itemVideoUrls(video) {
    const urls = new Set();
    if (!video || typeof video !== 'object') return [];
    for (const key of [
      'play_addr',
      'playAddr',
      'play_addr_h264',
      'playAddrH264',
      'play_addr_265',
      'playAddrH265',
      'play_addr_bytevc1',
      'playAddrBytevc1',
    ]) {
      collectMediaUrls(video[key], urls, 0);
    }
    for (const key of ['bit_rate', 'bitRateList', 'bitRate']) {
      const rates = video[key];
      if (!Array.isArray(rates)) continue;
      for (let index = 0; index < rates.length && index < 24; index += 1) {
        const rate = rates[index];
        if (!rate || typeof rate !== 'object') continue;
        collectMediaUrls(rate.play_addr, urls, 0);
        collectMediaUrls(rate.playAddr, urls, 0);
      }
    }
    return [...urls];
  }

  function rememberItem(value) {
    if (!value || typeof value !== 'object') return false;
    const id = normalizeVideoId(
      value.aweme_id || value.awemeId || value.item_id || value.itemId,
    );
    if (!id) return false;
    const video = value.video || value.videoInfo;
    if (!video || typeof video !== 'object') return false;
    const urls = itemVideoUrls(video);
    if (!urls.length) return false;

    capturedItems.set(id, {
      id,
      urls,
      author:
        value.author?.nickname ||
        value.authorInfo?.nickname ||
        value.author_name ||
        '',
      desc: value.desc || value.description || '',
      at: Date.now(),
    });
    while (capturedItems.size > CAPTURE_LIMIT) {
      capturedItems.delete(capturedItems.keys().next().value);
    }
    return true;
  }

  function rememberPayload(payload) {
    let visited = 0;
    const visit = (value, depth) => {
      if (!value || typeof value !== 'object' || depth > 14 || visited > 8000) return;
      visited += 1;
      if (Array.isArray(value)) {
        for (let index = 0; index < value.length && index < 80; index += 1) {
          visit(value[index], depth + 1);
        }
        return;
      }
      if (rememberItem(value)) return;
      const keys = Object.keys(value);
      for (let index = 0; index < keys.length && index < 80; index += 1) {
        const key = keys[index];
        if (key === '__proto__' || key === 'constructor') continue;
        visit(value[key], depth + 1);
      }
    };
    visit(payload, 0);
  }

  function isVideoApi(value) {
    try {
      const url = new URL(value, window.location.href);
      return (
        url.origin === window.location.origin &&
        /^\/aweme\/v[12]\/web\//.test(url.pathname)
      );
    } catch (_) {
      return false;
    }
  }

  function installNetworkCapture() {
    // 页面负责登录、签名和请求；这里只读取响应副本，不改变原响应。
    try {
      const originalFetch = page.fetch;
      if (typeof originalFetch === 'function' && !originalFetch.__dyLocalCapture) {
        const wrappedFetch = function (...args) {
          const result = Reflect.apply(originalFetch, this, args);
          try {
            const input = args[0];
            const url =
              typeof input === 'string'
                ? input
                : input && input.url
                  ? input.url
                  : String(input);
            if (isVideoApi(url) && result && typeof result.then === 'function') {
              result
                .then((response) => {
                  if (!response || !response.ok) return;
                  try {
                    response
                      .clone()
                      .json()
                      .then(rememberPayload)
                      .catch(() => {});
                  } catch (_) {
                    /* 不干扰页面请求 */
                  }
                })
                .catch(() => {});
            }
          } catch (_) {
            /* 不干扰页面请求 */
          }
          return result;
        };
        wrappedFetch.__dyLocalCapture = true;
        page.fetch = wrappedFetch;
      }
    } catch (_) {
      /* 某些浏览器会禁止修改页面上下文，DOM 方案仍然可用 */
    }

    try {
      const xhrPrototype = page.XMLHttpRequest && page.XMLHttpRequest.prototype;
      if (xhrPrototype && !xhrPrototype.__dyLocalCapture) {
        const originalOpen = xhrPrototype.open;
        const watched = new WeakSet();
        xhrPrototype.open = function (...args) {
          if (!watched.has(this)) {
            watched.add(this);
            this.addEventListener('load', () => {
              try {
                if (this.status !== 200 || !isVideoApi(this.responseURL)) return;
                if (this.responseType === 'json') {
                  rememberPayload(this.response);
                } else if (!this.responseType || this.responseType === 'text') {
                  rememberPayload(JSON.parse(this.responseText));
                }
              } catch (_) {
                /* 不干扰页面请求 */
              }
            });
          }
          return Reflect.apply(originalOpen, this, args);
        };
        xhrPrototype.__dyLocalCapture = true;
      }
    } catch (_) {
      /* DOM 方案仍然可用 */
    }
  }

  function idFromMediaSource(video) {
    for (const source of videoSources(video)) {
      try {
        const url = new URL(source, window.location.href);
        const direct = normalizeVideoId(
          url.searchParams.get('__vid') ||
            url.searchParams.get('vid') ||
            url.searchParams.get('video_id'),
        );
        if (direct) return direct;
      } catch (_) {
        /* blob: 或非法地址 */
      }

      const key = mediaKey(source);
      if (!key) continue;
      const items = [...capturedItems.values()].reverse();
      for (const item of items) {
        if (item.urls.some((value) => mediaKey(value) === key)) return item.id;
      }
    }
    return '';
  }

  function idFromReact(element) {
    if (!(element instanceof Element)) return '';
    try {
      const key = Object.keys(element).find(
        (name) =>
          name.startsWith('__reactFiber$') || name.startsWith('__reactInternalInstance$'),
      );
      if (!key) return '';
      let fiber = element[key];
      for (let depth = 0; fiber && depth < 24; depth += 1, fiber = fiber.return) {
        const props = fiber.memoizedProps;
        if (!props || typeof props !== 'object') continue;
        const candidates = [
          props.item,
          props.slideData,
          props.aweme,
          props.data,
          props.itemInfo,
          props,
        ];
        for (const value of candidates) {
          if (!value || typeof value !== 'object') continue;
          const direct = normalizeVideoId(
            value.aweme_id || value.awemeId || value.item_id || value.itemId,
          );
          if (direct) return direct;
          const nested = value.aweme || value.item || value.data;
          if (nested && typeof nested === 'object') {
            const nestedId = normalizeVideoId(
              nested.aweme_id || nested.awemeId || nested.item_id || nested.itemId,
            );
            if (nestedId) return nestedId;
          }
        }
      }
    } catch (_) {
      /* React 内部结构变化时忽略 */
    }
    return '';
  }

  function resolveCurrentVideoIdOnce() {
    // 信息流/收藏夹弹窗里，地址栏的 modal_id 可能滞后于 Swiper 当前页，
    // 因此优先读取当前正在播放的卡片，最后才回退到 URL。
    const work = currentWorkElement();
    if (work) {
      const fromCard = identityFromElement(work.element);
      if (fromCard) return fromCard;
      if (work.video) {
        const fromVideo =
          idFromMediaSource(work.video) || idFromReact(work.video);
        if (fromVideo) return fromVideo;
      }
      const fromReact = idFromReact(work.element);
      if (fromReact) return fromReact;
    }

    for (const active of document.querySelectorAll('[data-e2e="feed-active-video"]')) {
      const id = idFromElementTree(active) || idFromReact(active);
      if (id) return id;
    }

    const visibleCards = [...document.querySelectorAll('[data-e2e-vid]')].filter(
      elementVisible,
    );
    if (visibleCards.length === 1) {
      const id = idFromElementTree(visibleCards[0]);
      if (id) return id;
    }

    return getVideoId();
  }

  async function resolveCurrentVideoId() {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const id = resolveCurrentVideoIdOnce();
      if (id) return id;
      await sleep(150);
    }
    return '';
  }

  function errorMessage(error) {
    if (error instanceof HttpError) return error.message;
    const text = String(error && error.message ? error.message : error);
    if (/failed to fetch|networkerror|load failed|network request failed/i.test(text)) {
      return [
        '无法连接本地下载服务。',
        '请先在 Mac 上运行：',
        'python3 app.py',
      ].join('\n');
    }
    return text || '未知错误';
  }

  async function nativeRequest(method, path, body) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const options = {
      method,
      mode: 'cors',
      credentials: 'omit',
      cache: 'no-store',
      signal: controller.signal,
      headers: {},
    };
    if (body !== undefined) {
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(body);
    }

    try {
      const response = await fetch(`${API_BASE}${path}`, options);
      const text = await response.text();
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch (_) {
        data = null;
      }
      if (!response.ok) {
        const message = data && data.error ? data.error : `本地服务返回 HTTP ${response.status}`;
        throw new HttpError(message, response.status);
      }
      if (!data || typeof data !== 'object') {
        throw new Error('本地服务返回了无法解析的数据。');
      }
      return data;
    } finally {
      clearTimeout(timeout);
    }
  }

  function gmRequest(method, path, body) {
    return new Promise((resolve, reject) => {
      if (typeof GM_xmlhttpRequest !== 'function') {
        reject(new Error('浏览器阻止了本地请求，且当前脚本无法使用 GM_xmlhttpRequest。'));
        return;
      }

      const options = {
        method,
        url: `${API_BASE}${path}`,
        headers: {},
        timeout: 10000,
        onload(response) {
          let data = null;
          try {
            data = response.responseText ? JSON.parse(response.responseText) : null;
          } catch (_) {
            data = null;
          }
          if (response.status >= 200 && response.status < 300) {
            if (!data || typeof data !== 'object') {
              reject(new Error('本地服务返回了无法解析的数据。'));
              return;
            }
            resolve(data);
            return;
          }
          const message = data && data.error ? data.error : `本地服务返回 HTTP ${response.status}`;
          reject(new HttpError(message, response.status));
        },
        onerror() {
          reject(new Error('无法连接本地下载服务。请先在 Mac 上运行：python3 app.py'));
        },
        ontimeout() {
          reject(new Error('本地下载服务响应超时。'));
        },
      };

      if (body !== undefined) {
        options.headers['Content-Type'] = 'application/json';
        options.data = JSON.stringify(body);
      }
      GM_xmlhttpRequest(options);
    });
  }

  async function apiRequest(method, path, body) {
    try {
      return await nativeRequest(method, path, body);
    } catch (error) {
      // HTTP 400/404 等是服务端明确返回的错误，不需要换通道重试。
      if (error instanceof HttpError) throw error;
      if (error && error.name === 'AbortError') {
        throw new Error('本地下载服务响应超时。');
      }
      // Chrome 的 CORS / Private Network Access 或页面 CSP 可能拦截 fetch，
      // 此时回退到 Tampermonkey 的 GM_xmlhttpRequest。
      return gmRequest(method, path, body);
    }
  }

  function setPanel(message, type, autoHideMs) {
    if (!ui) return;
    window.clearTimeout(toastTimer);
    ui.panel.textContent = message;
    ui.panel.className = `panel show ${type || 'info'}`;
    if (autoHideMs && autoHideMs > 0) {
      toastTimer = window.setTimeout(() => {
        if (ui) ui.panel.className = 'panel';
      }, autoHideMs);
    }
  }

  function setBusy(nextBusy, label) {
    if (!ui) return;
    busy = nextBusy;
    ui.button.disabled = nextBusy;
    ui.button.textContent = nextBusy ? label || '提交中…' : '⬇ 一键下载';
  }

  function setCopyBusy(nextBusy, label) {
    if (!ui) return;
    copyBusy = nextBusy;
    ui.copyButton.disabled = nextBusy;
    ui.copyButton.textContent = nextBusy ? label || '处理中…' : '📋 复制作者UID';
  }

  function setArchiveButtonBusy(nextBusy, label) {
    if (!ui) return;
    archiveBusy = nextBusy;
    ui.archiveButton.disabled = nextBusy;
    ui.archiveButton.textContent = nextBusy ? label || '加载中…' : '📁 指定归档';
  }

  function showModalSurface() {
    if (!ui) return;
    ui.modalHost.style.display = 'block';
    ui.modalHost.setAttribute('aria-hidden', 'false');
  }

  function closeModal(force) {
    if (!ui) return;
    if (archiveSubmitting && !force) return;
    ui.modalHost.style.display = 'none';
    ui.modalHost.setAttribute('aria-hidden', 'true');
    modalMode = null;
    selectedFolder = '';
    activeFolderIndex = -1;
    ui.archiveInput.disabled = false;
    ui.modalCancel.disabled = false;
    ui.modalConfirm.disabled = false;
  }

  function showInfoModal(title, message) {
    if (!ui) return;
    modalMode = 'info';
    archiveSubmitting = false;
    ui.modalTitle.textContent = title;
    ui.modalMessage.textContent = message;
    ui.archiveBody.style.display = 'none';
    ui.modalCancel.style.display = 'none';
    ui.modalConfirm.style.display = '';
    ui.modalConfirm.disabled = false;
    ui.modalConfirm.textContent = '知道了';
    showModalSurface();
    ui.modalConfirm.focus();
  }

  function filterFolders(source, query) {
    const normalized = String(query || '').trim().toLocaleLowerCase();
    if (!normalized) {
      return { mode: 'all', matches: source.slice() };
    }

    const prefixMatches = source.filter((name) =>
      name.toLocaleLowerCase().startsWith(normalized),
    );
    if (prefixMatches.length > 0) {
      return { mode: 'prefix', matches: prefixMatches };
    }

    const containsMatches = source.filter((name) =>
      name.toLocaleLowerCase().includes(normalized),
    );
    return {
      mode: containsMatches.length ? 'contains' : 'none',
      matches: containsMatches,
    };
  }

  function renderArchiveOptions() {
    if (!ui || modalMode !== 'archive') return;
    const result = filterFolders(folders, ui.archiveInput.value);
    filteredFolders = result.matches;

    if (activeFolderIndex >= filteredFolders.length) {
      activeFolderIndex = filteredFolders.length ? 0 : -1;
    }
    if (activeFolderIndex < -1) activeFolderIndex = -1;

    if (result.mode === 'all') {
      ui.archiveHint.textContent = `共 ${folders.length} 个文件夹`;
    } else if (result.mode === 'prefix') {
      ui.archiveHint.textContent = `前缀匹配 ${filteredFolders.length} 个`;
    } else if (result.mode === 'contains') {
      ui.archiveHint.textContent = `前缀无结果，模糊匹配 ${filteredFolders.length} 个`;
    } else {
      ui.archiveHint.textContent = '没有匹配的文件夹';
    }

    ui.archiveList.replaceChildren();
    if (!filteredFolders.length) {
      const empty = document.createElement('div');
      empty.className = 'folder-empty';
      empty.textContent = folders.length
        ? '没有匹配项，换个关键词试试。'
        : '~/Douyin_Saved 下还没有文件夹。';
      ui.archiveList.appendChild(empty);
    } else {
      filteredFolders.forEach((name, index) => {
        const option = document.createElement('button');
        option.type = 'button';
        option.className = 'folder-option';
        option.textContent = name;
        option.title = name;
        option.setAttribute('role', 'option');
        option.setAttribute('aria-selected', name === selectedFolder ? 'true' : 'false');
        if (index === activeFolderIndex) option.classList.add('active');
        if (name === selectedFolder) option.classList.add('selected');
        option.addEventListener('mousedown', (event) => event.preventDefault());
        option.addEventListener('click', () => selectArchiveFolder(name));
        ui.archiveList.appendChild(option);
      });
    }

    ui.modalConfirm.disabled = !selectedFolder || archiveSubmitting;
  }

  function selectArchiveFolder(name) {
    if (!ui || modalMode !== 'archive') return;
    selectedFolder = name;
    ui.archiveInput.value = name;
    activeFolderIndex = filteredFolders.indexOf(name);
    renderArchiveOptions();
    ui.archiveInput.focus();
  }

  function handleArchiveInput() {
    if (!ui || modalMode !== 'archive') return;
    const query = ui.archiveInput.value.trim().toLocaleLowerCase();
    selectedFolder = folders.find(
      (name) => name.toLocaleLowerCase() === query,
    ) || '';
    activeFolderIndex = 0;
    renderArchiveOptions();
  }

  function moveArchiveSelection(delta) {
    if (!ui || !filteredFolders.length) return;
    if (activeFolderIndex < 0) {
      activeFolderIndex = 0;
    } else {
      activeFolderIndex =
        (activeFolderIndex + delta + filteredFolders.length) % filteredFolders.length;
    }
    renderArchiveOptions();
    const active = ui.archiveList.querySelector('.folder-option.active');
    if (active && active.scrollIntoView) {
      active.scrollIntoView({ block: 'nearest' });
    }
  }

  function handleArchiveKeydown(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeModal();
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      moveArchiveSelection(1);
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      moveArchiveSelection(-1);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      if (selectedFolder) {
        void submitArchiveSelection();
      } else if (activeFolderIndex >= 0 && filteredFolders[activeFolderIndex]) {
        selectArchiveFolder(filteredFolders[activeFolderIndex]);
      } else if (filteredFolders.length === 1) {
        selectArchiveFolder(filteredFolders[0]);
      }
    }
  }

  async function copyTextToClipboard(text) {
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (_) {
      /* 继续使用 execCommand 回退 */
    }

    try {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.setAttribute(
        'style',
        'position:fixed;left:-9999px;top:0;opacity:0;pointer-events:none;',
      );
      document.body.appendChild(textarea);
      textarea.focus();
      textarea.select();
      textarea.setSelectionRange(0, textarea.value.length);
      const copied = document.execCommand('copy');
      textarea.remove();
      return copied;
    } catch (_) {
      return false;
    }
  }

  function isEditableKeyboardTarget(target) {
    if (!(target instanceof Element)) return false;
    if (target.isContentEditable) return true;
    return ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
  }

  function handleShortcutKeydown(event) {
    if (!shortcutEnabled || suppressSyntheticShortcut) return;
    if (!event.isTrusted) return; // 自动连播派发的 C 不再触发下载
    if (event.key.toLocaleLowerCase() !== 'c') return;
    if (event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
    if (modalMode) return;
    const path = typeof event.composedPath === 'function'
      ? event.composedPath()
      : [event.target];
    if (path.some(isEditableKeyboardTarget)) return;

    // 1 秒防抖：第一下立即提交，后续 1 秒内的 C 忽略。
    if (shortcutDebounceTimer) return;
    shortcutDebounceTimer = window.setTimeout(() => {
      shortcutDebounceTimer = 0;
    }, 1000);

    // 故意不调用 event.preventDefault()，让抖音原生 C（取消收藏）继续执行。
    void handleDownload();
  }

  function dispatchSyntheticShortcutC() {
    const event = new KeyboardEvent('keydown', {
      key: 'c',
      code: 'KeyC',
      keyCode: 67,
      which: 67,
      bubbles: true,
      cancelable: true,
      composed: true,
    });
    try {
      Object.defineProperty(event, 'keyCode', { get: () => 67 });
      Object.defineProperty(event, 'which', { get: () => 67 });
    } catch (_) {
      /* 部分浏览器不允许覆盖，保留 key/code 即可 */
    }

    suppressSyntheticShortcut = true;
    try {
      (document.body || document.documentElement).dispatchEvent(event);
    } catch (_) {
      /* 不阻断自动连播 */
    } finally {
      suppressSyntheticShortcut = false;
    }
  }

  function setAutoLoopButton(running) {
    if (!ui) return;
    ui.autoButton.textContent = running ? '⏸ 停止连播' : '▶ 开始自动连播';
    ui.autoButton.classList.toggle('running', running);
    ui.autoButton.setAttribute('aria-pressed', running ? 'true' : 'false');
  }

  function autoDelay(ms, token) {
    return new Promise((resolve) => {
      if (!autoLoopRunning || token !== autoLoopToken) {
        resolve(false);
        return;
      }

      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        if (autoSleepTimer) {
          window.clearTimeout(autoSleepTimer);
          autoSleepTimer = 0;
        }
        autoSleepResolver = null;
        resolve(value);
      };

      autoSleepTimer = window.setTimeout(() => {
        finish(autoLoopRunning && token === autoLoopToken);
      }, ms);
      autoSleepResolver = () => finish(false);
    });
  }

  function stopAutoLoop(showMessage) {
    const wasRunning = autoLoopRunning;
    autoLoopRunning = false;
    autoLoopToken += 1;

    // 立即唤醒正在 await 的定时器，让循环在当前 tick 内退出。
    const resolver = autoSleepResolver;
    autoSleepResolver = null;
    if (resolver) resolver();
    if (autoSleepTimer) {
      window.clearTimeout(autoSleepTimer);
      autoSleepTimer = 0;
    }

    setAutoLoopButton(false);
    if (wasRunning && showMessage !== false) {
      setPanel('已停止自动连播。', 'info', 3500);
    }
  }

  function findReactPlayNext(element) {
    if (!(element instanceof Element)) return null;
    try {
      const fiberKey = Object.keys(element).find((key) =>
        key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$'),
      );
      if (!fiberKey) return null;
      let fiber = element[fiberKey];
      for (let depth = 0; fiber && depth < 28; depth += 1, fiber = fiber.return) {
        const props = fiber.memoizedProps;
        if (props && typeof props.playNextFunc === 'function') {
          return props.playNextFunc;
        }
      }
    } catch (_) {
      /* React 内部结构变化时使用滚动回退 */
    }
    return null;
  }

  function dispatchSyntheticArrowDown() {
    const event = new KeyboardEvent('keydown', {
      key: 'ArrowDown',
      code: 'ArrowDown',
      keyCode: 40,
      which: 40,
      bubbles: true,
      cancelable: true,
      composed: true,
    });
    try {
      Object.defineProperty(event, 'keyCode', { get: () => 40 });
      Object.defineProperty(event, 'which', { get: () => 40 });
    } catch (_) {
      /* 保留 key/code */
    }
    try {
      (document.body || document.documentElement).dispatchEvent(event);
    } catch (_) {
      /* 忽略 */
    }
  }

  function scrollToNextVideo() {
    const cards = [...document.querySelectorAll('[data-e2e-vid]')];
    const currentIndex = cards.findIndex((card) =>
      card.closest('[data-e2e="feed-active-video"]'),
    );
    if (currentIndex >= 0 && cards[currentIndex + 1]) {
      try {
        cards[currentIndex + 1].scrollIntoView({ block: 'start', behavior: 'smooth' });
      } catch (_) {
        /* 继续尝试滚动容器 */
      }
    }

    let node = currentWorkElement()?.element || null;
    let scroller = null;
    while (node && node !== document.body && node !== document.documentElement) {
      const style = window.getComputedStyle(node);
      if (
        /(auto|scroll)/.test(style.overflowY) &&
        node.scrollHeight > node.clientHeight + 20
      ) {
        scroller = node;
        break;
      }
      node = node.parentElement;
    }

    const target = scroller || document.scrollingElement || document.documentElement;
    if (target.scrollHeight <= target.clientHeight + 20 && !scroller) {
      return false;
    }

    const distance = Math.max(window.innerHeight, target.clientHeight || 0);
    try {
      target.scrollBy({ top: distance, behavior: 'smooth' });
      return true;
    } catch (_) {
      window.scrollBy(0, window.innerHeight);
      return true;
    }
  }

  async function advanceToNextVideo(token) {
    const beforeId = resolveCurrentVideoIdOnce();
    const active = document.querySelector('[data-e2e="feed-active-video"]');
    const work = currentWorkElement();
    const playNextFunc = findReactPlayNext(
      (work && work.element) || active || document.body,
    );

    // 抖音收藏夹弹窗使用 Swiper 的 transform 动画，不是可滚动容器。
    // 直接调用页面自身的 playNextFunc 是当前最可靠的方式。
    if (playNextFunc) {
      try {
        playNextFunc();
      } catch (error) {
        console.warn('[douyin-auto] playNextFunc failed', error);
      }

      for (let attempt = 0; attempt < 12; attempt += 1) {
        if (!(await autoDelay(100, token))) return '';
        const afterId = resolveCurrentVideoIdOnce();
        if (afterId && beforeId && afterId !== beforeId) {
          console.info('[douyin-auto] next video via playNextFunc', beforeId, '->', afterId);
          return 'react';
        }
      }
      console.warn('[douyin-auto] playNextFunc did not change active video');
    }

    // 回退：真实滚动 + ArrowDown。适用于普通滚动式信息流或抖音改版。
    const scrolled = scrollToNextVideo();
    dispatchSyntheticArrowDown();
    for (let attempt = 0; attempt < 8; attempt += 1) {
      if (!(await autoDelay(100, token))) return '';
      const afterId = resolveCurrentVideoIdOnce();
      if (afterId && beforeId && afterId !== beforeId) {
        console.info('[douyin-auto] next video via fallback', beforeId, '->', afterId);
        return scrolled ? 'scroll' : 'arrow';
      }
    }
    console.warn('[douyin-auto] fallback did not change active video');
    return '';
  }

  async function autoQueueCurrent(token, cycle) {
    try {
      const id = await resolveCurrentVideoId();
      if (!autoLoopRunning || token !== autoLoopToken) return;
      if (!id) {
        throw new Error('没有识别到当前视频 ID。');
      }

      const url = canonicalVideoUrl(id);
      const data = await apiRequest('POST', '/api/download', { url });
      if (!data.ok || !data.job || !data.job.id) {
        throw new Error((data && data.error) || '本地服务没有返回任务 ID。');
      }
      if (!autoLoopRunning || token !== autoLoopToken) return;

      setPanel(
        [
          `自动连播中…（第 ${cycle} 个）`,
          `快捷键 C：${shortcutEnabled ? '启用（会按 C）' : '关闭（不按 C）'}`,
          data.duplicate ? '该视频已在队列/最近处理过。' : '已加入下载队列。',
          `视频：${url}`,
        ].join('\n'),
        'info',
      );
    } catch (error) {
      if (autoLoopRunning && token === autoLoopToken) {
        setPanel(`自动连播提交失败：\n${errorMessage(error)}`, 'error', 5000);
      }
    }
  }

  async function runAutoLoop(token) {
    let cycle = 0;
    while (autoLoopRunning && token === autoLoopToken) {
      cycle += 1;

      // Step 1：提交当前视频。
      await autoQueueCurrent(token, cycle);
      if (!autoLoopRunning || token !== autoLoopToken) break;

      const beforeCId = resolveCurrentVideoIdOnce();

      // Step 2：只有“启用快捷键 C”勾选时，才模拟 C 取消收藏。
      // 未勾选时仍然提交下载并切换下一个视频，只是不按 C。
      if (shortcutEnabled) {
        dispatchSyntheticShortcutC();
      }

      // Step 3：等待列表更新（无论是否按 C，保持原有等待时长）。
      if (!(await autoDelay(2500, token))) break;

      // 如果页面已经自动切换到下一个，避免再切一次导致跳过视频。
      const afterCId = resolveCurrentVideoIdOnce();
      if (afterCId && beforeCId && afterCId !== beforeCId) {
        setPanel(`自动连播中…（第 ${cycle} 个）\n页面已自动切换，跳过额外切换。`, 'info');
      } else {
        // Step 4：调用抖音自身的 playNextFunc 切换；失败时回退滚动/ArrowDown。
        const method = await advanceToNextVideo(token);
        if (!autoLoopRunning || token !== autoLoopToken) break;
        if (method) {
          setPanel(`自动连播中…（第 ${cycle} 个）\n已切换到下一个视频（${method}）。`, 'info');
        } else {
          setPanel(`自动连播中…（第 ${cycle} 个）\n未能切换视频，等待下一轮重试。`, 'error', 4000);
        }
      }

      // Step 5：等待新视频加载。
      if (!(await autoDelay(2000, token))) break;
    }
  }

  function startAutoLoop() {
    if (autoLoopRunning) return;
    autoLoopRunning = true;
    const token = ++autoLoopToken;
    setAutoLoopButton(true);
    const cStep = shortcutEnabled ? '按 C 取消收藏' : '不按 C';
    setPanel(`自动连播已启动。每轮：提交下载 → ${cStep} → 切换到下一个。`, 'info');
    void runAutoLoop(token);
  }

  function toggleAutoLoop() {
    if (autoLoopRunning) {
      stopAutoLoop(true);
    } else {
      startAutoLoop();
    }
  }

  async function handleCopyUid() {
    if (copyBusy) return;
    setCopyBusy(true, '识别中…');

    try {
      const id = await resolveCurrentVideoId();
      if (!id) {
        throw new Error('没有识别到当前视频 ID，请让视频显示出来后再试。');
      }

      setCopyBusy(true, '解析中…');
      const url = canonicalVideoUrl(id);
      const data = await apiRequest(
        'GET',
        `/api/author_info?url=${encodeURIComponent(url)}`,
      );
      const uid = data && data.uid ? String(data.uid) : '';
      if (!data || !data.ok || !uid) {
        throw new Error((data && data.error) || '后端没有返回作者 UID。');
      }

      setCopyBusy(true, '复制中…');
      const copied = await copyTextToClipboard(uid);
      if (copied) {
        showInfoModal(
          '复制成功',
          `✅ 已复制 UID：${uid}，请前往 JSON 文件进行映射`,
        );
      } else {
        showInfoModal(
          '复制作者 UID',
          `UID：${uid}\n浏览器拒绝写入剪贴板，请手动复制。`,
        );
      }
    } catch (error) {
      showInfoModal('复制失败', errorMessage(error));
    } finally {
      setCopyBusy(false);
    }
  }

  function setArchiveConfirmBusy(nextBusy, label) {
    if (!ui) return;
    ui.modalConfirm.disabled = nextBusy || !selectedFolder;
    ui.modalConfirm.textContent = nextBusy ? label || '处理中…' : '归档下载';
    ui.modalCancel.disabled = nextBusy;
    ui.archiveInput.disabled = nextBusy;
  }

  async function submitArchiveSelection() {
    if (!selectedFolder || archiveSubmitting) return;
    archiveSubmitting = true;
    setArchiveConfirmBusy(true, '识别中…');

    try {
      const id = await resolveCurrentVideoId();
      if (!id) {
        throw new Error('没有识别到当前视频 ID，请让视频显示出来后再试。');
      }

      const url = canonicalVideoUrl(id);
      const target = selectedFolder;
      setArchiveConfirmBusy(true, '归档中…');
      const data = await apiRequest('POST', '/api/download', {
        url,
        target_author: target,
      });
      if (!data.ok || !data.job || !data.job.id) {
        throw new Error((data && data.error) || '本地服务没有返回任务 ID。');
      }

      closeModal(true);
      const generation = ++pollGeneration;
      setPanel(`已提交归档：${target}\n正在处理…`, 'info');
      void pollJob(data.job.id, generation);
    } catch (error) {
      if (modalMode === 'archive') {
        ui.modalMessage.textContent = `归档失败：\n${errorMessage(error)}`;
      } else {
        setPanel(`归档失败：\n${errorMessage(error)}`, 'error', 15000);
      }
    } finally {
      archiveSubmitting = false;
      setArchiveConfirmBusy(false);
    }
  }

  async function openArchiveModal() {
    if (!ui || archiveBusy) return;

    modalMode = 'archive';
    archiveSubmitting = false;
    folders = [];
    filteredFolders = [];
    selectedFolder = '';
    activeFolderIndex = -1;
    ui.modalTitle.textContent = '指定归档';
    ui.modalMessage.textContent =
      '选择目标文件夹。视频会保持原文件名，不会添加作者前缀。';
    ui.archiveBody.style.display = 'flex';
    ui.archiveInput.value = '';
    ui.archiveInput.disabled = true;
    ui.archiveHint.textContent = '正在加载文件夹…';
    ui.archiveList.replaceChildren();
    ui.modalCancel.style.display = '';
    ui.modalCancel.disabled = false;
    ui.modalConfirm.style.display = '';
    ui.modalConfirm.textContent = '归档下载';
    ui.modalConfirm.disabled = true;
    showModalSurface();

    setArchiveButtonBusy(true, '加载中…');
    try {
      const data = await apiRequest('GET', '/api/folders');
      if (modalMode !== 'archive') return;
      if (!data || !data.ok || !Array.isArray(data.folders)) {
        throw new Error((data && data.error) || '后端没有返回文件夹列表。');
      }
      folders = data.folders.filter((name) => typeof name === 'string');
      ui.archiveInput.disabled = false;
      activeFolderIndex = folders.length ? 0 : -1;
      renderArchiveOptions();
      ui.archiveInput.focus();
    } catch (error) {
      if (modalMode === 'archive') {
        ui.archiveHint.textContent = `加载失败：${errorMessage(error)}`;
        ui.archiveList.replaceChildren();
      }
    } finally {
      setArchiveButtonBusy(false);
    }
  }

  function createUi() {
    const existingHost = document.getElementById(HOST_ID);
    if (existingHost) existingHost.remove();
    const existingModal = document.getElementById(MODAL_HOST_ID);
    if (existingModal) existingModal.remove();

    const host = document.createElement('div');
    host.id = HOST_ID;
    host.style.cssText = [
      'position:fixed',
      'right:22px',
      'top:50%',
      'transform:translateY(-50%)',
      'z-index:2147483646',
      'display:none',
      'flex-direction:column',
      'align-items:flex-end',
      'gap:9px',
      'pointer-events:none',
      'font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Helvetica Neue",Arial,sans-serif',
    ].join(';');

    const shadow = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = `
      * { box-sizing: border-box; }
      .panel {
        width: min(370px, calc(100vw - 48px));
        max-height: 60vh;
        overflow: auto;
        padding: 11px 14px;
        border: 1px solid rgba(255, 255, 255, 0.14);
        border-radius: 12px;
        background: rgba(20, 21, 26, 0.96);
        color: #f7f7fa;
        font: 500 12.5px/1.55 -apple-system, BlinkMacSystemFont, "PingFang SC",
          "Helvetica Neue", Arial, sans-serif;
        white-space: pre-line;
        overflow-wrap: anywhere;
        box-shadow: 0 10px 30px rgba(0, 0, 0, 0.28);
        opacity: 0;
        transform: translateY(6px);
        transition: opacity 160ms ease, transform 160ms ease;
        pointer-events: none;
      }
      .panel.show {
        opacity: 1;
        transform: translateY(0);
        pointer-events: auto;
      }
      .panel.success { border-color: rgba(48, 209, 88, 0.55); }
      .panel.error { border-color: rgba(255, 69, 58, 0.65); }
      .panel.info { border-color: rgba(255, 255, 255, 0.18); }
      .button-row,
      .mode-row {
        display: flex;
        gap: 8px;
        justify-content: flex-end;
        align-items: center;
        flex-wrap: wrap;
        pointer-events: none;
      }
      button {
        -webkit-appearance: none;
        appearance: none;
        margin: 0;
        cursor: pointer;
        pointer-events: auto;
        white-space: nowrap;
        transition: transform 120ms ease, box-shadow 120ms ease, opacity 120ms ease;
      }
      button:disabled { cursor: wait; opacity: 0.62; transform: none !important; }
      .primary {
        padding: 13px 17px;
        border: 0;
        border-radius: 999px;
        background: linear-gradient(135deg, #fe2c55 0%, #ff6b81 100%);
        color: #fff;
        font: 700 14px/1 -apple-system, BlinkMacSystemFont, "PingFang SC",
          "Helvetica Neue", Arial, sans-serif;
        letter-spacing: 0.2px;
        box-shadow: 0 8px 24px rgba(254, 44, 85, 0.38);
      }
      .primary:hover {
        transform: translateY(-1px);
        box-shadow: 0 10px 28px rgba(254, 44, 85, 0.48);
      }
      .secondary {
        padding: 10px 12px;
        border: 1px solid rgba(255, 255, 255, 0.16);
        border-radius: 999px;
        background: rgba(22, 23, 29, 0.94);
        color: #f5f5f8;
        font: 600 12px/1 -apple-system, BlinkMacSystemFont, "PingFang SC",
          "Helvetica Neue", Arial, sans-serif;
        box-shadow: 0 6px 18px rgba(0, 0, 0, 0.24);
      }
      .secondary:hover {
        background: rgba(42, 43, 52, 0.98);
        transform: translateY(-1px);
      }
      .shortcut-toggle {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 9px 11px;
        border: 1px solid rgba(255, 255, 255, 0.16);
        border-radius: 999px;
        background: rgba(22, 23, 29, 0.94);
        color: #f5f5f8;
        font: 600 12px/1 -apple-system, BlinkMacSystemFont, "PingFang SC",
          "Helvetica Neue", Arial, sans-serif;
        white-space: nowrap;
        pointer-events: auto;
        cursor: pointer;
        user-select: none;
        box-shadow: 0 6px 18px rgba(0, 0, 0, 0.24);
      }
      .shortcut-toggle input {
        width: 14px;
        height: 14px;
        margin: 0;
        accent-color: #fe2c55;
        cursor: pointer;
      }
      .auto-toggle.running {
        border-color: rgba(255, 184, 0, 0.65);
        background: linear-gradient(135deg, #e53e3e 0%, #dd6b20 100%);
        box-shadow: 0 8px 24px rgba(221, 107, 32, 0.38);
      }
      button:active { transform: translateY(0) scale(0.98); }
    `;

    const panel = document.createElement('div');
    panel.className = 'panel';
    panel.setAttribute('role', 'status');
    panel.setAttribute('aria-live', 'polite');

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'primary';
    button.textContent = '⬇ 一键下载';
    button.title = '下载当前抖音视频到 ~/Douyin_Saved';
    button.setAttribute('aria-label', '一键下载当前抖音视频');
    button.addEventListener('click', () => void handleDownload());

    const buttonRow = document.createElement('div');
    buttonRow.className = 'button-row';

    const copyButton = document.createElement('button');
    copyButton.type = 'button';
    copyButton.className = 'secondary';
    copyButton.textContent = '📋 复制作者UID';
    copyButton.title = '只解析作者 UID，不下载视频';
    copyButton.addEventListener('click', () => void handleCopyUid());

    const archiveButton = document.createElement('button');
    archiveButton.type = 'button';
    archiveButton.className = 'secondary';
    archiveButton.textContent = '📁 指定归档';
    archiveButton.title = '把当前视频归档到指定文件夹';
    archiveButton.addEventListener('click', () => void openArchiveModal());

    buttonRow.appendChild(copyButton);
    buttonRow.appendChild(archiveButton);

    const modeRow = document.createElement('div');
    modeRow.className = 'mode-row';

    const shortcutToggle = document.createElement('label');
    shortcutToggle.className = 'shortcut-toggle';
    shortcutToggle.title = '按 C 触发下载；不会阻止抖音原生取消收藏';
    const shortcutCheckbox = document.createElement('input');
    shortcutCheckbox.type = 'checkbox';
    shortcutCheckbox.checked = true;
    shortcutCheckbox.setAttribute('aria-label', '启用快捷键 C');
    const shortcutText = document.createElement('span');
    shortcutText.textContent = '启用快捷键 C';
    shortcutToggle.appendChild(shortcutCheckbox);
    shortcutToggle.appendChild(shortcutText);

    const autoButton = document.createElement('button');
    autoButton.type = 'button';
    autoButton.className = 'secondary auto-toggle';
    autoButton.textContent = '▶ 开始自动连播';
    autoButton.title = '自动下载并切换到下一个视频；仅在启用快捷键 C 时模拟取消收藏';
    autoButton.setAttribute('aria-pressed', 'false');
    autoButton.addEventListener('click', () => toggleAutoLoop());

    shortcutCheckbox.addEventListener('change', () => {
      shortcutEnabled = shortcutCheckbox.checked;
      if (!shortcutEnabled && shortcutDebounceTimer) {
        window.clearTimeout(shortcutDebounceTimer);
        shortcutDebounceTimer = 0;
      }
    });

    modeRow.appendChild(shortcutToggle);
    modeRow.appendChild(autoButton);

    shadow.appendChild(style);
    shadow.appendChild(panel);
    shadow.appendChild(button);
    shadow.appendChild(buttonRow);
    shadow.appendChild(modeRow);
    document.documentElement.appendChild(host);

    const modalHost = document.createElement('div');
    modalHost.id = MODAL_HOST_ID;
    modalHost.style.cssText = [
      'position:fixed',
      'inset:0',
      'z-index:2147483647',
      'display:none',
      'pointer-events:auto',
    ].join(';');
    const modalShadow = modalHost.attachShadow({ mode: 'closed' });
    const modalStyle = document.createElement('style');
    modalStyle.textContent = `
      * { box-sizing: border-box; }
      [hidden] { display: none !important; }
      .modal-backdrop {
        position: fixed;
        inset: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 16px;
        background: rgba(6, 7, 10, 0.64);
        backdrop-filter: blur(3px);
        font-family: -apple-system, BlinkMacSystemFont, "PingFang SC",
          "Helvetica Neue", Arial, sans-serif;
      }
      .modal-card {
        width: min(560px, calc(100vw - 32px));
        max-height: min(80vh, 720px);
        display: flex;
        flex-direction: column;
        overflow: hidden;
        border: 1px solid rgba(255, 255, 255, 0.14);
        border-radius: 18px;
        background: #1a1b21;
        color: #f7f7fa;
        box-shadow: 0 24px 80px rgba(0, 0, 0, 0.55);
      }
      .modal-head {
        padding: 18px 20px 0;
      }
      .modal-title {
        margin: 0;
        font: 700 18px/1.3 -apple-system, BlinkMacSystemFont, "PingFang SC",
          "Helvetica Neue", Arial, sans-serif;
      }
      .modal-message {
        margin: 10px 0 0;
        color: rgba(247, 247, 250, 0.78);
        font: 500 13px/1.6 -apple-system, BlinkMacSystemFont, "PingFang SC",
          "Helvetica Neue", Arial, sans-serif;
        white-space: pre-line;
        overflow-wrap: anywhere;
      }
      .archive-body {
        display: flex;
        flex-direction: column;
        gap: 8px;
        padding: 14px 20px 0;
        min-height: 0;
      }
      .archive-input {
        width: 100%;
        height: 42px;
        padding: 0 12px;
        border: 1px solid rgba(255, 255, 255, 0.18);
        border-radius: 10px;
        outline: none;
        background: #111218;
        color: #fff;
        font: 500 14px/1.2 -apple-system, BlinkMacSystemFont, "PingFang SC",
          "Helvetica Neue", Arial, sans-serif;
      }
      .archive-input:focus {
        border-color: rgba(254, 44, 85, 0.75);
        box-shadow: 0 0 0 3px rgba(254, 44, 85, 0.16);
      }
      .archive-hint {
        min-height: 17px;
        color: rgba(247, 247, 250, 0.5);
        font: 500 11.5px/1.45 -apple-system, BlinkMacSystemFont, "PingFang SC",
          "Helvetica Neue", Arial, sans-serif;
      }
      .folder-list {
        max-height: 300px;
        overflow: auto;
        border: 1px solid rgba(255, 255, 255, 0.1);
        border-radius: 10px;
        background: #14151b;
      }
      .folder-option {
        display: block;
        width: 100%;
        padding: 11px 12px;
        border: 0;
        border-bottom: 1px solid rgba(255, 255, 255, 0.055);
        background: transparent;
        color: #f2f2f6;
        text-align: left;
        font: 500 13px/1.35 -apple-system, BlinkMacSystemFont, "PingFang SC",
          "Helvetica Neue", Arial, sans-serif;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        cursor: pointer;
      }
      .folder-option:last-child { border-bottom: 0; }
      .folder-option:hover,
      .folder-option.active { background: rgba(254, 44, 85, 0.12); }
      .folder-option.selected {
        background: rgba(254, 44, 85, 0.2);
        color: #fff;
      }
      .folder-empty {
        padding: 22px 14px;
        color: rgba(247, 247, 250, 0.48);
        text-align: center;
        font: 500 13px/1.5 -apple-system, BlinkMacSystemFont, "PingFang SC",
          "Helvetica Neue", Arial, sans-serif;
      }
      .modal-actions {
        display: flex;
        justify-content: flex-end;
        gap: 10px;
        padding: 16px 20px 18px;
      }
      .btn {
        padding: 10px 15px;
        border-radius: 10px;
        font: 600 13px/1 -apple-system, BlinkMacSystemFont, "PingFang SC",
          "Helvetica Neue", Arial, sans-serif;
        cursor: pointer;
      }
      .btn:disabled { cursor: wait; opacity: 0.6; }
      .btn-primary {
        border: 0;
        background: linear-gradient(135deg, #fe2c55 0%, #ff6b81 100%);
        color: #fff;
      }
      .btn-secondary {
        border: 1px solid rgba(255, 255, 255, 0.16);
        background: rgba(255, 255, 255, 0.06);
        color: #f5f5f8;
      }
    `;

    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    const card = document.createElement('div');
    card.className = 'modal-card';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');

    const head = document.createElement('div');
    head.className = 'modal-head';
    const modalTitle = document.createElement('div');
    modalTitle.className = 'modal-title';
    const modalMessage = document.createElement('div');
    modalMessage.className = 'modal-message';
    head.appendChild(modalTitle);
    head.appendChild(modalMessage);

    const archiveBody = document.createElement('div');
    archiveBody.className = 'archive-body';
    const archiveInput = document.createElement('input');
    archiveInput.className = 'archive-input';
    archiveInput.type = 'text';
    archiveInput.autocomplete = 'off';
    archiveInput.spellcheck = false;
    archiveInput.placeholder = '输入文件夹名，例如 L 或 老王';
    const archiveHint = document.createElement('div');
    archiveHint.className = 'archive-hint';
    const archiveList = document.createElement('div');
    archiveList.className = 'folder-list';
    archiveList.setAttribute('role', 'listbox');
    archiveBody.appendChild(archiveInput);
    archiveBody.appendChild(archiveHint);
    archiveBody.appendChild(archiveList);

    const actions = document.createElement('div');
    actions.className = 'modal-actions';
    const modalCancel = document.createElement('button');
    modalCancel.type = 'button';
    modalCancel.className = 'btn btn-secondary';
    modalCancel.textContent = '取消';
    const modalConfirm = document.createElement('button');
    modalConfirm.type = 'button';
    modalConfirm.className = 'btn btn-primary';
    modalConfirm.textContent = '知道了';
    actions.appendChild(modalCancel);
    actions.appendChild(modalConfirm);

    card.appendChild(head);
    card.appendChild(archiveBody);
    card.appendChild(actions);
    backdrop.appendChild(card);
    modalShadow.appendChild(modalStyle);
    modalShadow.appendChild(backdrop);
    document.documentElement.appendChild(modalHost);

    modalCancel.addEventListener('click', () => closeModal());
    modalConfirm.addEventListener('click', () => {
      if (modalMode === 'archive') {
        void submitArchiveSelection();
      } else {
        closeModal();
      }
    });
    backdrop.addEventListener('click', (event) => {
      if (event.target === backdrop) closeModal();
    });
    archiveInput.addEventListener('input', handleArchiveInput);
    archiveInput.addEventListener('keydown', handleArchiveKeydown);
    document.addEventListener(
      'keydown',
      (event) => {
        if (event.key === 'Escape' && modalMode) closeModal();
      },
      true,
    );

    ui = {
      host,
      panel,
      button,
      copyButton,
      archiveButton,
      shortcutCheckbox,
      autoButton,
      modalHost,
      modalTitle,
      modalMessage,
      modalCancel,
      modalConfirm,
      archiveBody,
      archiveInput,
      archiveHint,
      archiveList,
    };
  }

  function syncVisible() {
    if (!ui) return;
    if (!document.documentElement.contains(ui.host)) {
      document.documentElement.appendChild(ui.host);
    }
    if (!document.documentElement.contains(ui.modalHost)) {
      document.documentElement.appendChild(ui.modalHost);
    }
    const visible = isSupportedPage();
    ui.host.style.display = visible ? 'flex' : 'none';
    if (!visible) {
      if (autoLoopRunning) stopAutoLoop(false);
      closeModal(true);
    }
  }

  async function pollJob(jobId, generation) {
    const startedAt = Date.now();
    let failures = 0;

    while (generation === pollGeneration && Date.now() - startedAt < POLL_TIMEOUT_MS) {
      let data;
      try {
        data = await apiRequest('GET', `/api/status/${encodeURIComponent(jobId)}`);
        failures = 0;
      } catch (error) {
        failures += 1;
        if (failures >= 3) {
          if (generation === pollGeneration) {
            setPanel(`查询下载状态失败：\n${errorMessage(error)}`, 'error', 12000);
          }
          return;
        }
        await sleep(POLL_INTERVAL_MS);
        continue;
      }

      const job = data.job;
      if (!job) {
        if (generation === pollGeneration) {
          setPanel('任务不存在，可能本地服务已重启。', 'error', 10000);
        }
        return;
      }

      if (job.status === 'queued') {
        if (generation === pollGeneration) {
          const target = job.target_folder ? `\n归档目标：${job.target_folder}` : '';
          setPanel(`已进入下载队列，等待处理…${target}`, 'info');
        }
      } else if (job.status === 'downloading') {
        if (generation === pollGeneration) {
          const author = job.author ? `\n作者：${job.author}` : '';
          const target = job.target_folder ? `\n归档目标：${job.target_folder}` : '';
          setPanel(`正在解析并下载…${author}${target}`, 'info');
        }
      } else if (job.status === 'success') {
        if (generation === pollGeneration) {
          const lines = [job.duplicate_of ? '该视频已存在，未重复下载。' : '下载完成。'];
          if (job.author) lines.push(`作者：${job.author}`);
          if (job.filename) lines.push(`文件：${job.filename}`);
          if (job.folder) lines.push(`目录：${job.folder}`);
          if (job.target_folder) lines.push(`归档目标：${job.target_folder}`);
          setPanel(lines.join('\n'), 'success', 15000);
        }
        return;
      } else if (job.status === 'error') {
        if (generation === pollGeneration) {
          setPanel(`下载失败：\n${job.error || '未知错误'}`, 'error', 18000);
        }
        return;
      }

      await sleep(POLL_INTERVAL_MS);
    }

    if (generation === pollGeneration) {
      setPanel('查询已超时，但任务可能仍在后台下载。可查看 ~/Douyin_Saved 或服务日志。', 'error', 12000);
    }
  }

  async function handleDownload() {
    if (busy) return;

    const generation = ++pollGeneration;
    setBusy(true, '识别中…');
    setPanel('正在识别当前播放的视频…', 'info');

    try {
      const id = await resolveCurrentVideoId();
      if (generation !== pollGeneration) return;
      if (!id) {
        setPanel(
          [
            '没有识别到当前视频 ID。',
            '推荐/关注/朋友页请先让视频出现在画面中并开始播放，再点一次。',
          ].join('\n'),
          'error',
          10000,
        );
        return;
      }

      const url = canonicalVideoUrl(id);
      setBusy(true, '提交中…');
      setPanel('正在提交到本地下载服务…', 'info');
      const data = await apiRequest('POST', '/api/download', { url });
      if (!data.ok || !data.job || !data.job.id) {
        throw new Error((data && data.error) || '本地服务没有返回任务 ID。');
      }
      if (generation !== pollGeneration) return;

      setPanel(
        data.duplicate ? '该链接已在队列中或最近已下载，正在查询…' : '已加入队列，开始下载…',
        'info',
      );
      void pollJob(data.job.id, generation);
    } catch (error) {
      if (generation === pollGeneration) {
        setPanel(`提交失败：\n${errorMessage(error)}`, 'error', 15000);
      }
    } finally {
      setBusy(false);
    }
  }

  function init() {
    createUi();
    syncVisible();
    window.setInterval(syncVisible, 800);
    window.addEventListener('popstate', syncVisible);
    window.addEventListener('hashchange', syncVisible);
    window.addEventListener('keydown', handleShortcutKeydown, true);
    window.addEventListener('beforeunload', () => {
      stopAutoLoop(false);
      if (shortcutDebounceTimer) {
        window.clearTimeout(shortcutDebounceTimer);
        shortcutDebounceTimer = 0;
      }
    });
  }

  installNetworkCapture();

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
