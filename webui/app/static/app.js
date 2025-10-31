/* app/static/app.js (fs-42a-keepalive-busy-prime)
 * 新增：
 * 1) 后台保活：后台音频播放时启用 WebAudio 常量源 + 45s keepalive 心跳
 * 2) Busy 提前显示：在所有播放入口“点击瞬间”就出现“正在启动播放器…”
 * 继续保留：前后台同集同步、双声消除、二次暂停后不回跳、拖动保护、8s 卡顿兜底、faststart 一次性修复
 */
console.log("app.js version fs-42a-keepalive-busy-prime");

/* ===================== 公共状态与工具 ===================== */

let state = { path:"/", page:1, per_page:45, sort_idx:0, mature_only:false, q:"",
  selV:new Set(), selF:new Set(), lastIdx:null, tiles:[], dragging:false, dragStart:null, keepSelection:false,
  isLoading:false, hasMore:true, queryKey:"" };

let player = { ids:[], titles:{}, index:0, idleTimer:null, returnPath:"/" };

let media = { v: null, a: null };
let playbackMode = "video";
let fsOverlayInHistory = false;

let _userPaused = false;
function markUserPaused(){ _userPaused = true; }
function clearUserPaused(){ _userPaused = false; }

/* === 音频时间轴偏移（bias） === */
let audioBias = 0;

/* === 卡顿触发阈值（毫秒） === */
const STALL_REPAIR_GRACE_MS = 8000;

/* === 拖动进度保护（避免切换/重载） === */
const scrubGuard = { active:false, timer:null };
function beginScrubGuard(){
  scrubGuard.active = true;
  if (scrubGuard.timer) clearTimeout(scrubGuard.timer);
  scrubGuard.timer = setTimeout(()=>{ scrubGuard.active = false; }, 1600);
}
function endScrubGuardSoon(){
  if (scrubGuard.timer) clearTimeout(scrubGuard.timer);
  scrubGuard.timer = setTimeout(()=>{ scrubGuard.active = false; }, 400);
}

/* === 全局忙碌遮罩（转圈 + 阻塞） === */
let busyShown = false, busyGuardsOn = false;
function ensureBusyStyles(){
  if (document.getElementById("busy-style")) return;
  const css = `
  #screenBusy{position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:999999;display:none;align-items:center;justify-content:center}
  #screenBusy .box{min-width:220px;display:flex;gap:12px;align-items:center;padding:14px 18px;border-radius:12px;background:rgba(20,20,20,.92);color:#fff;font:500 14px/1.2 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto}
  #screenBusy .spin{width:22px;height:22px;border:3px solid #9aa0a6;border-top-color:transparent;border-radius:50%;animation:sbspin .9s linear infinite}
  @keyframes sbspin{to{transform:rotate(360deg)}}`;
  const s = document.createElement("style"); s.id="busy-style"; s.textContent = css; document.head.appendChild(s);
}
function ensureBusyEl(){
  ensureBusyStyles();
  if (document.getElementById("screenBusy")) return;
  const d = document.createElement("div");
  d.id = "screenBusy";
  d.innerHTML = `<div class="box"><div class="spin"></div><div class="txt" id="busyText">正在准备播放器…</div></div>`;
  document.body.appendChild(d);
}
function installBusyGuards(){
  if (busyGuardsOn) return;
  busyGuardsOn = true;
  const f = (e)=>{ e.preventDefault(); e.stopPropagation(); };
  const opts = { capture:true, passive:false };
  const types = ["pointerdown","pointermove","pointerup","click","contextmenu","touchstart","touchmove","wheel","keydown","keyup"];
  types.forEach(t=> document.addEventListener(t, f, opts));
  installBusyGuards._f = f;
  installBusyGuards._types = types;
}
function removeBusyGuards(){
  if (!busyGuardsOn) return;
  busyGuardsOn = false;
  const f = installBusyGuards._f, types = installBusyGuards._types||[];
  types.forEach(t=> document.removeEventListener(t, f, {capture:true}));
}
function showBusy(text="正在加载…"){
  ensureBusyEl();
  const el = document.getElementById("screenBusy");
  const txt = document.getElementById("busyText");
  if (txt) txt.textContent = text;
  el.style.display = "flex";
  installBusyGuards();
  busyShown = true;
}
function hideBusy(){
  const el = document.getElementById("screenBusy");
  if (el) el.style.display = "none";
  removeBusyGuards();
  busyShown = false;
}
/* 让 Busy “更早出现”的工具：如果没显示就立刻显示 */
function primeBusy(text="正在启动播放器…"){
  if (!busyShown) showBusy(text);
  else {
    const t = document.getElementById("busyText");
    if (t) t.textContent = text;
  }
}

let prefetchState = { key:"", page:0, opts:null, data:null, controller:null, inflight:false };
let progressive = { key:"", running:false, cancel:false, seen:new Set() };
let uiLock = { byPlaylist:false };
const modalGuards = [];
function addModalGuard(type, handler, opts){ document.addEventListener(type, handler, opts); modalGuards.push([type, handler, opts]); }
function removeModalGuards(){ for(const [t,h,o] of modalGuards){ document.removeEventListener(t,h,o); } modalGuards.length = 0; }

const $ = (id) => document.getElementById(id);
const grid = () => $("grid");

function detectByUA(){
  const ua = navigator.userAgent || navigator.vendor || window.opera || "";
  try {
    const o = localStorage.getItem("uaMode");
    if (o === "desktop") return { isMobile: false, ua };
    if (o === "mobile")  return { isMobile: true, ua };
  } catch(_) {}
  const isMobile = /Android|iPhone|iPad|iPod|Windows Phone|Mobi|Mobile|Tablet|Kindle|Silk|Opera Mini|BlackBerry|BB10/i.test(ua);
  return { isMobile, ua };
}
const UA = detectByUA();
const IS_MOBILE_UA = UA.isMobile;

const watchedCache = new Map();
function isWatched(id){ return watchedCache.get(String(id)) === true; }
function paintWatchedButton(btn, on){
  btn.classList.toggle("on", !!on);
  btn.classList.toggle("off", !on);
  btn.setAttribute("aria-pressed", on ? "true" : "false");
  btn.title = on ? "点击标记为未观看" : "点击标记为已观看";
}
function updateTileWatchedUI(id, on){
  const t = state.tiles.find(t => t.type==="video" && String(t.vid)===String(id));
  if (!t) return;
  const btn = t.el.querySelector(".watched-btn");
  if (btn) paintWatchedButton(btn, on);
}
async function apiGetWatched(ids){
  if (!ids.length) return new Set();
  const qs = new URLSearchParams({ ids: ids.join(",") });
  const r = await fetch(`/api/watched?${qs.toString()}`).catch(()=>null);
  if (!r || !r.ok) return new Set();
  const j = await r.json().catch(()=>({watched:[]}));
  return new Set((j.watched || []).map(String));
}
async function apiSetWatched(ids, flag=true){
  if (!ids.length) return;
  try{
    await fetch("/api/watched",{
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body: JSON.stringify({ ids: ids.map(String), watched: !!flag })
    });
  }catch(_){}
}
async function syncWatched(ids){
  const uniq = [...new Set(ids.map(String))];
  for (let i=0;i<uniq.length;i+=500){
    const part = uniq.slice(i, i+500);
    const set = await apiGetWatched(part);
    part.forEach(id=>{
      const on = set.has(String(id));
      watchedCache.set(String(id), on);
      updateTileWatchedUI(id, on);
    });
  }
}
async function setWatchedOptimistic(id, on){
  const idStr = String(id);
  const prev = isWatched(idStr);
  watchedCache.set(idStr, on);
  updateTileWatchedUI(idStr, on);
  try{
    await apiSetWatched([idStr], on);
  }catch(e){
    watchedCache.set(idStr, prev);
    updateTileWatchedUI(idStr, prev);
    showNotice("网络异常：已回滚观看状态");
    setTimeout(clearNotice, 1600);
  }
}
async function markWatched(id){ return setWatchedOptimistic(id, true); }
async function unmarkWatched(id){ return setWatchedOptimistic(id, false); }

