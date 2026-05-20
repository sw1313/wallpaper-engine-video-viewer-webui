/* Service Worker for Wallpaper WebUI
 *
 * 缓存策略：
 *   1) /media/preview/*      → stale-while-revalidate（保持原有逻辑）
 *   2) /media/video/{id}     → 分块（chunk）缓存：
 *        - 文件按 CHUNK_SIZE 切块存到 Cache Storage（每块独立条目）
 *        - Range 请求按需补块（已缓存的本地切，缺的并行向服务器拉）
 *        - 后台并行预取剩余块，填满整段
 *        - 跨设备/跨刷新都受益：拖动到任意位置只补需要的块，不再全等
 *   3) /media/audio/{id}     → 同上
 *
 * 解决的核心痛点：之前是「整文件单流顺序预取」，拖动 / 续播到未下载的中段
 * 浏览器只能走 fallback 直发，体感上和没装 SW 一样。
 *
 * 容量控制：
 *   - 最多缓存 VIDEO_CACHE_MAX_ENTRIES 个不同视频（按 URL 计，FIFO 淘汰）
 *   - 单文件超过 VIDEO_CACHE_MAX_FILE_BYTES 不缓存（直接 passthrough）
 */

const PREVIEW_CACHE = "wwui-preview-v2";
const MEDIA_CACHE   = "wwui-media-v2";   // 与 v1（整文件方案）格式不兼容，bump 版本

const VIDEO_CACHE_MAX_ENTRIES    = 3;
const VIDEO_CACHE_MAX_FILE_BYTES = 8 * 1024 * 1024 * 1024;  // 8GB 单文件上限
// chunk 越大，Range 请求次数越少、HTTPS 单连接被 TLS 卡顿的影响越小。
// 但太大会让 seek 的最小补块粒度变粗，32MB 在 2.5G LAN 下 ~0.5s 一块，可以接受。
const CHUNK_SIZE                 = 32 * 1024 * 1024;
// 浏览器对同 host 最多 6 个并发 HTTP/1.1 连接，吃满即可。
const PARALLEL_FILL_LIMIT        = 6;

// 同一个 chunk 的并发 fetch 去重
const inFlightChunks  = new Map();   // chunkKeyStr -> Promise<Blob>
// 已经 materialize 出来的块 Blob，减少重复 disk 读
const _blobMemoryCache = new Map();  // chunkKeyStr -> Blob
// 后台预取任务去重
const inFlightFills   = new Set();   // canonicalU

// =============== 通用工具 ===============

function isPreviewRequest(req) {
  try {
    const url = new URL(req.url);
    return url.origin === self.location.origin && url.pathname.startsWith("/media/preview/");
  } catch { return false; }
}

function isMediaStreamRequest(req) {
  try {
    const url = new URL(req.url);
    if (url.origin !== self.location.origin) return false;
    return url.pathname.startsWith("/media/video/") ||
           url.pathname.startsWith("/media/audio/");
  } catch { return false; }
}

// 把请求 URL 去掉 query 当作媒体标识（前端常加 ?v=ts 做强刷，SW 这层做规范化）
function canonicalUrl(url) {
  const u = new URL(url);
  return u.origin + u.pathname;
}

function metaKey(canonicalU)        { return new Request(canonicalU + "?__swmeta=1"); }
function chunkKey(canonicalU, idx)  { return new Request(canonicalU + "?__swchunk=" + idx); }
function chunkKeyStr(canonicalU, idx){ return canonicalU + "?__swchunk=" + idx; }

function parseRange(rangeHeader, totalSize) {
  const m = /^bytes=(\d+)-(\d*)$/.exec(rangeHeader || "");
  if (!m) return null;
  const start = parseInt(m[1], 10);
  const end = m[2] ? parseInt(m[2], 10) : totalSize - 1;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start > end || start >= totalSize) return null;
  return { start, end: Math.min(end, totalSize - 1) };
}

// =============== Metadata（size / contentType） ===============