document.addEventListener("dragstart", e => e.preventDefault());
const sleep = (ms)=> new Promise(r=>setTimeout(r,ms));
function chunk(arr, size){ const out=[]; for(let i=0;i<arr.length;i+=size) out.push(arr.slice(i,i+size)); return out; }
function showNotice(msg){ const n=$("notice"); if(!n) return; n.style.display="block"; n.innerHTML="ℹ︎ " + msg; }
function clearNotice(){ const n=$("notice"); if(!n) return; n.style.display="none"; n.textContent=""; }
function fmtSize(sz){ if (sz>=1<<30) return (sz/(1<<30)).toFixed(1)+" GB"; if (sz>=1<<20) return (sz/(1<<20)).toFixed(1)+" MB"; if (sz>=1<<10) return (sz/(1<<10)).toFixed(1)+" KB"; return sz+" B"; }
function fmtDate(ts){ return new Date(ts*1000).toLocaleString(); }
function isSel(t){ return t.type==="video" ? state.selV.has(t.vid) : state.selF.has(t.path); }
function setSel(t,on){ if(t.type==="video"){on?state.selV.add(t.vid):state.selV.delete(t.vid);} else {on?state.selF.add(t.path):state.selF.delete(t.path);} t.el.classList.toggle("selected",on); }
function clearSel(){ state.tiles.forEach(t=>t.el.classList.remove("selected")); state.selV.clear(); state.selF.clear(); }

/* ====================== 路由/列表/分页 ====================== */

function pathFromHash(){
  let h = window.location.hash || "";
  if (!h || h === "#") return "/";
  if (h.startsWith("#")) h = h.slice(1);
  if (!h.startsWith("/")) h = "/" + h;
  return decodeURI(h);
}
function navigateToPath(path){
  if (!path) path = "/";
  const target = "#" + encodeURI(path);
  if (window.location.hash === target) changeContext({path});
  else window.location.hash = target;
}
function onHashChange(){
  const newPath = pathFromHash();
  if (newPath !== state.path) changeContext({path:newPath});
}
window.addEventListener("hashchange", onHashChange);

function renderSkeleton(nextBreadcrumb) {
  if (nextBreadcrumb) $("crumb").innerHTML = "当前位置：" + nextBreadcrumb;
  const g = grid(); g.innerHTML = "";
  for (let i=0;i<16;i++){
    const el = document.createElement("div");
    el.className = "skeleton";
    el.innerHTML = `<div class="skel-thumb"></div><div class="skel-line"></div><div class="skel-line" style="width:60%"></div>`;
    g.appendChild(el);
  }
}
function makeQueryKey(){ return `${state.path}|${state.sort_idx}|${state.mature_only?'1':'0'}|${state.q}`; }
function snapshotOpts(){ return { path:state.path, sort_idx:state.sort_idx, mature_only:state.mature_only, q:state.q, per_page:state.per_page }; }