async function readMetaFromCache(canonicalU) {
  try {
    const cache = await caches.open(MEDIA_CACHE);
    const r = await cache.match(metaKey(canonicalU));
    if (!r) return null;
    return await r.json();
  } catch { return null; }
}

async function writeMetaToCache(canonicalU, meta) {
  try {
    const cache = await caches.open(MEDIA_CACHE);
    await cache.put(metaKey(canonicalU), new Response(JSON.stringify(meta), {
      headers: { "Content-Type": "application/json" }
    }));
  } catch {}
}

// 用 Range: bytes=0-0 拿到 Content-Range / Content-Type，不需要 HEAD 端点
async function probeMetaFromServer(canonicalU) {
  const r = await fetch(canonicalU, {
    headers: { "Range": "bytes=0-0" },
    cache: "no-store",
  });
  if (!r.ok) throw new Error("probeMeta failed: " + r.status);
  try { if (r.body) await r.body.cancel(); } catch {}
  const cr = r.headers.get("Content-Range") || "";
  const m = /\/(\d+)\s*$/.exec(cr);
  if (!m) throw new Error("no Content-Range");
  const size = parseInt(m[1], 10);
  const contentType = r.headers.get("Content-Type") || "application/octet-stream";
  return { size, contentType };
}

const _metaInflight = new Map();
// 避免对同一个 URL 反复写 LRU index：浏览器播放期间每秒可能多个 Range 请求
// 都触发 ensureMeta，但实际只需要在「这个视频被用了」时打一次 LRU 戳。
const _lruTouchTs = new Map();          // canonicalU -> ms
const LRU_TOUCH_MIN_INTERVAL_MS = 30 * 1000;

async function ensureMeta(canonicalU) {
  const cached = await readMetaFromCache(canonicalU);
  if (cached) {
    maybeTouchLRU(canonicalU);
    return cached;
  }

  let p = _metaInflight.get(canonicalU);
  if (p) return p;

  p = (async () => {
    const meta = await probeMetaFromServer(canonicalU);
    if (meta.size > 0 && meta.size <= VIDEO_CACHE_MAX_FILE_BYTES) {
      await writeMetaToCache(canonicalU, meta);
      await touchVideoLRU(canonicalU);
    }
    return meta;
  })().finally(() => _metaInflight.delete(canonicalU));
  _metaInflight.set(canonicalU, p);
  return p;
}

function maybeTouchLRU(canonicalU) {
  const now = Date.now();
  const last = _lruTouchTs.get(canonicalU) || 0;
  if (now - last < LRU_TOUCH_MIN_INTERVAL_MS) return;
  _lruTouchTs.set(canonicalU, now);
  // 异步触发，不阻塞 ensureMeta
  touchVideoLRU(canonicalU);
}

// =============== Chunks ===============

async function readChunkBlob(canonicalU, idx) {
  const ks = chunkKeyStr(canonicalU, idx);
  const hit = _blobMemoryCache.get(ks);
  if (hit) return hit;
  try {
    const cache = await caches.open(MEDIA_CACHE);
    const r = await cache.match(chunkKey(canonicalU, idx));
    if (!r) return null;
    const blob = await r.blob();
    _blobMemoryCache.set(ks, blob);
    return blob;
  } catch { return null; }
}

async function writeChunkBlob(canonicalU, idx, blob, contentType) {
  try {
    const cache = await caches.open(MEDIA_CACHE);
    await cache.put(chunkKey(canonicalU, idx), new Response(blob, {
      headers: { "Content-Type": contentType }
    }));
    _blobMemoryCache.set(chunkKeyStr(canonicalU, idx), blob);
  } catch {}
}

async function fetchChunkFromServer(canonicalU, idx, meta) {
  const start = idx * CHUNK_SIZE;
  const end = Math.min(start + CHUNK_SIZE - 1, meta.size - 1);
  const r = await fetch(canonicalU, {
    headers: { "Range": `bytes=${start}-${end}` },
    cache: "no-store",
  });
  if (r.status !== 206 && r.status !== 200) {
    throw new Error("chunk fetch status: " + r.status);
  }
  return await r.blob();
}