async function apiScan(opts, page, signal){
  const params = new URLSearchParams({ path:opts.path, page, per_page:opts.per_page, sort_idx:opts.sort_idx, mature_only:String(opts.mature_only), q:opts.q });
  const res = await fetch(`/api/scan?${params.toString()}`, { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function resetPrefetch(){ if (prefetchState.controller) try{ prefetchState.controller.abort(); }catch(_){}
  prefetchState = { key:"", page:0, opts:null, data:null, controller:null, inflight:false };
}
async function schedulePrefetch(){
  if (!state.hasMore) return;
  const key = makeQueryKey();
  const pageToPrefetch = state.page;
  if (prefetchState.inflight && prefetchState.key === key && prefetchState.page === pageToPrefetch) return;
  if (prefetchState.data && prefetchState.key === key && prefetchState.page === pageToPrefetch) return;
  resetPrefetch();
  prefetchState.key = key; prefetchState.page = pageToPrefetch; prefetchState.opts = snapshotOpts();
  prefetchState.controller = new AbortController(); prefetchState.inflight = true;
  try{
    const data = await apiScan(prefetchState.opts, prefetchState.page, prefetchState.controller.signal);
    if (prefetchState.key===key && prefetchState.page===pageToPrefetch) prefetchState.data = data;
  }catch{ prefetchState.data=null; } finally{ prefetchState.inflight=false; }
}

let autoFillRunning = false;
async function autoFillViewport(maxLoops=3){
  if (autoFillRunning) return; autoFillRunning = true;
  try{
    let loops=0;
    while (loops<maxLoops) {
      if (!state.hasMore || state.isLoading) break;
      const sent=$("sentinel"); if (!sent) break;
      const rect = sent.getBoundingClientRect();
      if (rect.top - window.innerHeight > 1000) break;
      await loadNextPage(); loops++;
    }
  } finally { autoFillRunning=false; }
}

let io=null, rubberBound=false;
async function loadNextPage(){
  if (state.isLoading || !state.hasMore) return;
  state.isLoading = true;
  const keyAtStart = state.queryKey = makeQueryKey();
  setInfStatus("加载中…");
  const usePrefetch = (prefetchState.data && prefetchState.key===keyAtStart && prefetchState.page===state.page);
  try{
    let data;
    if (usePrefetch){ data=prefetchState.data; prefetchState.data=null; }
    else { const opts=snapshotOpts(); data = await apiScan(opts, state.page, undefined); if (keyAtStart!==makeQueryKey()){ state.isLoading=false; return; } }
    const crumb = ["<a class='link' href='#/'>/</a>"].concat(
      data.breadcrumb.map((seg,i)=>{const p="/"+data.breadcrumb.slice(0,i+1).join("/"); return `<a class='link' href='#${p}'>${seg}</a>`;})
    ).join(" / ");
    $("crumb").innerHTML = "当前位置：" + crumb;

    if (state.page===1){ grid().innerHTML=""; state.tiles=[]; }
    const newIds = appendTiles(data);
    if (newIds.length) syncWatched(newIds);

    state.hasMore = state.page < data.total_pages;
    state.page += 1;
    setInfStatus(state.hasMore ? "下拉加载更多…" : "已到底部");

    bindDelegatedEvents(); bindRubber(); schedulePrefetch();
  }catch{ setInfStatus("加载失败，请重试"); }
  finally{ state.isLoading=false; queueMicrotask(()=>autoFillViewport(3)); }
}

function appendTiles(data){
  let idx = state.tiles.length;
  const batchVideoIds = [];

  data.folders.forEach(f=>{
    const path = (state.path.endsWith("/")? state.path : state.path + "/") + f.title;
    const el = document.createElement("div");
    el.className="tile folder"; el.dataset.type="folder"; el.dataset.path=path; el.dataset.idx=idx;
    el.innerHTML = `<div class="thumb"><div class="big">📁</div></div>
                    <div class="title">${f.title}</div>
                    <div class="meta">(${f.count}) 项</div>
                    <button class="tile-menu" title="菜单">⋮</button>`;
    grid().appendChild(el); state.tiles.push({el, type:"folder", path, idx, title:f.title}); idx++;
  });

  (data.videos||[]).forEach(v=>{
    const done = isWatched(v.id);
    const base = v.preview_url;
    const s128 = `${base}?s=128`;
    const s192 = `${base}?s=192`;
    const s256 = `${base}?s=256`;
    const s384 = `${base}?s=384`;
    const s512 = `${base}?s=512`;
    const fallback = base;
    const el = document.createElement("div");
    el.className="tile"; el.dataset.type="video"; el.dataset.vid=v.id; el.dataset.idx=idx;
    el.innerHTML = `<div class="thumb">
                      <img
                        src="${s256}"
                        srcset="${s128} 128w, ${s192} 192w, ${s256} 256w, ${s384} 384w, ${s512} 512w"
                        sizes="(max-width:640px) 48vw, 190px"
                        alt="preview" draggable="false" loading="lazy" decoding="async" fetchpriority="low"
                        onerror="this.onerror=null; this.src='${fallback}'"
                      />
                    </div>
                    <button class="watched-btn ${done?'on':'off'}" aria-label="切换观看状态" aria-pressed="${done?'true':'false'}" title="${done?'点击标记为未观看':'点击标记为已观看'}">✓</button>
                    <div class="title">${v.title}</div>
                    <div class="meta">${fmtDate(v.mtime)} · ${fmtSize(v.size)} · ${v.rating||"-"}</div>
                    <button class="tile-menu" title="菜单">⋮</button>`;
    grid().appendChild(el); state.tiles.push({el, type:"video", vid:v.id, idx, title:v.title}); idx++;
    batchVideoIds.push(String(v.id));

    const img = el.querySelector("img");
    if (isPlayerActive()) deferImage(img);
  });

  return batchVideoIds;
}

/* —— 封面图延迟载入 —— */
function deferImage(img){
  if (!img || img.dataset.deferred === "1") return;
  img.dataset.deferred = "1";
  img.dataset.deferSrc = img.getAttribute("src") || "";
  img.dataset.deferSrcset = img.getAttribute("srcset") || "";
  img.dataset.deferSizes = img.getAttribute("sizes") || "";
  try{ img.removeAttribute("srcset"); }catch(_){}
  try{ img.removeAttribute("src"); }catch(_){}
}
function resumeImage(img){
  if (!img || img.dataset.deferred !== "1") return;
  const { deferSrc, deferSrcset, deferSizes } = img.dataset;
  if (deferSizes) img.setAttribute("sizes", deferSizes);
  if (deferSrcset) img.setAttribute("srcset", deferSrcset);
  if (deferSrc) img.setAttribute("src", deferSrc);
  delete img.dataset.deferred;
  delete img.dataset.deferSrc;
  delete img.dataset.deferSrcset;
  delete img.dataset.deferSizes;
}
function suspendGridImageLoads(){ document.querySelectorAll("#grid img").forEach(img=>{ if (!img.complete) deferImage(img); }); }
function resumeGridImageLoads(){ document.querySelectorAll("#grid img").forEach(resumeImage); }

function setInfStatus(text){ const el=$("infiniteStatus"); if(el) el.textContent = text || ""; }

function changeContext({path, sort_idx, mature_only, q}={}){
  if (path!==undefined) state.path = path;
  if (sort_idx!==undefined) state.sort_idx = sort_idx;
  if (mature_only!==undefined) state.mature_only = mature_only;
  if (q!==undefined) state.q = q;
  cancelProgressive();
  clearSel(); state.page=1; state.hasMore=true; state.isLoading=false; state.queryKey=makeQueryKey();
  resetPrefetch(); renderSkeleton(buildCrumbHtml(state.path)); setInfStatus("加载中…");
  if (!io){ const sentinel=$("sentinel");
    io = new IntersectionObserver((entries)=>entries.forEach(e=>{ if (e.isIntersecting) loadNextPage(); }), { root:null, rootMargin:"1000px 0px", threshold:0 });
    io.observe(sentinel);
  }
  loadNextPage();
}

function buildCrumbHtml(pathStr){
  const html = ["<a class='link' href=\"#/\">/</a>"];
  const segs = pathStr.split("/").filter(Boolean);
  segs.forEach((seg,i)=>{ const p="/"+segs.slice(0,i+1).join("/"); html.push(`<a class='link' href='#${p}'>${seg}</a>`); });
  return "当前位置：" + html.join(" / ");
}

/* =================== 播放控制（无 MSE） =================== */

let userGestureUnlocked = false;
async function unlockPlaybackOnUserGesture(){
  if (userGestureUnlocked) return;
  const a = $("bgAudio"), v = $("fsVideo");
  try { await a.play(); a.pause(); userGestureUnlocked = true; }
  catch { try { await v.play(); v.pause(); userGestureUnlocked = true; } catch{} }
}
function installUserGestureUnlock(){
  const once = async ()=>{
    await unlockPlaybackOnUserGesture();
    document.removeEventListener("pointerdown", once);
    document.removeEventListener("touchstart", once);
    document.removeEventListener("click", once);
    document.removeEventListener("keydown", once);
  };
  document.addEventListener("pointerdown", once, {passive:true});
  document.addEventListener("touchstart", once, {passive:true});
  document.addEventListener("click", once, {passive:true});
  document.addEventListener("keydown", once, {passive:true});
}
window.addEventListener("load", installUserGestureUnlock);

/* --- 全屏返回栈 --- */
function installPopStateGuard(){
  window.addEventListener("popstate", () => {
    if (isPlayerActive()){
      fsOverlayInHistory = false;
      exitPlayer();
    }
  });
}
installPopStateGuard();

/* --- 禁用 PIP --- */
function enforceNoPIP(v){
  if (!v) return;
  try{ v.disablePictureInPicture = true; v.setAttribute("disablepictureinpicture",""); }catch(_){}
  try{ v.disableRemotePlayback = true; }catch(_){}
  v.addEventListener("enterpictureinpicture", async ()=>{
    try{ if (document.pictureInPictureElement) await document.exitPictureInPicture(); }catch(_){}
  });
}

/* --- play 封装 --- */
async function safePlay(el){ try { await el.play(); return true; } catch { return false; } }

/* ---------- 源地址 ---------- */
function mediaVideoSrcOf(id, cacheBust=false){ return `/media/video/${id}` + (cacheBust ? `?v=${Date.now()}` : ""); }
function audioSrcOf(id, cacheBust=false){ return `/media/audio/${id}` + (cacheBust ? `?v=${Date.now()}` : ""); }

/* === 计算并应用 audio 偏移（bias） === */
function computeAudioBias(a){
  let b = 0;
  try{
    if (a.seekable && a.seekable.length > 0){
      const s = a.seekable.start(0);
      if (Number.isFinite(s) && s > 0) b = s;
    }
  }catch(_){}
  return b;
}

/* ========== 后台保活（best-effort） ========== */
const keepAlive = { ctx:null, gain:null, src:null, pingTimer:null, active:false };
async function startBgKeepAlive(){
  if (keepAlive.active) return;
  keepAlive.active = true;
  try{
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return; // 老浏览器
    if (!keepAlive.ctx) keepAlive.ctx = new AC({ latencyHint: "interactive" });
    await keepAlive.ctx.resume().catch(()=>{});
    if (!keepAlive.gain){
      keepAlive.gain = keepAlive.ctx.createGain();
      keepAlive.gain.gain.value = 1e-7; // 极低电平，实际不可闻
      keepAlive.gain.connect(keepAlive.ctx.destination);
    }
    if (!keepAlive.src){
      if (keepAlive.ctx.createConstantSource){
        keepAlive.src = keepAlive.ctx.createConstantSource();
        keepAlive.src.offset.value = 0.0;
      } else {
        // 兜底：1Hz 正弦
        keepAlive.src = keepAlive.ctx.createOscillator();
        keepAlive.src.frequency.value = 1;
      }
      keepAlive.src.connect(keepAlive.gain);
      try{ keepAlive.src.start(); }catch(_){}
    }
    if (keepAlive.pingTimer) clearInterval(keepAlive.pingTimer);
    keepAlive.pingTimer = setInterval(()=>{
      if (document.visibilityState === "hidden"){
        try{
          fetch("/api/keepalive", { method:"POST", body:"1", keepalive:true, cache:"no-store", headers:{ "Content-Type":"text/plain" } }).catch(()=>{});
        }catch(_){}
      }
    }, 45000); // 45s 心跳
  }catch(_){
    keepAlive.active = false;
  }
}
function stopBgKeepAlive(){
  keepAlive.active = false;
  if (keepAlive.pingTimer){ clearInterval(keepAlive.pingTimer); keepAlive.pingTimer = null; }
  if (keepAlive.ctx){
    try{ keepAlive.ctx.suspend(); }catch(_){}
  }
}

/* === 附加/预热（带 seek 策略） === */
async function attachVideoSrc(src, resumeAt){
  const v = media.v || $("fsVideo");
  if (!v) return;
  enforceNoPIP(v);
  const curAttr = v.getAttribute("src") || "";
  const needReload = curAttr !== src;
  if (needReload){ v.src = src; try{ v.load(); }catch(_){} }
  setCurrentTimeWhenReady(v, resumeAt||0);
}
async function attachAudioSrc(src, resumeAt, {muted=true, ensurePlay=true, seek='smart'}={}){
  const a = media.a || $("bgAudio");
  if (!a) return;
  try{
    const prevSrc = a.getAttribute("src") || "";
    const needReload = (prevSrc !== src);
    if (needReload){ a.src = src; a.load(); }
    a.muted = !!muted; a.volume = muted ? 0 : Math.max(0.6, a.volume||0.6);

    const setTime = ()=>{
      audioBias = computeAudioBias(a);
      if (Number.isFinite(resumeAt)) {
        const target = Math.max(0, (resumeAt||0) + (audioBias||0));
        const diff = Math.abs((a.currentTime||0) - target);
        const shouldSeek = (seek === 'force') || (seek === 'smart' && (needReload || diff > 0.5));
        if (shouldSeek){ try{ a.currentTime = target; }catch(_){ } }
      }
    };

    if (a.readyState >= 1) setTime();
    else a.addEventListener("loadedmetadata", function once(){ a.removeEventListener("loadedmetadata", once); setTime(); });

    if (ensurePlay){ try{ await a.play(); clearUserPaused(); }catch(_){ } }
  }catch(_){}
}
function prewarmVideo(srcUrl, resumeAt){
  queueMicrotask(async ()=>{
    try{
      await attachVideoSrc(srcUrl, resumeAt||0);
      const v = media.v || $("fsVideo");
      if (v){ try{ v.pause(); }catch(_){ } }
    }catch(_){}
  });
}
function prewarmAudio(srcUrl, resumeAt){
  queueMicrotask(async ()=>{
    try{ await attachAudioSrc(srcUrl, resumeAt||0, { muted:true, ensurePlay:true, seek:'smart' }); }catch(_){}
  });
}

async function detachVideoSrc(){
  const v = media.v || $("fsVideo");
  if (!v) return;
  try{ v.pause(); }catch(_){}
  try{ v.removeAttribute("src"); v.load(); }catch(_){}
}

/* —— 前台对齐（视频前台、音频静音跟随时用） —— */
let fgSyncTimer = null;
function startFgSync(){
  if (fgSyncTimer) return;
  const v = media.v||$("fsVideo"), a = media.a||$("bgAudio");
  if (!v || !a) return;
  fgSyncTimer = setInterval(()=>{
    if (document.visibilityState !== "visible") return;
    if (a.paused) return;
    if (a.muted && Number.isFinite(v.currentTime)) {
      const target = (v.currentTime||0) + (audioBias||0);
      const dv = Math.abs((a.currentTime||0) - target);
      if (dv > 0.5) { try{ a.currentTime = target; }catch(_){ } }
    }
  }, 1500);
}
function stopFgSync(){ if (fgSyncTimer){ clearInterval(fgSyncTimer); fgSyncTimer=null; } }

/* —— 后台 near-end 兜底 —— */
const bgAdvanceGuard = { timer:null };
function startBgAdvanceGuard(){
  if (bgAdvanceGuard.timer) return;
  const a = media.a || $("bgAudio");
  if (!a) return;
  bgAdvanceGuard.timer = setInterval(()=>{
    if (!isPlayerActive() || playbackMode !== "audio") return;
    if (a.paused) return;
    const dur = a.duration, t = a.currentTime || 0;
    const finite = Number.isFinite(dur) && dur > 0;
    if (a.ended || (finite && (dur - t) <= 0.4)) advanceToNextOnce();
  }, 1000);
}
function stopBgAdvanceGuard(){ if (bgAdvanceGuard.timer){ clearInterval(bgAdvanceGuard.timer); bgAdvanceGuard.timer=null; } }

/* —— Media Session 进度同步（归一化） —— */
let posTicker = null;
function getActiveEl(){ return (playbackMode==="video" ? (media.v||$("fsVideo")) : (media.a||$("bgAudio"))); }
function updatePositionState(){
  if (!("mediaSession" in navigator)) return;
  const el = getActiveEl(); if (!el) return;

  let dur = Number.isFinite(el.duration) && el.duration>0 ? el.duration : undefined;
  let pos = Number.isFinite(el.currentTime) && el.currentTime>=0 ? el.currentTime : undefined;

  if (playbackMode === "audio"){
    if (pos !== undefined) pos = Math.max(0, pos - (audioBias||0));
    if (dur !== undefined) dur = Math.max(0, dur - (audioBias||0));
  }

  const rate = (!el.paused && Number.isFinite(el.playbackRate)) ? el.playbackRate : 0;
  try{
    if (dur !== undefined && pos !== undefined)
      navigator.mediaSession.setPositionState({ duration: dur, position: pos, playbackRate: rate });
  }catch(_){}
}
function startPosTicker(){ if (posTicker) return; updatePositionState(); posTicker = setInterval(updatePositionState, 1000); }
function stopPosTicker(){ if (posTicker){ clearInterval(posTicker); posTicker=null; } }

/* =================== 前后台切换 & 前台晋升 =================== */

let switchLock = false;
function withSwitchLock(fn){ return async (...args)=>{ if (switchLock) return; switchLock = true; try{ await fn(...args); } finally { setTimeout(()=>{ switchLock=false; }, 200); } }; }

/* 统一的前台晋升：以音频“当前集 + 进度”为准同步视频并秒开，避免双声 */
async function promoteToVideoNow(reason="unknown"){
  if (!isPlayerActive()) return;
  if (scrubGuard.active) return;
  const v = media.v || $("fsVideo");
  const a = media.a || $("bgAudio");
  const id = player.ids[player.index];
  if (!v || !a || !id) return;

  const vSrc = mediaVideoSrcOf(id);
  const resumeAt = Number.isFinite(a.currentTime) ? Math.max(0, a.currentTime - (audioBias||0)) : 0;

  await attachVideoSrc(vSrc, resumeAt);

  try{ a.pause(); a.muted = true; }catch(_){}

  playbackMode = "video";
  stopBgKeepAlive();              // ← 前台视频时停止保活
  updateMediaSessionPlaybackState(); updatePositionState(); startPosTicker();
  stopBgAdvanceGuard();

  const ok = await safePlay(v);
  if (!ok){ showNotice("前台播放被阻止，点一下屏幕继续"); installUserGestureUnlock(); }
}

/* 后台：根据用户是否暂停决定是否自动播放音频 */
const switchToAudio = withSwitchLock(async function(){
  if (!isPlayerActive() || playbackMode==="audio") return;
  if (scrubGuard.active) return;

  const v = media.v || $("fsVideo");
  const id = player.ids[player.index];
  const aSrc = audioSrcOf(id);
  const vSrc = mediaVideoSrcOf(id);

  const wasVideoPaused = !!(v && v.paused);
  const autoPlay = !(wasVideoPaused || _userPaused); // 用户在前台暂停→后台不自动播

  const resumeAt = Number.isFinite(v?.currentTime) ? v.currentTime : 0;

  // 附加音频（autoPlay 决定是否播放；首次对齐强制 seek）
  try{
    await attachAudioSrc(aSrc, resumeAt, {
      muted: !autoPlay ? true : false,
      ensurePlay: !!autoPlay,
      seek: 'force'
    });
  }catch(_){}

  // 视频保持 attach + 定位，但暂停（仅加载）
  try{
    await attachVideoSrc(vSrc, resumeAt);
    try{ v.pause(); }catch(_){}
  }catch(_){}

  clearUserPaused();
  playbackMode = "audio";
  updateMediaSessionPlaybackState(); updatePositionState(); startPosTicker();
  if (autoPlay){ startBgAdvanceGuard(); startBgKeepAlive(); } else { stopBgAdvanceGuard(); stopBgKeepAlive(); }
});

/* 显式切回前台 → 统一用 promoteToVideoNow */
const switchToVideo = withSwitchLock(async function(){
  if (!isPlayerActive() || playbackMode==="video") return;
  if (scrubGuard.active) return;
  await promoteToVideoNow("visibility");
});

/* —— 切换触发 —— */
document.addEventListener("visibilitychange", async ()=>{
  if (!isPlayerActive()) return;
  if (scrubGuard.active) return;
  if (document.visibilityState === "hidden") await switchToAudio();
  else await switchToVideo();
});
window.addEventListener("focus", async ()=>{
  if (!isPlayerActive()) return;
  if (document.visibilityState !== "visible") return;
  await switchToVideo();
});
window.addEventListener("pageshow", async ()=>{
  if (!isPlayerActive()) return;
  if (document.visibilityState !== "visible") return;
  await switchToVideo();
});

window.addEventListener("pagehide", ()=> { if (isPlayerActive() && !scrubGuard.active) switchToAudio(); });
document.addEventListener("freeze",   ()=> { if (isPlayerActive() && !scrubGuard.active) switchToAudio(); });

/* —— 结束→下一集 —— */
let lastAdvanceId = null;
function advanceToNextOnce(){
  const curId = player.ids[player.index];
  if (lastAdvanceId === curId) return;
  lastAdvanceId = curId;
  markWatched(curId);
  nextInPlaylist();
}
function handleEndedFromAny(){ advanceToNextOnce(); }
function installAudioNearEndDetector(a){
  if (a._nearEndBound) return; a._nearEndBound = true;
  const check = ()=>{
    if (!isPlayerActive()) return;
    if (playbackMode !== "audio") return;
    if (!isFinite(a.duration) || a.seeking || a.paused) return;
    const remain = a.duration - a.currentTime;
    if (a.ended || remain <= 0.4) advanceToNextOnce();
  };
  a.addEventListener("timeupdate", check);
  a.addEventListener("progress",   check);
}

/* —— Media Session 元数据/动作（seek 归一化） —— */
function setMediaSessionMeta(id){
  if (!("mediaSession" in navigator)) return;
  const title = player.titles[id] || `视频 ${id}`;
  const origin = location.origin;
  const artwork = [
    { src: `${origin}/media/preview/${id}?s=512`, sizes:"512x512", type:"image/png" },
    { src: `${origin}/media/preview/${id}?s=128`, sizes:"128x128", type:"image/png" },
  ];
  try { navigator.mediaSession.metadata = new MediaMetadata({ title, artist:"Wallpaper Engine", album: state.path, artwork }); } catch(_){}
  if (!setMediaSessionMeta._installed){
    const both = ()=>({ v: (media.v||$("fsVideo")), a: (media.a||$("bgAudio")) });

    navigator.mediaSession.setActionHandler("play", async ()=>{
      clearUserPaused();
      const {v,a} = both();
      if (document.visibilityState==="hidden"){
        // 后台优先用音频的当前时间，避免回跳
        const id = player.ids[player.index];
        const aSrc = audioSrcOf(id);
        const resumeAt =
          Number.isFinite(a?.currentTime) ? Math.max(0, a.currentTime - (audioBias||0))
          : Number.isFinite(v?.currentTime) ? v.currentTime
          : 0;
        await attachAudioSrc(aSrc, resumeAt, { muted:false, ensurePlay:true, seek:'smart' });
        playbackMode = "audio";
        startBgAdvanceGuard();
        startBgKeepAlive();     // ← Media Session 后台播放时开启保活
      } else {
        await promoteToVideoNow("media-session-play");
      }
      updateMediaSessionPlaybackState(); startPosTicker(); updatePositionState();
    });

    navigator.mediaSession.setActionHandler("pause", async ()=>{
      markUserPaused();
      const {v,a} = both();
      try{ v.pause(); }catch(_){}
      try{ a.pause(); }catch(_){}
      stopBgKeepAlive();        // ← 暂停时停止保活
      updateMediaSessionPlaybackState(); updatePositionState(); stopPosTicker();
    });

    navigator.mediaSession.setActionHandler("previoustrack", async ()=>{ if (player.index>0) await playIndex(player.index-1, {resumeAt:0}); });
    navigator.mediaSession.setActionHandler("nexttrack", async ()=>{ await nextInPlaylist(); });
    navigator.mediaSession.setActionHandler("seekbackward", (d)=>{ const el=getActiveEl(); el.currentTime=Math.max(0, el.currentTime-(d?.seekOffset||10)); if (playbackMode==="audio") updatePositionState(); });
    navigator.mediaSession.setActionHandler("seekforward", (d)=>{ const el=getActiveEl(); el.currentTime=Math.min((el.duration||1e9), el.currentTime+(d?.seekOffset||10)); if (playbackMode==="audio") updatePositionState(); });
    navigator.mediaSession.setActionHandler("seekto", async (d)=>{
      const el=getActiveEl();
      const t = d.seekTime||0;
      beginScrubGuard();
      if (playbackMode==="audio"){ try{ el.currentTime = Math.max(0, t + (audioBias||0)); }catch(_){}
      }else{ try{ el.currentTime = t; }catch(_){} }
      endScrubGuardSoon();
      updatePositionState();
    });
    setMediaSessionMeta._installed = true;
  }
  updateMediaSessionPlaybackState(); updatePositionState();
}
function updateMediaSessionPlaybackState(){
  if (!("mediaSession" in navigator)) return;
  const el = getActiveEl(); if (!el) return;
  try { navigator.mediaSession.playbackState = el.paused ? "paused" : "playing"; } catch(_){}
}

/* —— stalled/首帧修复 —— */
const stallRepair = { inFlight:false, tried:new Set(), timer:null, detach:null, startedAt:0 };
function installStallListeners(v, a){
  if (!v._stallBound){
    const vh = async ()=> await maybeRepairFromEl('video', v);
    v.addEventListener('stalled', vh); v.addEventListener('waiting', vh); v.addEventListener('error',   vh);
    v.addEventListener('seeking', ()=>{ beginScrubGuard(); stallRepair.startedAt = Date.now(); updatePositionState(); });
    v.addEventListener('seeked',  ()=>{ endScrubGuardSoon(); updatePositionState(); });
    v.addEventListener('playing', ()=> clearUserPaused());
    v.addEventListener('pause',   ()=>{ if (document.visibilityState==='visible') markUserPaused(); updatePositionState(); });
    v._stallBound = true;
  }
  if (!a._stallBound){
    const ah = async ()=> await maybeRepairFromEl('audio', a);
    a.addEventListener('stalled', ah); a.addEventListener('waiting', ah); a.addEventListener('error',   ah);
    a.addEventListener('playing', ()=> clearUserPaused());
    a._stallBound = true;
  }
}
async function maybeRepairFromEl(which, el){
  if (!isPlayerActive()) return;
  if (scrubGuard.active) return;
  if (playbackMode === "audio" && which === "video") return;

  const id = player.ids[player.index];
  if (!id || stallRepair.inFlight || stallRepair.tried.has(String(id))) return;
  const early = (el.currentTime || 0) < 1.0;
  const starving = (el.readyState || 0) < 3;
  if (!(early || starving)) return;

  if (!stallRepair.startedAt) stallRepair.startedAt = Date.now();
  if (Date.now() - stallRepair.startedAt < STALL_REPAIR_GRACE_MS) return;

  await triggerRepair(id, el.currentTime || 0);
}
function armFirstPlayWatch(id, el){
  disarmFirstPlayWatch();
  let started = false;
  stallRepair.startedAt = Date.now();
  const onPlaying = ()=>{ started = true; disarmFirstPlayWatch(); };
  const onProgress = ()=>{ if ((el.currentTime||0) >= 0.25){ started = true; disarmFirstPlayWatch(); } };
  el.addEventListener('playing', onPlaying, {once:true});
  el.addEventListener('timeupdate', onProgress);
  stallRepair.detach = ()=>{ try{ el.removeEventListener('timeupdate', onProgress); }catch(_){ } };
  stallRepair.timer = setTimeout(()=>{ if (!started && !stallRepair.tried.has(String(id)) && !scrubGuard.active) triggerRepair(id, el.currentTime||0); }, STALL_REPAIR_GRACE_MS);
}
function disarmFirstPlayWatch(){ if (stallRepair.timer){ clearTimeout(stallRepair.timer); stallRepair.timer=null; } if (stallRepair.detach){ try{ stallRepair.detach(); }catch(_){ } } stallRepair.detach=null; }
async function triggerRepair(id, resumeAt){
  stallRepair.inFlight = true; stallRepair.tried.add(String(id));
  showNotice("正在修复该视频（无损重封装）…");
  try{
    const r = await fetch(`/api/faststart/${id}`, { method:"POST" });
    let j=null; try{ j = await r.json(); }catch(_){}
    if (r && r.ok && (!j || j.ok !== false)){
      const wasSkipped = !!(j && (j.skipped === true || j.reason === "already-done"));
      await playIndex(player.index, { cacheBust:true, resumeAt: resumeAt||0 });
      showNotice(wasSkipped ? "该视频已做过 faststart，已尝试重载播放…" : "已修复，正在重新播放…");
      setTimeout(clearNotice, 1200);
    } else {
      showNotice("修复失败：无法完成 faststart");
      setTimeout(clearNotice, 2000);
    }
  }catch(_){
    showNotice("修复失败：网络或权限问题");
    setTimeout(clearNotice, 2000);
  }
  finally{ stallRepair.inFlight = false; }
}

/* —— 元数据就绪再设 currentTime —— */
function setCurrentTimeWhenReady(el, t){
  try{
    if (isFinite(el.duration) && el.readyState >= 1) { el.currentTime = Math.max(0, t||0); updatePositionState(); return; }
  }catch(_){}
  const set = ()=>{ try{ el.currentTime = Math.max(0, t||0); }catch(_){ } updatePositionState(); cleanup(); };
  const cleanup = ()=>{
    try{ el.removeEventListener("loadedmetadata", set); }catch(_){}
    try{ el.removeEventListener("durationchange", set); }catch(_){}
    try{ el.removeEventListener("canplay", set); }catch(_){}
  };
  el.addEventListener("loadedmetadata", set, {once:true});
  el.addEventListener("durationchange", set, {once:true});
  el.addEventListener("canplay", set, {once:true});
}

/* —— 预加载提升 —— */
function injectVideoPreload(src){
  try{
    const l = document.createElement("link");
    l.rel = "preload"; l.as = "video"; l.href = src; l.fetchPriority = "high";
    document.head.appendChild(l);
    setTimeout(()=>{ try{ l.remove(); }catch(_){ } }, 8000);
  }catch(_){}
}

/* ===== 播放入口 ===== */
async function startPlaylist(items, startIndex=0, returnPath=null){
  cancelProgressive();

  // Busy 此时应已被 primeBusy() 提前显示；这里仍兜底显示一次
  showBusy("正在准备播放器…");

  player.ids = items.map(x=>x.id);
  player.titles = {}; items.forEach(x=> player.titles[x.id] = x.title || `视频 ${x.id}`);
  player.index = Math.max(0, Math.min(startIndex, player.ids.length-1));
  player.returnPath = returnPath || state.path;

  const wrap = $("playerFS");
  const v = $("fsVideo");
  const a = $("bgAudio");
  media.v = v; media.a = a;
  playbackMode = "video";

  wrap.style.display = "flex";
  enforceNoPIP(v);

  if (!v._bound) {
    v.addEventListener("ended", ()=> handleEndedFromAny(v));
    a.addEventListener("ended", ()=> handleEndedFromAny(a));
    installAudioNearEndDetector(a);
    installStallListeners(v, a);

    try{
      v.preload = "auto";
      v.playsInline = true; v.setAttribute("playsinline",""); v.setAttribute("webkit-playsinline","");
      v.disableRemotePlayback = true;
    }catch(_){}

    const bindPos = (el, isVideo)=>{
      el.addEventListener("timeupdate", updatePositionState);
      el.addEventListener("loadedmetadata", updatePositionState);
      el.addEventListener("durationchange", updatePositionState);
      el.addEventListener("playing", ()=>{
        clearUserPaused(); updatePositionState(); startPosTicker();
        if (!isVideo && playbackMode==="audio") startBgKeepAlive();  // ← 音频真正播放时开启保活
      });
      el.addEventListener("pause",   ()=>{
        if (document.visibilityState==='visible') markUserPaused();
        updatePositionState();
        if (!isVideo) stopBgKeepAlive();                             // ← 音频暂停时停止保活
      });
      if (isVideo){
        el.addEventListener("seeking", ()=>{ beginScrubGuard(); stallRepair.startedAt = Date.now(); updatePositionState(); });
        el.addEventListener("seeked",  ()=>{ endScrubGuardSoon(); updatePositionState(); });
      }
    };
    bindPos(v, true); bindPos(a, false);

    v._bound = a._bound = true;
  }

  try{
    a.autoplay = false; a.preload = "auto";
    a.playsInline = true; a.setAttribute("playsinline",""); a.setAttribute("webkit-playsinline","");
    a.disableRemotePlayback = true;
    a.muted = true; a.volume = 0;
  }catch(_){}

  try{
    if (wrap.requestFullscreen) await wrap.requestFullscreen({ navigationUI: "hide" });
    else if (wrap.webkitRequestFullscreen) await wrap.webkitRequestFullscreen();
  }catch(_){}
  try { history.pushState({ fsOverlay:true }, ""); fsOverlayInHistory = true; } catch(_) {}

  $("btnBack").onclick = async ()=>{
    if (uiLock.byPlaylist) return;
    await exitPlayer();
    if (fsOverlayInHistory){ fsOverlayInHistory = false; try{ history.back(); }catch(_){ } }
    if (state.path !== player.returnPath) navigateToPath(player.returnPath);
  };
  $("btnMenu").onclick = ()=>{ if ($("playlistPanel").classList.contains("hidden")) showPlaylistPanel(); else hidePlaylistPanel(); };

  const waitReady = new Promise(res=>{
    let done=false;
    const finish=()=>{ if(done) return; done=true; res(); };
    const vPlaying = ()=> finish();
    const aPlaying = ()=> finish();
    const killTimer = setTimeout(finish, 2000);
    const cleanup = ()=>{
      clearTimeout(killTimer);
      try{ v.removeEventListener("playing", vPlaying); }catch(_){}
      try{ a.removeEventListener("playing", aPlaying); }catch(_){}
    };
    v.addEventListener("playing", ()=>{ cleanup(); finish(); }, {once:true});
    a.addEventListener("playing", ()=>{ cleanup(); finish(); }, {once:true});
  });

  wrap.addEventListener("mousemove", wakeOverlay);
  wrap.addEventListener("touchstart", wakeOverlay);
  wakeOverlay();

  suspendGridImageLoads();
  unlockPlaybackOnUserGesture();
  await playIndex(player.index);

  await waitReady;
  hideBusy();
}

/* ★ 切集 / 首次播放 */
async function playIndex(i, {cacheBust=false, resumeAt=0} = {}){
  player.index = i;
  lastAdvanceId = null;
  disarmFirstPlayWatch();
  stallRepair.startedAt = Date.now();

  const a0 = media.a || $("bgAudio");
  if (a0){ try{ a0.muted = true; a0.volume = 0; }catch(_){ } }

  const id = player.ids[i];
  const v = media.v || $("fsVideo");
  const a = media.a || $("bgAudio");
  const vSrc = mediaVideoSrcOf(id, cacheBust);
  const aSrc = audioSrcOf(id, cacheBust);
  injectVideoPreload(vSrc);

  setMediaSessionMeta(id);
  updatePositionState(); startPosTicker();

  if (document.visibilityState === "hidden") {
    // 后台启动或后台切集：attach 音频 + 预热视频（不播放），首次对齐强制 seek
    audioBias = 0;
    try{ await attachAudioSrc(aSrc, resumeAt||0, { muted:false, ensurePlay:true, seek:'force' }); }catch(_){}
    try{
      await attachVideoSrc(vSrc, resumeAt||0);
      try{ v.pause(); }catch(_){}
    }catch(_){}
    playbackMode = "audio";
    startBgAdvanceGuard();
    startBgKeepAlive();   // ← 后台开始播放时启动保活
    armFirstPlayWatch(id, a);
  } else {
    // 前台启动：视频播放 + 预热音频
    await attachVideoSrc(vSrc, resumeAt||0);
    const ok = await safePlay(v);
    if (!ok){ showNotice("播放被阻止：请点击屏幕以继续播放。"); installUserGestureUnlock(); }
    prewarmAudio(aSrc, resumeAt||0);
    stopBgAdvanceGuard();
    stopBgKeepAlive();
    armFirstPlayWatch(id, v);
    playbackMode = "video";
  }
  startFgSync();
  renderPlaylistPanel();
}

function wakeOverlay(){
  const wrap = $("playerFS");
  wrap.classList.remove("idle");
  if (player.idleTimer) clearTimeout(player.idleTimer);
  player.idleTimer = setTimeout(()=> wrap.classList.add("idle"), 1500);
}

function renderPlaylistPanel(){
  const ul = $("plist"); ul.innerHTML = "";
  player.ids.forEach((id, i)=>{
    const li = document.createElement("li");
    li.className = (i===player.index) ? "active" : "";
    li.innerHTML = `<span class="dot"></span><span>${player.titles[id] || ("视频 "+id)}</span>`;
    li.onclick = ()=> { primeBusy(); playIndex(i); };
    ul.appendChild(li);
  });
}
async function nextInPlaylist(){ if (player.index < player.ids.length - 1) await playIndex(player.index + 1, { resumeAt: 0 }); }

async function exitPlayer(){
  cancelProgressive();
  hidePlaylistPanel();
  disarmFirstPlayWatch();
  try { if (document.fullscreenElement) await document.exitFullscreen(); } catch(_){}
  const wrap = $("playerFS"); const v = $("fsVideo"); const a = $("bgAudio");
  try { v.pause(); } catch(_){}
  try { a.pause(); } catch(_){}
  try { v.removeAttribute("src"); v.load(); } catch(_){}
  try { a.removeAttribute("src"); a.load(); } catch(_){}
  wrap.style.display = "none";
  $("playlistPanel").classList.add("hidden");
  stopBgAdvanceGuard(); stopPosTicker(); stopFgSync(); stopBgKeepAlive();
  resumeGridImageLoads();
}

function isPlayerActive(){ return $("playerFS").style.display !== "none"; }

/* ============== 渐进选择/批量播放 ============== */

function cancelProgressive(){ progressive.cancel=true; progressive.running=false; progressive.key=""; progressive.seen.clear(); }
function appendToPlaylist(items){
  let added=0;
  for (const it of items){
    if (!progressive.seen.has(it.id)){
      progressive.seen.add(it.id);
      player.ids.push(it.id);
      player.titles[it.id] = it.title || `视频 ${it.id}`;
      added++;
    }
  }
  if (added>0) renderPlaylistPanel();
}
async function progressiveAppendFrom(producer, label="后台加载"){
  progressive.running = true; progressive.cancel = false; const myKey = progressive.key = makeQueryKey(); let total = 0;
  try{
    for await (const batch of producer()){
      if (progressive.cancel || progressive.key!==myKey) break;
      if (batch && batch.length){
        appendToPlaylist(batch);
        total += batch.length;
        setInfStatus(`${label}：+${batch.length}（累计 ${total}）`);
        await sleep(0);
      }
    }
    if (!progressive.cancel) setInfStatus(`${label}：已加载全部`);
  }catch(e){ if (!progressive.cancel) setInfStatus(`${label}：加载失败`); console.error(e); }
  finally{ progressive.running = false; }
}
async function handlePlayUnwatched(){
  primeBusy("正在启动播放器…");
  cancelProgressive();
  const current = getCurrentlyLoadedVideoItems();
  await syncWatched(current.map(x=>x.id));
  const initial = current.filter(x => !isWatched(x.id)).slice(0, 30);
  if (initial.length){ await startPlaylist(initial, 0, state.path); progressive.seen = new Set(player.ids); }
  const exclude = new Set(initial.map(i=>String(i.id)));
  const all = await getFolderItems(state.path);
  await syncWatched(all.map(x=>x.id));
  const pending = all.filter(x => !isWatched(x.id) && !exclude.has(String(x.id)));
  if (!initial.length && !pending.length){ hideBusy(); setInfStatus("当前路径下没有未完成的视频"); return; }
  const BATCH = 200;
  if (!initial.length){
    const first = pending.slice(0, 30);
    await startPlaylist(first, 0, state.path);
    progressive.seen = new Set(player.ids);
    const rest = pending.slice(first.length);
    const producer = async function* (){ for (const part of chunk(rest, BATCH)) yield part; };
    progressiveAppendFrom(producer, "未完成后台加载");
  } else {
    const producer = async function* (){ for (const part of chunk(pending, BATCH)) yield part; };
    progressiveAppendFrom(producer, "未完成后台加载");
  }
}
async function handlePlayFromHereProgressive(vid, title){
  primeBusy("正在启动播放器…");
  cancelProgressive();
  const initial = [{ id: String(vid), title: title || `视频 ${vid}` }];
  await startPlaylist(initial, 0, state.path);
  progressive.seen = new Set(player.ids);
  const all = await getFolderItems(state.path);
  await syncWatched(all.map(x=>x.id));
  const idx = all.findIndex(x => String(x.id) === String(vid));
  const tail = (idx>=0) ? all.slice(idx+1) : all;
  const pending = tail.filter(x => !isWatched(x.id));
  const BATCH = 200;
  const producer = async function* (){ for (const part of chunk(pending, BATCH)) yield part; };
  progressiveAppendFrom(producer, "从该处后台加载");
}
async function progressivePlayFolder(path){
  primeBusy("正在启动播放器…");
  cancelProgressive();
  setInfStatus("准备读取文件夹…");
  const all = await getFolderItems(path);
  await syncWatched(all.map(x=>x.id));
  if (!all.length){ hideBusy(); alert("该文件夹没有可播放视频"); return; }
  const initial = all.filter(x=>!isWatched(x.id)).slice(0, Math.min(30, all.length));
  if (!initial.length){ hideBusy(); alert("该文件夹没有未完成的视频"); return; }
  await startPlaylist(initial, 0, path);
  progressive.seen = new Set(player.ids);
  const rest = all.filter(x => !isWatched(x.id) && !progressive.seen.has(x.id));
  const BATCH = 200;
  const producer = async function* (){ for (const part of chunk(rest, BATCH)) yield part; };
  progressiveAppendFrom(producer, "文件夹后台加载");
}
async function progressivePlaySelection(){
  primeBusy("正在启动播放器…");
  cancelProgressive();
  const selVideos = [...state.selV].map(String), selFolders = [...state.selF];
  let initial = selVideos.map(id => ({ id, title: (state.tiles.find(t=>String(t.vid)===id)?.title) || `视频 ${id}` }));
  await syncWatched(initial.map(x=>x.id));
  if (!initial.length && selFolders.length){
    const firstFolderItems = await getFolderItems(selFolders[0]);
    await syncWatched(firstFolderItems.map(x=>x.id));
    if (!firstFolderItems.length){ hideBusy(); alert("所选文件夹没有可播放视频"); return; }
    initial = firstFolderItems.filter(x=>!isWatched(x.id)).slice(0, Math.min(30, firstFolderItems.length));
  }
  if (!initial.length){ hideBusy(); alert("所选没有未完成的视频"); return; }
  await startPlaylist(initial, 0, state.path);
  progressive.seen = new Set(player.ids);
  const BATCH = 200;
  const producer = async function* (){
    const extraVideos = selVideos
      .map(id => ({ id, title: (state.tiles.find(t=>String(t.vid)===id)?.title) || `视频 ${id}` }))
      .filter(x => !isWatched(x.id) && !progressive.seen.has(x.id));
    if (extraVideos.length) yield extraVideos;
    for (let i=0;i<selFolders.length;i++){
      const items = await getFolderItems(selFolders[i]);
      await syncWatched(items.map(x=>x.id));
      const pending = items.filter(x => !isWatched(x.id) && !progressive.seen.has(x.id));
      for (const part of chunk(pending, BATCH)) yield part;
    }
  };
  progressiveAppendFrom(producer, "批量后台加载");
}
async function getFolderItems(path){
  const params = new URLSearchParams({ path, sort_idx: state.sort_idx, mature_only: state.mature_only, with_meta: "1" });
  const r = await fetch(`/api/folder_videos?${params.toString()}`);
  const j = await r.json();
  return (j.items || []).map(it => ({id: String(it.id), title: it.title || `视频 ${it.id}`}));
}
function getCurrentlyLoadedVideoItems(){
  const out = []; for (const t of state.tiles){ if (t.type === "video") out.push({ id:String(t.vid), title:t.title || `视频 ${t.vid}` }); }
  return out;
}

/* ============== 事件委托 & 菜单 ============== */

function getTile(target){ const el = target.closest(".tile"); if(!el) return null; const idx = parseInt(el.dataset.idx,10); return state.tiles[idx] || null; }

function bindDelegatedEvents(){
  const el = grid(); if (el._allBound) return; el._allBound = true;

  el.addEventListener("click", async (ev)=>{
    const wbtn = ev.target.closest(".watched-btn");
    if (wbtn){
      ev.preventDefault(); ev.stopPropagation();
      const t = getTile(wbtn); if (!t || t.type!=="video") return;
      const id = String(t.vid);
      const next = !isWatched(id);
      paintWatchedButton(wbtn, next);
      await setWatchedOptimistic(id, next);
      return;
    }

    const menuBtn = ev.target.closest(".tile-menu");
    if (menuBtn) {
      const t = getTile(menuBtn); if (!t) return;
      clearSel(); setSel(t, true); state.lastIdx = t.idx;
      const b = menuBtn.getBoundingClientRect();
      openContextMenu(b.left + b.width/2, b.top + b.height);
      ev.stopPropagation(); return;
    }

    const t = getTile(ev.target); if (!t) return;
    if (ev.ctrlKey) { setSel(t, !isSel(t)); state.lastIdx=t.idx; ev.preventDefault(); return; }
    if (ev.shiftKey) {
      const start = state.lastIdx==null ? t.idx : state.lastIdx;
      const [a,b] = [start, t.idx].sort((x,y)=>x-y);
      if (!ev.ctrlKey) clearSel(); for (let i=a;i<=b;i++) setSel(state.tiles[i], true);
      ev.preventDefault(); return;
    }
    t.el.classList.add("pulse"); setTimeout(()=> t.el.classList.remove("pulse"), 200);
    clearSel(); setSel(t,true); state.lastIdx=t.idx;
    if (t.type === "folder") navigateToPath(t.path);
    else { primeBusy("正在启动播放器…"); await startPlaylist([{id:t.vid, title:t.title}], 0, state.path); }
  });

  try { el.oncontextmenu = null; } catch(_) {}
  if (IS_MOBILE_UA) {
    el.addEventListener("contextmenu", e => e.preventDefault(), { capture:true, passive:false });
    return;
  }
  const openFrom = (ev)=>{
    const t = getTile(ev.target); if (!t) return false;
    ev.preventDefault();
    if (!isSel(t)) { clearSel(); setSel(t,true); state.lastIdx=t.idx; }
    openContextMenu(ev.clientX, ev.clientY);
    return true;
  };
  el.addEventListener("contextmenu", (ev)=>{ openFrom(ev); }, { capture:true });
  el.addEventListener("mouseup", (ev)=>{ if (ev.button===2) openFrom(ev); });
  el.addEventListener("pointerup", (ev)=>{ if (ev.button===2) openFrom(ev); });
}

async function deleteByIds(ids){ await fetch("/api/delete", { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({ids}) }); }
function openContextMenu(x,y){
  const menu = $("ctxmenu"); menu.innerHTML=""; menu.style.display="block";
  const selCount = state.selV.size + state.selF.size;
  const onlyOne = selCount === 1;
  const oneVideo = onlyOne && state.selV.size === 1;
  const oneFolder = onlyOne && state.selF.size === 1;
  function add(text, fn){ const d=document.createElement("div"); d.className="item"; d.textContent=text; d.onclick=()=>{ hideMenu(); fn(); }; menu.appendChild(d); }
  function sep(){ const s=document.createElement("div"); s.className="sep"; menu.appendChild(s); }
  if (oneVideo) {
    const vid = [...state.selV][0];
    const title = (state.tiles.find(t=>t.vid===vid)?.title) || `视频 ${vid}`;
    add("播放此视频（全屏）", ()=> { primeBusy("正在启动播放器…"); startPlaylist([{id:vid, title}], 0, state.path); });
    add("从该处开始播放（忽略已完成）", async ()=>{ await handlePlayFromHereProgressive(vid, title); });
    add("打开创意工坊链接", ()=> window.open(`/go/workshop/${vid}`, "_blank"));
    sep();
    add("删除（不可恢复）", async ()=>{
      if (!confirm("确定要永久删除该条目吗？此操作不可恢复。")) return;
      await deleteByIds([vid]); clearSel(); changeContext({});
    });
  } else if (oneFolder) {
    const path = [...state.selF][0];
    add("打开此文件夹", ()=> navigateToPath(path));
    add("播放此文件夹（全屏顺序播放）", async ()=>{ await progressivePlayFolder(path); });
  } else {
    add("批量播放（全屏顺序播放）", async ()=>{ await progressivePlaySelection(); });
    sep();
    add("删除所选（不可恢复）", async ()=>{
      const items = await expandSelectionToItems();
      if (!items.length) return alert("所选没有可删除的视频");
      if (!confirm(`确认永久删除 ${items.length} 项？此操作不可恢复。`)) return;
      await deleteByIds(items.map(x=>x.id)); clearSel(); changeContext({});
    });
  }
  const vw=window.innerWidth,vh=window.innerHeight;
  menu.style.left = Math.min(x, vw-220)+"px"; menu.style.top = Math.min(y, vh-240)+"px";
  setTimeout(()=> document.addEventListener("click", hideMenu, {once:true}), 0);
}
function hideMenu(){ $("ctxmenu").style.display="none"; }

/* ============== 抽屉/遮罩/框选 ============== */

function showPlaylistPanel(){
  uiLock.byPlaylist = true;
  $("playerFS").classList.add("locked");
  $("playlistPanel").classList.remove("hidden");
  const shade = $("shade");
  shade.classList.remove("hidden");

  const closeOnShade = (e)=>{ e.preventDefault(); hidePlaylistPanel(); };
  const blockScroll = (e)=>{ e.preventDefault(); };
  shade._closeOnShade = closeOnShade;
  shade._blockScroll = blockScroll;
  shade.addEventListener("click", closeOnShade);
  shade.addEventListener("wheel", blockScroll, { passive:false });
  shade.addEventListener("touchmove", blockScroll, { passive:false });

  const allowInPanel = (el)=> !!(el && (el.closest("#playlistPanel") || el.closest("#btnMenu")));
  const allowShadeClick = (type, el)=> (type==="click" && el && el.id==="shade");

  const guard = (e)=>{
    const el = e.target;
    if (allowInPanel(el) || allowShadeClick(e.type, el)) return;
    if (e.type==="touchmove" || e.type==="pointermove" || e.type==="wheel") { e.preventDefault(); e.stopPropagation(); return; }
    if (e.type==="pointerdown" || e.type==="touchstart") { if (el && el.id==="shade") return; e.preventDefault(); e.stopPropagation(); return; }
    e.preventDefault(); e.stopPropagation();
  };

  addModalGuard("touchstart", guard, { capture:true, passive:false });
  addModalGuard("touchmove",  guard, { capture:true, passive:false });
  addModalGuard("pointerdown",guard, { capture:true, passive:false });
  addModalGuard("pointermove",guard, { capture:true, passive:false });
  addModalGuard("wheel",      guard, { capture:true, passive:false });

  const escToClose = (e)=>{ if (uiLock.byPlaylist && e.key==="Escape"){ e.preventDefault(); hidePlaylistPanel(); } };
  addModalGuard("keydown", escToClose, true);
}
function hidePlaylistPanel(){
  uiLock.byPlaylist = false;
  $("playlistPanel").classList.add("hidden");
  $("playerFS").classList.remove("locked");

  const shade = $("shade");
  shade.classList.add("hidden");
  if (shade._closeOnShade){ shade.removeEventListener("click", shade._closeOnShade); shade._closeOnShade=null; }
  if (shade._blockScroll){
    shade.removeEventListener("wheel", shade._blockScroll);
    shade.removeEventListener("touchmove", shade._blockScroll);
    shade._blockScroll=null;
  }
  removeModalGuards();
}

function bindRubber(){
  if (rubberBound) return; rubberBound = true;
  const rb = $("rubber");
  grid().addEventListener("mousedown", (ev)=>{
    if (ev.button !== 0) return;
    if (ev.target.closest(".tile")) return;
    state.dragging = true; state.dragStart = {x:ev.clientX, y:ev.clientY};
    state.keepSelection = ev.ctrlKey; if (!state.keepSelection) clearSel();
    rb.style.display="block"; rb.style.left=ev.clientX+"px"; rb.style.top=ev.clientY+"px"; rb.style.width="0px"; rb.style.height="0px";
    const move = (e)=>{
      if (!state.dragging) return;
      const x1 = Math.min(state.dragStart.x, e.clientX), y1 = Math.min(state.dragStart.y, e.clientY);
      const x2 = Math.max(state.dragStart.x, e.clientX), y2 = Math.max(state.dragStart.y, e.clientY);
      rb.style.left=x1+"px"; rb.style.top=y1+"px"; rb.style.width=(x2-x1)+"px"; rb.style.height=(y2-y1)+"px";
      const rect={x1,y1,x2,y2};
      state.tiles.forEach(t=>{
        const r = t.el.getBoundingClientRect();
        const hit = !(r.right<rect.x1 || r.left>rect.x2 || r.bottom<rect.y1 || r.top>rect.y2);
        setSel(t, hit || (state.keepSelection && isSel(t)));
      });
    };
    const up = ()=>{
      state.dragging=false; rb.style.display="none";
      document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up);
    };
    document.addEventListener("mousemove", move); document.addEventListener("mouseup", up);
  });
  window.addEventListener("keydown", (e)=>{
    if ((e.key==="a"||e.key==="A") && (e.ctrlKey||e.metaKey)) { e.preventDefault(); state.tiles.forEach(t=> setSel(t,true)); }
  });
}

/* ============== 顶部控件绑定 & 首次进入 ============== */

(function bootstrapAudioEarly(){
  const a = $("bgAudio");
  if (!a) return;
  try{ a.autoplay = false; a.removeAttribute && a.removeAttribute("autoplay"); }catch(_){}
  try{ a.preload = "auto"; }catch(_){}
  try{ a.playsInline = true; a.setAttribute("playsinline",""); a.setAttribute("webkit-playsinline",""); }catch(_){}
  try{ a.muted = true; a.volume = 0; }catch(_){}
  try{ a.disableRemotePlayback = true; }catch(_){}
})();

$("sort").onchange = ()=> changeContext({sort_idx: parseInt($("sort").value,10)});
$("mature").onchange = ()=> changeContext({mature_only: $("mature").checked});
$("refresh").onclick = ()=> changeContext({});
let qTimer=null;
$("q").oninput = ()=>{ clearTimeout(qTimer); qTimer=setTimeout(()=> changeContext({q:$("q").value.trim()}), 250); };
$("playUnwatched").onclick = handlePlayUnwatched;

window.addEventListener("load", ()=>{
  const initPath = pathFromHash();
  renderSkeleton(buildCrumbHtml(initPath));
  changeContext({path: initPath});
});

/* ====== 选择展开到视频（供删除批量用） ====== */
async function expandSelectionToItems(){
  const items = [];
  for (const id of state.selV) items.push({ id:String(id) });
  for (const path of state.selF){
    const arr = await getFolderItems(path);
    for (const it of arr) items.push({ id:String(it.id) });
  }
  return items;
}