// 已缓存就用本地，没缓存就从服务器拉并写入缓存。同一个 chunk 的并发请求自动去重。
function ensureChunkCached(canonicalU, idx, meta) {
  const ks = chunkKeyStr(canonicalU, idx);
  let p = inFlightChunks.get(ks);
  if (p) return p;
  p = (async () => {
    const existing = await readChunkBlob(canonicalU, idx);
    if (existing) return existing;
    const blob = await fetchChunkFromServer(canonicalU, idx, meta);
    await writeChunkBlob(canonicalU, idx, blob, meta.contentType);
    return blob;
  })().finally(() => inFlightChunks.delete(ks));
  inFlightChunks.set(ks, p);
  return p;
}

// =============== 后台预取所有 chunk ===============

async function backgroundFillAllChunks(canonicalU, meta) {
  if (inFlightFills.has(canonicalU)) return;
  inFlightFills.add(canonicalU);
  try {
    const numChunks = Math.ceil(meta.size / CHUNK_SIZE);
    const missing = [];
    for (let i = 0; i < numChunks; i++) {
      const has = await readChunkBlob(canonicalU, i);
      if (!has) missing.push(i);
    }
    let next = 0;
    const workers = Array.from({ length: PARALLEL_FILL_LIMIT }, async () => {
      while (next < missing.length) {
        const myIdx = missing[next++];
        try { await ensureChunkCached(canonicalU, myIdx, meta); }
        catch { /* 静默重试由下次 ensureChunkCached 触发 */ }
      }
    });
    await Promise.all(workers);
  } finally {
    inFlightFills.delete(canonicalU);
  }
}

// =============== LRU（按视频 URL 计） ===============

const LRU_KEY = new Request(self.location.origin + "/__sw_lru_index?v=1");
let _lruLock = Promise.resolve();

async function readLRUList() {
  try {
    const cache = await caches.open(MEDIA_CACHE);
    const r = await cache.match(LRU_KEY);
    if (!r) return [];
    return await r.json();
  } catch { return []; }
}
async function writeLRUList(list) {
  try {
    const cache = await caches.open(MEDIA_CACHE);
    await cache.put(LRU_KEY, new Response(JSON.stringify(list), {
      headers: { "Content-Type": "application/json" }
    }));
  } catch {}
}

async function deleteAllForUrl(canonicalU) {
  try {
    const cache = await caches.open(MEDIA_CACHE);
    const keys = await cache.keys();
    const prefix = canonicalU + "?__sw";
    const toDel = keys.filter(k => k.url.startsWith(prefix));
    for (const k of toDel) {
      _blobMemoryCache.delete(k.url);
      try { await cache.delete(k); } catch {}
    }
  } catch {}
}

function touchVideoLRU(canonicalU) {
  // 用串行锁保证并发并发的 ensureMeta 不会让 LRU 列表错乱
  _lruLock = _lruLock.then(async () => {
    let list = await readLRUList();
    list = list.filter(u => u !== canonicalU);
    list.push(canonicalU);
    while (list.length > VIDEO_CACHE_MAX_ENTRIES) {
      const old = list.shift();
      if (old) await deleteAllForUrl(old);
    }
    await writeLRUList(list);
  }).catch(() => {});
  return _lruLock;
}

// =============== Range 流式响应 ===============

// 构造一个 ReadableStream，按需补块并切片喂给浏览器。
// 浏览器 cancel 后 pull 不再被调用，停止补块，避免无谓带宽。
function buildChunkedStream(canonicalU, meta, startChunk, endChunk, start, end) {
  let cur = startChunk;
  return new ReadableStream({
    async pull(controller) {
      if (cur > endChunk) {
        controller.close();
        return;
      }
      const idx = cur++;
      try {
        const blob = await ensureChunkCached(canonicalU, idx, meta);
        const chunkStart = idx * CHUNK_SIZE;
        const sliceStart = Math.max(0, start - chunkStart);
        const sliceEnd   = Math.min(blob.size, end - chunkStart + 1);
        if (sliceEnd <= sliceStart) return;
        const buf = await blob.slice(sliceStart, sliceEnd).arrayBuffer();
        controller.enqueue(new Uint8Array(buf));
      } catch (e) {
        try { controller.error(e); } catch {}
      }
    },
    cancel() { /* no-op：仅停止后续 pull，已发出的 chunk fetch 会继续填 cache */ },
  });
}

async function serveRange(req, canonicalU) {
  const meta = await ensureMeta(canonicalU);
  if (!meta || !meta.size) {
    return fetch(req);
  }
  if (meta.size > VIDEO_CACHE_MAX_FILE_BYTES) {
    // 超大文件不走 chunk 缓存，直接交给浏览器原生 Range
    return fetch(req);
  }

  const rangeHeader = req.headers.get("Range");
  let start = 0, end = meta.size - 1, isPartial = false;
  if (rangeHeader) {
    const r = parseRange(rangeHeader, meta.size);
    if (!r) {
      return new Response("", {
        status: 416,
        statusText: "Range Not Satisfiable",
        headers: { "Content-Range": `bytes */${meta.size}` },
      });
    }
    start = r.start; end = r.end; isPartial = true;
  }

  const startChunk = Math.floor(start / CHUNK_SIZE);
  const endChunk   = Math.floor(end / CHUNK_SIZE);

  const body = buildChunkedStream(canonicalU, meta, startChunk, endChunk, start, end);

  const headers = new Headers({
    "Content-Type":   meta.contentType,
    "Content-Length": String(end - start + 1),
    "Accept-Ranges":  "bytes",
    "Cache-Control":  "public, max-age=31536000, immutable",
  });
  if (isPartial) headers.set("Content-Range", `bytes ${start}-${end}/${meta.size}`);

  return new Response(body, {
    status: isPartial ? 206 : 200,
    statusText: isPartial ? "Partial Content" : "OK",
    headers,
  });
}

// =============== 主分发 ===============

async function handleMediaStreamRequest(req) {
  const canonicalU = canonicalUrl(req.url);

  // 启动 / 续跑后台整文件预取（不 await）。已经在跑的会被 inFlightFills 去重。
  (async () => {
    try {
      const meta = await ensureMeta(canonicalU);
      if (meta && meta.size && meta.size <= VIDEO_CACHE_MAX_FILE_BYTES) {
        backgroundFillAllChunks(canonicalU, meta);
      }
    } catch {}
  })();

  try {
    return await serveRange(req, canonicalU);
  } catch (e) {
    try { return await fetch(req); }
    catch { return new Response("", { status: 502, statusText: "SW serve failed" }); }
  }
}

// =============== 预览图缓存（保留原有逻辑） ===============

async function handlePreviewRequest(req) {
  const cache = await caches.open(PREVIEW_CACHE);
  const cached = await cache.match(req, { ignoreSearch: false });

  const fetchAndUpdate = fetch(req).then(async (resp) => {
    try { if (resp && resp.ok) await cache.put(req, resp.clone()); } catch {}
    return resp;
  }).catch(() => null);

  if (cached) return cached;
  const net = await fetchAndUpdate;
  return net || new Response("", { status: 504, statusText: "SW cache miss & network error" });
}

// =============== 事件 ===============

self.addEventListener("install", () => { self.skipWaiting(); });

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    const keep = new Set([PREVIEW_CACHE, MEDIA_CACHE]);
    await Promise.all(keys.map(k => keep.has(k) ? null : caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  if (isPreviewRequest(req)) {
    event.respondWith(handlePreviewRequest(req));
    return;
  }
  if (isMediaStreamRequest(req)) {
    event.respondWith(handleMediaStreamRequest(req));
    return;
  }
});

self.addEventListener("message", (event) => {
  const data = event.data || {};
  if (data.type === "wwui-clear-media-cache") {
    event.waitUntil((async () => {
      try { _blobMemoryCache.clear(); } catch {}
      try { inFlightChunks.clear(); } catch {}
      try { inFlightFills.clear(); } catch {}
      try { _metaInflight.clear(); } catch {}
      try { await caches.delete(MEDIA_CACHE); } catch {}
    })());
  }
});
