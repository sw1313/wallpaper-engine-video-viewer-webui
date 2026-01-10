/* app/static/app.js (fs-42d-stall-hb-wallclock-projection+end-guard+gate-FULL+hotfix-2025-11-01b) */
console.log("app.js version fs-42d-stall-hb-wallclock-projection+end-guard+gate-FULL+hotfix-2025-11-01b");

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
  const f = installBusyGuards._f, types = installBusyGuards._types||[];
  types.forEach(t=> document.removeEventListener(t, f, {capture:true}));
  busyGuardsOn = false;
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

/* ★ 新增：依据 UA 为 <html> 切换 is-desktop（仅桌面 UA 显示返回按钮） */
try { document.documentElement.classList.toggle("is-desktop", !IS_MOBILE_UA); } catch(_){}

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
function chunk(arr, size){ const out=[]; for(let i=0;i<arr.length;i+=size) out.push(arr.slice(i, i+size)); return out; }
function showNotice(msg){ const n=$("notice"); if(!n) return; n.style.display="block"; n.innerHTML="ℹ︎ " + msg; }
function clearNotice(){ const n=$("notice"); if(!n) return; n.style.display="none"; n.textContent=""; }
function fmtSize(sz){ if (sz>=1<<30) return (sz/(1<<30)).toFixed(1)+" GB"; if (sz>=1<<20) return (sz/(1<<20)).toFixed(1)+" MB"; if (sz>=1<<10) return (sz/(1<<10)).toFixed(1)+" KB"; return sz+" B"; }
function fmtDate(ts){ return new Date(ts*1000).toLocaleString(); }
function isSel(t){ return t.type==="video" ? state.selV.has(t.vid) : state.selF.has(t.path); }
function setSel(t,on){ if(t.type==="video"){on?state.selV.add(t.vid):state.selV.delete(t.vid);} else {on?state.selF.add(t.path):state.selF.delete(t.path);} t.el.classList.toggle("selected",on); }
function clearSel(){ state.tiles.forEach(t=>t.el.classList.remove("selected")); state.selV.clear(); state.selF.clear(); }

/* ====================== （★ 新增）文件夹操作辅助 ====================== */

// ★ 新增：拉取“移动到…”用的文件夹树（含子文件夹），缓存 60s
let _foldersMenuCache = { ts:0, tree:null };
async function getFoldersMenuTree(force=false){
  const now = Date.now();
  if (!force && _foldersMenuCache.tree && (now - _foldersMenuCache.ts < 60000)) return _foldersMenuCache.tree;
  const r = await fetch("/api/folders_menu").catch(()=>null);
  const j = r && r.ok ? (await r.json().catch(()=>({tree:[]}))) : {tree:[]};
  _foldersMenuCache = { ts: now, tree: j.tree || [] };
  return _foldersMenuCache.tree;
}
// ★ 新增：扁平化树为列表
function flattenFolderTree(nodes, depth=0, out=[]){
  for (const n of (nodes||[])){
    out.push({ title: n.title || "未命名文件夹", path: n.path || "/", depth });
    if (n.children && n.children.length) flattenFolderTree(n.children, depth+1, out);
  }
  return out;
}
// ★ 新增：创建/移动 API
async function apiCreateFolder(parent, title){
  const r = await fetch("/api/folder/create", {
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body: JSON.stringify({ parent, title })
  }).catch(()=>null);
  return !!(r && r.ok);
}
async function apiMove(ids, dest_path){
  const r = await fetch("/api/move", {
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body: JSON.stringify({ ids: ids.map(String), dest_path })
  }).catch(()=>null);
  return !!(r && r.ok);
}
function sanitizeFolderTitle(name){
  let s = String(name||"").trim();
  s = s.replace(/[\\/]/g, " ").replace(/\s+/g, " ").trim();
  return s.slice(0, 128);
}

// ★ 新增：选择器样式/DOM
function ensureFolderPickerStyles(){
  if (document.getElementById("folder-picker-style")) return;
  const css = `
  #folderPicker{position:fixed;z-index:99999;display:none;min-width:260px;max-width:320px;max-height:60vh;overflow:auto;
    background:#222;color:#fff;border:1px solid #444;border-radius:10px;box-shadow:0 12px 40px rgba(0,0,0,.45)}
  #folderPicker .hdr{padding:10px 12px;font:600 14px/1.2 system-ui, -apple-system, Segoe UI, Roboto;border-bottom:1px solid #333}
  #folderPicker .itm{padding:8px 12px;cursor:pointer;white-space:nowrap}
  #folderPicker .itm:hover{background:#2f2f2f}
  #folderPicker .root{font-weight:600}
  #folderPicker .path{opacity:.9}
  #folderPicker .foot{padding:8px 12px;border-top:1px solid #333;display:flex;gap:10px}
  #folderPicker .btn{padding:6px 10px;border-radius:8px;border:1px solid #555;background:#2a2a2a;color:#eee;cursor:pointer}
  #folderPicker .btn:hover{background:#333}
  `;
  const s = document.createElement("style"); s.id="folder-picker-style"; s.textContent=css; document.head.appendChild(s);
}
function ensureFolderPicker(){
  ensureFolderPickerStyles();
  if (document.getElementById("folderPicker")) return;
  const d = document.createElement("div");
  d.id = "folderPicker";
  d.innerHTML = `<div class="hdr">移动到…</div><div class="list" id="fpList"></div>
                 <div class="foot"><button class="btn" id="fpCancel">取消</button></div>`;
  document.body.appendChild(d);
  $("fpCancel").onclick = hideFolderPicker;
}
function hideFolderPicker(){
  const fp = $("folderPicker");
  if (!fp) return;
  fp.style.display="none";
  document.removeEventListener("click", _fpClickAway, {capture:true});
}
function _fpClickAway(e){
  const fp = $("folderPicker"); if (!fp) return;
  if (!fp.contains(e.target)){ hideFolderPicker(); }
}
// ★ 新增：显示选择器
async function showFolderPicker(anchorX, anchorY, onPick){
  ensureFolderPicker();
  const fp = $("folderPicker"), list = $("fpList");
  list.innerHTML = "";
  // Root
  const root = document.createElement("div");
  root.className = "itm root";
  root.innerHTML = `<span>主页 <span class="path">(/)</span></span>`;
  root.onclick = ()=>{ hideFolderPicker(); onPick("/"); };
  list.appendChild(root);

  // Tree
  const tree = flattenFolderTree(await getFoldersMenuTree());
  tree.forEach(node=>{
    const row = document.createElement("div");
    row.className = "itm";
    row.style.paddingLeft = (12 + node.depth*16) + "px";
    row.innerHTML = `<span>${node.title} <span class="path">(${node.path})</span></span>`;
    row.onclick = ()=>{ hideFolderPicker(); onPick(node.path); };
    list.appendChild(row);
  });

  fp.style.display="block";
  const vw = window.innerWidth, vh = window.innerHeight;
  const w = Math.min(320, Math.max(260, fp.getBoundingClientRect().width||280));
  const h = Math.min(vh*0.6, fp.getBoundingClientRect().height||320);
  fp.style.left = Math.min(Math.max(8, anchorX), vw - w - 8) + "px";
  fp.style.top  = Math.min(Math.max(8, anchorY), vh - h - 8) + "px";
  setTimeout(()=> document.addEventListener("click", _fpClickAway, {capture:true}), 0);
}
// ★ 新增：根据所选收集视频 ID（可含文件夹→展开）
async function collectSelectedIds(){
  const ids = new Set();
  for (const id of state.selV) ids.add(String(id));
  if (state.selF.size){
    const arr = await expandSelectionToItems();
    for (const it of arr) ids.add(String(it.id));
  }
  return Array.from(ids);
}
// ★ 新增：移动并刷新

async function moveIdsAndRefresh(ids, destPath){
  if (!ids.length) { alert("没有可移动的条目"); return; }
  const samePath = (destPath === state.path);
  primeBusy("正在移动…");
  const ok = await apiMove(ids, destPath);
  hideBusy();
  if (!ok){ alert("移动失败，请重试"); return; }
  showNotice(`已移动到：${destPath}`);
  setTimeout(clearNotice, 1200);
  if (!samePath){
    removeTilesByVideoIds(ids);
  }
  clearSel();
}
// ★ 新增：在指定父路径下创建文件夹
async function promptCreateFolder(parentPath){
  const name = sanitizeFolderTitle(prompt(`在「${parentPath}」下新建文件夹：`, ""));
  if (!name) return;
  primeBusy("正在创建文件夹…");
  const ok = await apiCreateFolder(parentPath, name);
  hideBusy();
  if (!ok){ alert("创建失败，请重试"); return; }
  _foldersMenuCache.ts = 0; // 失效本地缓存，便于后续“移动到…”立刻看到
  changeContext({});
}

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

  // 修复：清理骨架屏占位（renderSkeleton() 插入的 .skeleton），否则会残留成“整块区域骨架/黑边”
  // 这里不能只在 page===1 时清理，因为用户滚动/重试/预取等路径可能会留下占位。
  try{
    const g = grid();
    if (g){
      g.querySelectorAll(".skeleton").forEach(el=>{ try{ el.remove(); }catch(_){ } });
    }
  }catch(_){}

  data.folders.forEach(f=>{
    const path = (state.path.endsWith("/")? state.path : state.path + "/") + f.title;
    const el = document.createElement("div");
    el.className="tile folder"; el.dataset.type="folder"; el.dataset.path=path; el.dataset.idx=idx;
    el.innerHTML = `<div class="thumb"><div class="big">📁</div></div>
                    <div class="title">${f.title}</div>
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

/* ===================== 关键：进入/切换路径 ===================== */
function changeContext({path, sort_idx, mature_only, q}={}){
  if (path!==undefined) state.path = path;
  if (sort_idx!==undefined) state.sort_idx = sort_idx;
  if (mature_only!==undefined) state.mature_only = mature_only;
  if (q!==undefined) state.q = q;
  cancelProgressive();
  clearSel(); state.page=1; state.hasMore=true; state.isLoading=false; state.queryKey=makeQueryKey();
  resetPrefetch(); renderSkeleton(buildCrumbHtml(state.path)); setInfStatus("加载中…");

  try{ window.scrollTo(0,0); }catch(_){}

  if (!io){
    const sentinel=$("sentinel");
    io = new IntersectionObserver((entries)=>entries.forEach(e=>{ if (e.isIntersecting) loadNextPage(); }), { root:null, rootMargin:"1000px 0px", threshold:0 });
    if (sentinel) io.observe(sentinel);
  }

  loadNextPage();
  setTimeout(()=>{ if (state.page===1 && !state.isLoading) loadNextPage(); }, 0);
}

/* 只返回链接 HTML，前缀“当前位置：”统一在赋值时添加 */
function buildCrumbHtml(pathStr){
  const html = ["<a class='link' href=\"#/\">/</a>"];
  const segs = pathStr.split("/").filter(Boolean);
  segs.forEach((seg,i)=>{ const p="/"+segs.slice(0,i+1).join("/"); html.push(`<a class='link' href='#${p}'>${seg}</a>`); });
  return html.join(" / ");
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

/* ========== 后台保活（增强版：多重保护机制） ========== */
const keepAlive = { 
  ctx:null, gain:null, src:null, pingTimer:null, active:false,
  wakeLock:null, wakeLockTimer:null,  // Wake Lock API
  playWatchTimer:null, lastPlayTime:0  // 播放状态监控
};
async function startBgKeepAlive(){
  if (keepAlive.active) return;
  keepAlive.active = true;
  
  // 1. AudioContext 保活（原有机制）
  try{
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC){
      if (!keepAlive.ctx) keepAlive.ctx = new AC({ latencyHint: "interactive" });
      await keepAlive.ctx.resume().catch(()=>{});
      if (!keepAlive.gain){
        keepAlive.gain = keepAlive.ctx.createGain();
        keepAlive.gain.gain.value = 1e-7;
        keepAlive.gain.connect(keepAlive.ctx.destination);
      }
      if (!keepAlive.src){
        keepAlive.src = keepAlive.ctx.createConstantSource ? keepAlive.ctx.createConstantSource() : keepAlive.ctx.createOscillator();
        if (keepAlive.src.offset) keepAlive.src.offset.value = 0.0; else keepAlive.src.frequency.value = 1;
        keepAlive.src.connect(keepAlive.gain);
        try{ keepAlive.src.start(); }catch(_){}
      }
    }
  }catch(_){}
  
  // 2. Wake Lock API（防止设备休眠）
  try{
    if ('wakeLock' in navigator){
      const requestWakeLock = async ()=>{
        try{
          if (keepAlive.wakeLock) return;
          keepAlive.wakeLock = await navigator.wakeLock.request('screen');
          keepAlive.wakeLock.addEventListener('release', ()=>{
            keepAlive.wakeLock = null;
          });
        }catch(err){
          console.warn("[KeepAlive] Wake Lock failed:", err);
          keepAlive.wakeLock = null;
        }
      };
      await requestWakeLock();
      // 定期检查并重新获取（某些浏览器会自动释放）
      if (keepAlive.wakeLockTimer) clearInterval(keepAlive.wakeLockTimer);
      keepAlive.wakeLockTimer = setInterval(async ()=>{
        if (document.visibilityState === "hidden" && isPlayerActive() && playbackMode==="audio"){
          if (!keepAlive.wakeLock || keepAlive.wakeLock.released){
            await requestWakeLock();
          }
        }
      }, 30000); // 每30秒检查一次
    }
  }catch(_){}
  
  // 3. 更频繁的服务器心跳（从45秒改为20秒）
  if (keepAlive.pingTimer) clearInterval(keepAlive.pingTimer);
  keepAlive.pingTimer = setInterval(()=>{
    if (document.visibilityState === "hidden" && isPlayerActive() && playbackMode==="audio"){
      try{
        if (navigator.sendBeacon) navigator.sendBeacon("/api/keepalive", "1");
        else fetch("/api/keepalive",{method:"POST",body:"1",keepalive:true,cache:"no-store",headers:{"Content-Type":"text/plain","Connection":"close"}}).catch(()=>{});
      }catch(_){}
    }
  }, 20000); // 20秒一次
  
  // 4. 播放状态监控（检测播放是否被系统杀死）
  if (keepAlive.playWatchTimer) clearInterval(keepAlive.playWatchTimer);
  keepAlive.playWatchTimer = setInterval(()=>{
    if (document.visibilityState !== "hidden") return;
    if (!isPlayerActive() || playbackMode !== "audio") return;
    const a = media.a || $("bgAudio");
    if (!a) return;
    
    const now = Date.now();
    const wasPlaying = !a.paused;
    const timeAdvanced = (a.currentTime || 0) > (keepAlive.lastPlayTime || 0);
    
    // 如果应该播放但时间没前进，说明被系统杀死了
    if (wasPlaying && !timeAdvanced && (now - (keepAlive.lastPlayTime || 0)) > 3000){
      console.warn("[KeepAlive] 检测到播放被系统暂停，尝试恢复...");
      try{
        a.play().catch(()=>{
          // 如果直接play失败，尝试重启
          const id = player.ids[player.index];
          if (id){
            const resumeAt = Math.max(0, (a.currentTime || 0) - (audioBias || 0));
            attachAudioSrc(audioSrcOf(id, true), resumeAt, { muted:false, ensurePlay:true, seek:'smart' }).catch(()=>{});
          }
        });
      }catch(_){}
    }
    
    if (wasPlaying && timeAdvanced){
      keepAlive.lastPlayTime = a.currentTime || 0;
    }
  }, 2000); // 每2秒检查一次
}
function stopBgKeepAlive(){
  keepAlive.active = false;
  
  if (keepAlive.pingTimer){ clearInterval(keepAlive.pingTimer); keepAlive.pingTimer = null; }
  if (keepAlive.wakeLockTimer){ clearInterval(keepAlive.wakeLockTimer); keepAlive.wakeLockTimer = null; }
  if (keepAlive.playWatchTimer){ clearInterval(keepAlive.playWatchTimer); keepAlive.playWatchTimer = null; }
  
  // 释放 Wake Lock
  try{
    if (keepAlive.wakeLock && !keepAlive.wakeLock.released){
      keepAlive.wakeLock.release();
    }
    keepAlive.wakeLock = null;
  }catch(_){}
  
  // 清理 AudioContext
  try{
    if (keepAlive.src){ try{ keepAlive.src.stop(); }catch(_){}
      try{ keepAlive.src.disconnect(); }catch(_){}
      keepAlive.src = null; }
    if (keepAlive.gain){ try{ keepAlive.gain.disconnect(); }catch(_){}
      keepAlive.gain = null; }
    if (keepAlive.ctx){ try{ keepAlive.ctx.close(); }catch(_){}
      keepAlive.ctx = null; }
  }catch(_){}
  
  keepAlive.lastPlayTime = 0;
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
  // ★ 在视频元数据加载后修复竖屏视频在全屏模式下的显示
  if (v.readyState >= 1) {
    setTimeout(fixPortraitVideoInFullscreen, 50);
  } else {
    v.addEventListener("loadedmetadata", ()=> setTimeout(fixPortraitVideoInFullscreen, 50), {once:true});
  }
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
function prewarmAudio(srcUrl, resumeAt, shouldPlay=false){
  queueMicrotask(async ()=>{
    // 预热只做 load/seek，不要触发播放；否则会在前台抢占 MediaSession/进度条为“音频样式”
    try{ await attachAudioSrc(srcUrl, resumeAt||0, { muted:true, ensurePlay:!!shouldPlay, seek:'smart' }); }catch(_){}
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
    if (!a) return;
    const dur = a.duration, t = a.currentTime || 0;
    const finite = Number.isFinite(dur) && dur > 0;
    const remain = finite ? (dur - t) : Infinity;

    if (a.ended || (finite && remain <= 0.4)) { advanceToNextOnce(); return; }
    if (finite && a.paused && remain < 5) { advanceToNextOnce(); return; }
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
    // 最小化修复：不要对 duration 做偏移，避免显示为“已播=总时长”
  }

  const rate = (!el.paused && Number.isFinite(el.playbackRate)) ? el.playbackRate : 0;
  try{
    if (dur !== undefined && pos !== undefined){
      if (pos > dur) pos = Math.max(0, dur - 0.001); // 夹紧，避免越界导致 UI 误判
      navigator.mediaSession.setPositionState({ duration: dur, position: pos, playbackRate: rate });
    }
  }catch(_){ }
}
function startPosTicker(){ if (posTicker) return; updatePositionState(); posTicker = setInterval(updatePositionState, 1000); }
function stopPosTicker(){ if (posTicker){ clearInterval(posTicker); posTicker=null; } }

/* =================== 前后台切换 & 前台晋升 =================== */

let switchLock = false;
function withSwitchLock(fn){ return async (...args)=>{ if (switchLock) return; switchLock = true; try{ await fn(...args); } finally { setTimeout(()=>{ switchLock=false; }, 200); } }; }

/* —— 前台晋升（保留上次静音引导播放以免点屏） —— */
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

  let ok = false;
  try{
    v.muted = true;
    const onPlaying = ()=>{ try{ v.muted = false; }catch(_){}
      try{ a.pause(); a.muted = true; }catch(_){}
      v.removeEventListener("playing", onPlaying);
    };
    v.addEventListener("playing", onPlaying, { once:true });
    ok = await safePlay(v);
  }catch(_){ ok = false; }

  playbackMode = "video";
  stopBgKeepAlive();
  updateMediaSessionPlaybackState(); updatePositionState(); startPosTicker();
  stopBgAdvanceGuard();

  if (!ok){
    try{ a.pause(); a.muted = true; }catch(_){}
    const ok2 = await safePlay(v);
    if (!ok2){ showNotice("前台播放被阻止，点一下屏幕继续"); installUserGestureUnlock(); }
  }
}

const switchToAudio = withSwitchLock(async function(){
  if (!isPlayerActive() || playbackMode==="audio") return;
  if (scrubGuard.active) return;

  const v = media.v || $("fsVideo");
  const id = player.ids[player.index];
  const aSrc = audioSrcOf(id);
  const vSrc = mediaVideoSrcOf(id);

  const wasVideoPaused = !!(v && v.paused);
  const autoPlay = !_userPaused; // 最小化修复：仅以用户是否主动暂停为准，避免二次切后台被误判
  const resumeAt = Number.isFinite(v?.currentTime) ? v.currentTime : 0;

  try{
    await attachAudioSrc(aSrc, resumeAt, {
      muted: true,
      ensurePlay: !!autoPlay,
      seek: 'force'
    });
  }catch(_){}
  try{
    await attachVideoSrc(vSrc, resumeAt);
    try{ v.pause(); }catch(_){}
  }catch(_){}

  try{
    const aEl = media.a || $("bgAudio");
    if (autoPlay && aEl){
      const unmute = ()=>{ try{ aEl.muted = false; aEl.volume = Math.max(0.6, aEl.volume||0.6); }catch(_){}
        aEl.removeEventListener("playing", unmute);
      };
      if (!aEl.paused && aEl.readyState >= 1) unmute();
      else aEl.addEventListener("playing", unmute);
    }
  }
  catch(_){ }

  // 二次兜底：部分 UA 在第二次切到后台时会短暂停止播放，这里延迟重试一次
  try{
    const aEl2 = media.a || $("bgAudio");
    if (autoPlay && aEl2 && aEl2.paused){
      setTimeout(()=>{ 
        if (document.visibilityState === "hidden" && isPlayerActive() && playbackMode==="audio" && aEl2.paused){ 
          aEl2.play().catch(()=>{
            // 如果直接play失败，尝试重新加载源
            const id = player.ids[player.index];
            if (id){
              const resumeAt = Math.max(0, (aEl2.currentTime || 0) - (audioBias || 0));
              attachAudioSrc(audioSrcOf(id, true), resumeAt, { muted:false, ensurePlay:true, seek:'smart' }).catch(()=>{});
            }
          }); 
        } 
      }, 250);
      // 增强：多次重试机制（250ms, 500ms, 1000ms）
      setTimeout(()=>{ 
        if (document.visibilityState === "hidden" && isPlayerActive() && playbackMode==="audio"){
          const aEl3 = media.a || $("bgAudio");
          if (aEl3 && aEl3.paused && autoPlay){ 
            aEl3.play().catch(()=>{});
          }
        } 
      }, 500);
      setTimeout(()=>{ 
        if (document.visibilityState === "hidden" && isPlayerActive() && playbackMode==="audio"){
          const aEl4 = media.a || $("bgAudio");
          if (aEl4 && aEl4.paused && autoPlay){ 
            aEl4.play().catch(()=>{});
          }
        } 
      }, 1000);
    }
  }catch(_){ }

  clearUserPaused();
  playbackMode = "audio";
  updateMediaSessionPlaybackState(); updatePositionState(); startPosTicker();
  if (autoPlay){ 
    startBgAdvanceGuard(); 
    startBgKeepAlive(); 
    // 增强：确保保活机制已启动，并记录播放时间
    const aFinal = media.a || $("bgAudio");
    if (aFinal && !aFinal.paused){
      keepAlive.lastPlayTime = aFinal.currentTime || 0;
    }
  } else { 
    stopBgAdvanceGuard(); 
    stopBgKeepAlive(); 
  }
});

const switchToVideo = withSwitchLock(async function(){
  if (!isPlayerActive() || playbackMode==="video") return;
  if (scrubGuard.active) return;
  await promoteToVideoNow("visibility");
});

/* ==== 可见性看门狗 ==== */
let visWatchTimer = null;
function kickVisWatch(reason="return"){
  if (visWatchTimer) clearInterval(visWatchTimer);
  let tries = 0;
  visWatchTimer = setInterval(async ()=>{
    tries++;
    if (!isPlayerActive()){ clearInterval(visWatchTimer); visWatchTimer=null; return; }
    if (document.visibilityState !== "visible") return;
    try{ wakeOverlay(); }catch(_){}
    const v = media.v || $("fsVideo");
    const a = media.a || $("bgAudio");
    if (!a){ clearInterval(visWatchTimer); visWatchTimer=null; return; }

    if (playbackMode === "audio" && !a.paused){
      await promoteToVideoNow("vis-watch");
      await sleep(60);
      if (playbackMode !== "video"){
        try{
          const id = player.ids[player.index];
          const resumeAt = Number.isFinite(a.currentTime) ? Math.max(0, a.currentTime - (audioBias||0)) : 0;
          await attachVideoSrc(mediaVideoSrcOf(id, true), resumeAt);
        }catch(_){}
        await promoteToVideoNow("vis-watch-bust");
        await sleep(60);
      }
    }

    if (playbackMode === "video" && v){
      const ok = await safePlay(v);
      if (!ok){
        showNotice("播放被系统暂停，点一下屏幕继续");
        installUserGestureUnlock();
      }
      clearInterval(visWatchTimer); visWatchTimer=null; return;
    }
    if (tries >= 10){ clearInterval(visWatchTimer); visWatchTimer=null; }
  }, 150);
}

document.addEventListener("visibilitychange", async ()=>{
  if (!isPlayerActive()) return;
  if (scrubGuard.active) return;
  if (document.visibilityState === "hidden"){
    await switchToAudio();
    // 增强：切到后台后立即启动保活和监控
    const a = media.a || $("bgAudio");
    if (a && !a.paused && playbackMode === "audio"){
      startBgKeepAlive();
      // 延迟检查一次，确保播放真的在继续
      setTimeout(()=>{
        if (document.visibilityState === "hidden" && isPlayerActive() && playbackMode === "audio"){
          const a2 = media.a || $("bgAudio");
          if (a2 && a2.paused){
            console.warn("[Visibility] 后台播放被暂停，尝试恢复...");
            a2.play().catch(()=>{
              const id = player.ids[player.index];
              if (id){
                const resumeAt = Math.max(0, (a2.currentTime || 0) - (audioBias || 0));
                attachAudioSrc(audioSrcOf(id, true), resumeAt, { muted:false, ensurePlay:true, seek:'smart' }).catch(()=>{});
              }
            });
          }
        }
      }, 500);
    }
  }else{
    await switchToVideo();
    setTimeout(()=> kickVisWatch("visible"), 50);
  }
});
window.addEventListener("focus", ()=>{
  if (!isPlayerActive()) return;
  if (document.visibilityState !== "visible") return;
  setTimeout(()=> kickVisWatch("focus"), 50);
});
window.addEventListener("pageshow", ()=>{
  if (!isPlayerActive()) return;
  if (document.visibilityState !== "visible") return;
  setTimeout(()=> kickVisWatch("pageshow"), 50);
});
document.addEventListener("resume", ()=> kickVisWatch("resume"));

// Page Lifecycle API 支持（更现代的页面状态管理）
if ('onpageshow' in window){
  window.addEventListener("pageshow", (e)=>{
    if (e.persisted && isPlayerActive() && playbackMode === "audio"){
      // 页面从 bfcache 恢复，检查播放状态
      const a = media.a || $("bgAudio");
      if (a && !a.paused){
        setTimeout(()=>{
          if (a.paused){
            console.warn("[PageLifecycle] 从 bfcache 恢复后播放被暂停，尝试恢复...");
            a.play().catch(()=>{});
          }
        }, 100);
      }
    }
  });
}

window.addEventListener("pagehide", (e)=> { 
  if (isPlayerActive() && !scrubGuard.active) switchToAudio();
  // 如果是进入 bfcache，保持保活机制
  if (e.persisted){
    // 不停止保活，让它在后台继续
  } else {
    stopBgKeepAlive();
  }
});
window.addEventListener("beforeunload", stopBgKeepAlive);
window.addEventListener("unload", stopBgKeepAlive);
document.addEventListener("freeze", ()=>{
  // 页面被冻结时，尝试保持播放
  if (isPlayerActive() && playbackMode === "audio"){
    const a = media.a || $("bgAudio");
    if (a && !a.paused){
      // 在冻结前确保保活机制运行
      startBgKeepAlive();
    }
  }
});
document.addEventListener("resume", ()=>{
  // 页面从冻结恢复
  if (isPlayerActive() && playbackMode === "audio"){
    const a = media.a || $("bgAudio");
    if (a && a.paused){
      console.warn("[PageLifecycle] 从冻结恢复后播放被暂停，尝试恢复...");
      a.play().catch(()=>{});
    }
  }
});

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
  const remainCheck = ()=>{
    if (!isPlayerActive()) return;
    if (playbackMode !== "audio") return;
    if (!isFinite(a.duration) || a.seeking || a.paused) return;
    const remain = a.duration - a.currentTime;
    if (a.ended || remain <= 0.4) advanceToNextOnce();
  };
  a.addEventListener("timeupdate", remainCheck);
  a.addEventListener("progress",   remainCheck);
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
        const id = player.ids[player.index];
        const aSrc = audioSrcOf(id);
        const resumeAt =
          Number.isFinite(a?.currentTime) ? Math.max(0, a.currentTime - (audioBias||0))
          : Number.isFinite(v?.currentTime) ? v.currentTime
          : 0;
        await attachAudioSrc(aSrc, resumeAt, { muted:false, ensurePlay:true, seek:'smart' });
        playbackMode = "audio";
        startBgAdvanceGuard();
        startBgKeepAlive();
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
      stopBgKeepAlive();
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
      if (playbackMode==="audio"){ try{ el.currentTime = Math.max(0, t + (audioBias||0)); }catch(_){ }
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

/* ★ 修复横向设备上竖屏视频在全屏模式下的旋转和拉伸问题 */
function fixPortraitVideoInFullscreen(){
  const v = $("fsVideo");
  if (!v) return;
  const isFullscreen = !!(document.fullscreenElement || document.webkitFullscreenElement);
  if (!isFullscreen) {
    v.classList.remove("portrait-fix");
    return;
  }
  // 检测屏幕方向（横向）
  const isLandscape = window.innerWidth > window.innerHeight;
  if (!isLandscape) {
    v.classList.remove("portrait-fix");
    return;
  }
  // 检测视频是否为竖屏
  const videoWidth = v.videoWidth || 0;
  const videoHeight = v.videoHeight || 0;
  if (videoWidth > 0 && videoHeight > 0) {
    const isPortraitVideo = videoHeight > videoWidth;
    if (isPortraitVideo) {
      v.classList.add("portrait-fix");
    } else {
      v.classList.remove("portrait-fix");
    }
  }
}

/* ★ 视口高度自适应 & 滚动拦截（进入/退出时安装/卸载） */
const SUPPORTS_DVH = (typeof CSS !== "undefined" && CSS.supports && CSS.supports("height","100dvh"));
function adjustFSViewport(){
  const wrap = $("playerFS");
  if (!wrap) return;

  if (SUPPORTS_DVH){
    wrap.style.height = "100dvh";
    const v = $("fsVideo"); const ov = $("overlay");
    if (v) v.style.height = "100dvh";
    if (ov) ov.style.height = "100dvh";
    return;
  }

  const vv = window.visualViewport;
  const h = Math.ceil((vv && vv.height) ? vv.height : window.innerHeight);
  wrap.style.height = h + "px";
  const v = $("fsVideo"); const ov = $("overlay");
  if (v) v.style.height = h + "px";
  if (ov) ov.style.height = h + "px";
}
const _fsGuards = { installed:false, wheel:null, touch:null, vv:null, resize:null, orient:null, vvResize:null, vvScroll:null };
function installFsGuards(){
  if (_fsGuards.installed) return;
  const wrap = $("playerFS");
  if (!wrap) return;
  _fsGuards.wheel = (e)=>{ e.preventDefault(); };
  _fsGuards.touch = (e)=>{ e.preventDefault(); };
  wrap.addEventListener("wheel", _fsGuards.wheel, { passive:false });
  wrap.addEventListener("touchmove", _fsGuards.touch, { passive:false });

  adjustFSViewport();
  _fsGuards.resize = ()=> { adjustFSViewport(); fixPortraitVideoInFullscreen(); };
  _fsGuards.orient = ()=> { adjustFSViewport(); fixPortraitVideoInFullscreen(); };
  window.addEventListener("resize", _fsGuards.resize);
  window.addEventListener("orientationchange", _fsGuards.orient);
  if (window.visualViewport){
    _fsGuards.vvResize = ()=> adjustFSViewport();
    _fsGuards.vvScroll = ()=> adjustFSViewport();
    window.visualViewport.addEventListener("resize", _fsGuards.vvResize);
    window.visualViewport.addEventListener("scroll", _fsGuards.vvScroll);
  }

  const fixFS = ()=> setTimeout(adjustFSViewport, 50);
  const fixPortraitOnFullscreenChange = ()=>{
    fixFS();
    setTimeout(fixPortraitVideoInFullscreen, 100);
  };
  document.addEventListener("fullscreenchange", fixPortraitOnFullscreenChange);
  document.addEventListener("webkitfullscreenchange", fixPortraitOnFullscreenChange);
  // 监听视频元数据加载，以便在视频尺寸确定后应用修复
  const v = $("fsVideo");
  if (v && !v._portraitFixBound) {
    v._portraitFixBound = true;
    v.addEventListener("loadedmetadata", fixPortraitVideoInFullscreen);
    v.addEventListener("resize", fixPortraitVideoInFullscreen);
  }

  _fsGuards.installed = true;
}
/* 正确卸载（修复顶部黑条的那版仍保留） */
function removeFsGuards(){
  if (_fsGuards.installed) return;
  const wrap = $("playerFS");
  if (wrap){
    if (_fsGuards.wheel) wrap.removeEventListener("wheel", _fsGuards.wheel, { passive:false });
    if (_fsGuards.touch) wrap.removeEventListener("touchmove", _fsGuards.touch, { passive:false });
    wrap.style.height = "";
  }
  const v = $("fsVideo"); const ov = $("overlay");
  if (v) v.style.height = "";
  if (ov) v.style.height = "";
  if (_fsGuards.resize) window.removeEventListener("resize", _fsGuards.resize);
  if (_fsGuards.orient) window.removeEventListener("orientationchange", _fsGuards.orient);
  if (window.visualViewport){
    if (_fsGuards.vvResize) window.visualViewport.removeEventListener("resize", _fsGuards.vvResize);
    if (_fsGuards.vvScroll) window.visualViewport.removeEventListener("scroll", _fsGuards.vvScroll);
  }
  document.removeEventListener("fullscreenchange", adjustFSViewport);
  document.removeEventListener("webkitfullscreenchange", adjustFSViewport);

  _fsGuards.installed = false;
}

/* 进入播放器 */
async function startPlaylist(items, startIndex=0, returnPath=null){
  cancelProgressive();

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

  /* ★ 变更：确保存在左上角返回按钮（仅桌面 UA 会显示；样式由 CSS 控制） */
  let backBtn = $("btnBack");
  if (!backBtn) {
    backBtn = document.createElement("button");
    backBtn.id = "btnBack";
    backBtn.className = "icon-btn back";
    backBtn.title = "返回";
    backBtn.setAttribute("aria-label", "返回");
    backBtn.textContent = "←";
    wrap.appendChild(backBtn);
  }
  backBtn.onclick = ()=>{
    try{
      if (fsOverlayInHistory){ history.back(); fsOverlayInHistory = false; return; }
    }catch(_){}
    exitPlayer();
    if (player.returnPath) navigateToPath(player.returnPath);
  };

  document.documentElement.classList.add("noscroll");
  document.body.classList.add("noscroll");
  installFsGuards();

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
        if (!isVideo && playbackMode==="audio") startBgKeepAlive();  
      });
      el.addEventListener("pause",   ()=>{
        if (document.visibilityState==='visible') markUserPaused();
        updatePositionState();
        if (!isVideo) stopBgKeepAlive();                             
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

  const btnMenu = $("btnMenu");
  if (btnMenu) btnMenu.onclick = ()=>{ if ($("playlistPanel").classList.contains("hidden")) showPlaylistPanel(); else hidePlaylistPanel(); };

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

  if (document.visibilityState === "hidden") {
    audioBias = 0;
    try{ await attachAudioSrc(aSrc, resumeAt||0, { muted:false, ensurePlay:true, seek:'force' }); }catch(_){}
    try{
      await attachVideoSrc(vSrc, resumeAt||0);
      try{ v.pause(); }catch(_){}
    }catch(_){}
    playbackMode = "audio";
    setMediaSessionMeta(id);
    updatePositionState(); startPosTicker();
    startBgAdvanceGuard();
    startBgKeepAlive();
    armFirstPlayWatch(id, a);
  } else {
    // 前台视频模式：先声明 playbackMode，避免 MediaSession/进度条误绑到 audio
    playbackMode = "video";
    await attachVideoSrc(vSrc, resumeAt||0);
    const ok = await safePlay(v);
    if (!ok){ showNotice("播放被阻止：请点击屏幕以继续播放。"); installUserGestureUnlock(); }
    // 确保音频不抢占前台（Chrome 可能把“在播音频”作为主媒体）
    try{ if (a){ a.pause(); a.muted = true; a.volume = 0; } }catch(_){}
    prewarmAudio(aSrc, resumeAt||0, false);
    setMediaSessionMeta(id);
    updatePositionState(); startPosTicker();
    stopBgAdvanceGuard();
    stopBgKeepAlive();
    armFirstPlayWatch(id, v);
  }
  startFgSync();
  renderPlaylistPanel();

  resetStallHeartbeat(a);
}

/* —— 叠加 UI —— */
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
    li.onclick = async ()=>{
      hidePlaylistPanel();
      await playIndex(i);
    };
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

  document.documentElement.classList.remove("noscroll");
  document.body.classList.remove("noscroll");
  removeFsGuards();
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
  let initial = selVideos.map(id => ({ id, title: (state.tiles.find(t=>t.vid===id)?.title) || `视频 ${id}` }));
  await syncWatched(initial.map(x=>x.id));
  if (!initial.length && selFolders.length){
    const firstFolderItems = await getFolderItems(selFolders[0]);
    await syncWatched(firstFolderItems.map(x=>x.id));
    if (!firstFolderItems.length){ hideBusy(); alert("该文件夹没有可播放视频"); return; }
    initial = firstFolderItems.filter(x=>!isWatched(x.id)).slice(0, Math.min(30, firstFolderItems.length));
  }
  if (!initial.length){ hideBusy(); alert("所选没有未完成的视频"); return; }
  await startPlaylist(initial, 0, state.path);
  progressive.seen = new Set(player.ids);
  const BATCH = 200;
  const producer = async function* (){
    const extraVideos = selVideos
      .map(id => ({ id, title: (state.tiles.find(t=>t.vid===id)?.title) || `视频 ${id}` }))
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

/* ★★★ 修改：取消订阅/批量取消订阅：统一复用 Steam「已订阅物品主页」并 postMessage 投递 IDs（不再打开详情页） ★★★ */
async function openBulkUnsub(ids, batch=1){
  try{
    const uniq = Array.from(new Set((ids||[]).map(String).filter(Boolean)));
    if (!uniq.length){ alert("没有可处理的条目"); return; }

    // 确认提示
    const okGo = confirm(`是否取消订阅${uniq.length}个项目？会同时删除本地文件！`);
    if (!okGo) return;

    // 统一：打开/复用订阅主页（不携带 workshop 详情页 id；不固化账号）
    // 使用 /my/ 指向当前登录账号，适合提交到 GitHub 的通用版本
    const steamSubUrl =
      "https://steamcommunity.com/my/myworkshopfiles?browsesort=mysubscriptions&browsefilter=mysubscriptions&appid=431960&p=1#bulk_unsub=1";

    // 用固定 window.name 复用同一个标签页；如果已开，不会新开
    const winName = "steam-bulk-unsub";
    // 注意：不要用 noopener，否则部分浏览器会让 window 引用变成 null，导致无法 postMessage 投递任务
    // 关键修复：window.open(url, name) 在已存在时会“导航/刷新”该标签页。
    // 我们希望复用已打开的订阅页并保持不刷新：先用 window.open("", name) 获取引用（不导航），必要时再打开目标 URL。
    let w = null;
    let openedOrNavigated = false;
    try{ w = window.open("", winName); }catch(_){ w = null; }
    if (!w || w.closed){
      w = window.open(steamSubUrl, winName);
      openedOrNavigated = !!w;
    } else {
      // 首次：window.open("", name) 会创建 about:blank（同源可读）。如果是空白页则立刻导航到订阅页。
      try{
        const href = (w.location && w.location.href) ? String(w.location.href) : "";
        if (href === "about:blank" || href === "") {
          try{ w.location.replace(steamSubUrl); }catch(_){ try{ w.location.href = steamSubUrl; }catch(__){} }
          openedOrNavigated = true;
        }
      }catch(_){
        // 跨域时无法读取 location：说明已经在 Steam 页面，无需刷新/导航
      }
    }
    if (!w){
      alert("无法打开 Steam 页面（可能被浏览器拦截了弹窗）。请允许弹窗后重试。");
      // 弹窗打不开则不应继续删除本地（否则会造成“本地删除了但 Steam 未退订”）
      return;
    } else {
      // 不要强制把焦点切到 Steam 页（用户不希望被打断）
      // 仅在首次新开/导航时，尽量把焦点抢回当前 WebUI（浏览器可能会忽略）
      if (openedOrNavigated){
        try{ w.blur && w.blur(); }catch(_){}
        try{ window.focus && window.focus(); }catch(_){}
        // 首次打开/导航：给订阅页加载和 userscript 初始化留足时间（避免 postMessage 投递时脚本还没就绪）
        await new Promise(r=>setTimeout(r, 1800));
      }

      // postMessage 投递：带 reqId，短时间重试直到收到 ack（避免订阅页加载慢导致丢消息）
      const reqId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const payload = { type: "bulk_unsub_add", ids: uniq, reqId };
      const maxAckMs = 10000, intervalMs = 250, startAt = Date.now();
      let acked = false;
      let donePayload = null;

      const onMsg = (ev)=>{
        const d = ev && ev.data;
        if (!d || d.reqId !== reqId) return;
        if (d.type === "bulk_unsub_ack") {
          acked = true;
          return;
        }
        if (d.type === "bulk_unsub_done") {
          donePayload = d;
          return;
        }
      };
      window.addEventListener("message", onMsg);

      const tick = ()=>{
        if (acked) return;
        if (Date.now() - startAt > maxAckMs){
          showNotice("已打开订阅页，但未收到脚本确认（可能脚本未启用/未加载）。本地不会删除。");
          setTimeout(clearNotice, 4500);
          return;
        }
        try{ w.postMessage(payload, "*"); }catch(_){}
        setTimeout(tick, intervalMs);
      };
      tick();

      // 等待 ACK（最多 maxAckMs）
      const waitAck = async ()=>{
        while (!acked && (Date.now() - startAt <= maxAckMs)) await new Promise(r=>setTimeout(r, 100));
        return acked;
      };
      const okAck = await waitAck();
      if (!okAck){
        try{ window.removeEventListener("message", onMsg); }catch(_){}
        return; // 不删除本地
      }
      showNotice(`任务已投递：${uniq.length} 项（等待 Steam 侧完成后再删除本地）`);
      setTimeout(clearNotice, 2500);

      // 等待 DONE（给足时间：最多 1 小时，避免大批量时误删本地）
      const doneDeadline = Date.now() + 60*60*1000;
      while (!donePayload && Date.now() < doneDeadline) await new Promise(r=>setTimeout(r, 250));
      try{ window.removeEventListener("message", onMsg); }catch(_){}
      if (!donePayload){
        showNotice("未收到完成回执，本地不会删除。");
        setTimeout(clearNotice, 4500);
        return;
      }

      // 收到完成回执后再删除本地
      primeBusy(`取消订阅完成（成功:${donePayload.ok||0} 失败:${donePayload.fail||0}），正在删除本地条目…`);
    }

    const ok = await deleteByIds(uniq);
    hideBusy();

    if (!ok){
      alert("删除本地条目失败，请稍后重试。");
    } else {
      removeTilesByVideoIds(uniq);
      showNotice(`已删除本地 ${uniq.length} 项`);
      setTimeout(clearNotice, 1500);
    }

    clearSel();
  }catch(_){}
}

/* 删除接口 —— 改为返回 boolean，兼容旧调用 */
async function deleteByIds(ids){
  try{
    const r = await fetch("/api/delete", {
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body: JSON.stringify({ids})
    });
    return !!(r && r.ok);
  }catch(_){
    return false;
  }
}

function removeTilesByVideoIds(ids){
  const set = new Set((ids || []).map(String).filter(Boolean));
  if (!set.size) return;
  const g = grid();
  if (!g) return;
  
  // 记录当前选中的第一个 tile 的索引（用于后续恢复 lastIdx）
  let firstSelectedIdx = null;
  for (let i = 0; i < state.tiles.length; i++) {
    if (isSel(state.tiles[i]) && !set.has(String(state.tiles[i].vid))) {
      firstSelectedIdx = i;
      break;
    }
  }
  
  const newTiles = [];
  for (const t of state.tiles){
    if (t && t.type === "video" && set.has(String(t.vid))){
      try{
        if (t.el && t.el.parentNode){
          t.el.parentNode.removeChild(t.el);
        }
      }catch(_){}
    } else {
      newTiles.push(t);
    }
  }
  state.tiles = newTiles;
  // 重新编号 idx，保持 getTile 正常工作
  state.tiles.forEach((t, idx)=>{
    t.idx = idx;
    if (t.el && t.el.dataset) t.el.dataset.idx = String(idx);
  });
  // 清理选中状态
  set.forEach(id=>{
    try{
      state.selV.delete(id);
      state.selV.delete(Number(id));
    }catch(_){}
  });
  
  // 更新 lastIdx：如果有其他选中的 tile，使用第一个；否则重置为 null
  if (firstSelectedIdx !== null && state.selV.size > 0) {
    // 查找原来的 tile 在新数组中的位置
    for (let i = 0; i < state.tiles.length; i++) {
      if (isSel(state.tiles[i])) {
        state.lastIdx = i;
        break;
      }
    }
  } else {
    state.lastIdx = null;
  }
}

function bindDelegatedEvents(){
  const el = grid();
  if (el._allBound) return;
  el._allBound = true;

  //---------------------------------------------------------
  // 左键点击处理 (保持不变)
  //---------------------------------------------------------
  el.addEventListener("click", async (ev)=>{
    const wbtn = ev.target.closest(".watched-btn");
    if (wbtn){
      ev.preventDefault();
      ev.stopPropagation();
      const t = getTile(wbtn);
      if (!t || t.type!=="video") return;
      const id = String(t.vid);
      const next = !isWatched(id);
      paintWatchedButton(wbtn, next);
      await setWatchedOptimistic(id, next);
      return;
    }

    const menuBtn = ev.target.closest(".tile-menu");
    if (menuBtn) {
      const t = getTile(menuBtn);
      if (!t) return;
      clearSel();
      setSel(t, true);
      state.lastIdx = t.idx;
      const b = menuBtn.getBoundingClientRect();
      openContextMenu(b.left + b.width/2, b.top + b.height);
      ev.stopPropagation();
      return;
    }

    const t = getTile(ev.target);
    if (!t) return;

    // CTRL 多选
    if (ev.ctrlKey) {
      setSel(t, !isSel(t));
      state.lastIdx=t.idx;
      ev.preventDefault();
      return;
    }

    // SHIFT 连选
    if (ev.shiftKey) {
      // 修复：刷新/移动后的第一次 Shift 可能 lastIdx 为空（或失效），但已有“锚点选中项”。
      // 规则：优先使用 lastIdx 指向且仍处于选中状态的 tile；否则使用当前已选中的某个 tile；再否则退化为自身。
      let start = t.idx;
      const lastTile = (state.lastIdx != null) ? state.tiles[state.lastIdx] : null;
      if (lastTile && isSel(lastTile)) {
        start = lastTile.idx;
      } else {
        // 即使 lastIdx 为 null，也要尝试从现有选择里找锚点（避免第一次 Shift 退化为单选）
        for (let i = 0; i < state.tiles.length; i++) {
          if (isSel(state.tiles[i])) { start = i; break; }
        }
      }
      const [a,b] = [start, t.idx].sort((x,y)=>x-y);
      if (!ev.ctrlKey) clearSel();
      for (let i=a;i<=b;i++) {
        if (state.tiles[i]) setSel(state.tiles[i], true);
      }
      state.lastIdx = t.idx;  // 更新 lastIdx
      ev.preventDefault();
      return;
    }

    // 普通单击
    t.el.classList.add("pulse");
    setTimeout(()=> t.el.classList.remove("pulse"), 200);

    clearSel();
    setSel(t,true);
    state.lastIdx=t.idx;

    if (t.type === "folder") {
      navigateToPath(t.path);
    } else {
      primeBusy("正在启动播放器…");
      await startPlaylist([{id:t.vid, title:t.title}], 0, state.path);
    }
  });

  //---------------------------------------------------------
  // ★ 右键菜单处理（移动端兼容，保持不变）
  //---------------------------------------------------------
  try { el.oncontextmenu = null; } catch(_) {}

  if (IS_MOBILE_UA) {
    el.addEventListener("contextmenu", e => {
      e.preventDefault();
      e.stopPropagation();
    }, { capture:true, passive:false });
    return;
  }

  //---------------------------------------------------------
  // ★★ 终极修复 V2：Grid 级右键捕获（彻底防止浏览器右键菜单）
  //     → 分离了“阻止默认行为”和“触发业务逻辑”，确保在边缘也能拦截。
  //---------------------------------------------------------
  (function installGridContextGuard(){
    const g = $("grid");
    if (!g || g._ctxGuardInstalled) return;

    // ◆ 业务逻辑：尝试选中 Tile 并打开自定义菜单
    //    如果点击的是 Grid 内的空白缝隙，则只清除选择。
    const tryTriggerCustomMenu = (ev) => {
      // 确保事件目标仍在 Grid 范围内
      if (!g.contains(ev.target)) return;

      let tile = ev.target.closest(".tile");
      if (!tile){
        // 点击了 Grid 内的空白处
        clearSel();
        hideMenu();
        return;
      }

      const idx = parseInt(tile.dataset.idx,10);
      const t = state.tiles[idx];
      if (!t){
        clearSel();
        hideMenu();
        return;
      }

      if (!isSel(t)){
        clearSel();
        setSel(t,true);
        state.lastIdx=t.idx;
      }

      // 使用事件触发时的坐标打开菜单
      openContextMenu(ev.clientX, ev.clientY);
    };

    // ◆ 核心拦截器：contextmenu
    //    使用 capture 阶段，无条件阻止默认行为，然后再尝试触发业务逻辑。
    g.addEventListener("contextmenu", (ev)=>{
      // 【关键修改】无条件阻止浏览器菜单，无论是否点中了 Tile
      ev.preventDefault();
      ev.stopPropagation();

      // 尝试执行业务逻辑
      tryTriggerCustomMenu(ev);
    }, { capture:true, passive:false });

    // ◆ 辅助拦截器：mouseup / pointerup
    //    处理某些浏览器或特定操作下不触发 contextmenu 的右键行为。
    const fallbackHandler = (ev) => {
      if (ev.button === 2){ // 右键
        ev.preventDefault();
        ev.stopPropagation();
        // 这里不需要再调用 tryTriggerCustomMenu，因为大部分桌面浏览器
        // 都会紧接着触发 contextmenu，由上面的监听器统一处理业务逻辑。
        // 如果在此处也调用，可能会导致菜单闪烁（触发两次）。
        // 这里的主要目的是确保在某些极端情况下阻止默认的浏览器行为。
      }
    };

    g.addEventListener("mouseup", fallbackHandler, {capture:true, passive:false});
    g.addEventListener("pointerup", fallbackHandler, {capture:true, passive:false});

    g._ctxGuardInstalled = true;
  })();
}

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
    add("播放此视频", ()=> { primeBusy("正在启动播放器…"); startPlaylist([{id:vid, title}], 0, state.path); });
    add("从该处开始播放（忽略已完成）", async ()=>{ await handlePlayFromHereProgressive(vid, title); });
    add("打开创意工坊链接", ()=> window.open(`https://steamcommunity.com/sharedfiles/filedetails/?id=${vid}`, "_blank"));
    add("取消订阅", ()=> openBulkUnsub([vid], 0));  // batch=0 表示单项模式
    sep();
    add("移动到主页", async ()=>{ await moveIdsAndRefresh([vid], "/"); });
    add("移动到…", async ()=>{ showFolderPicker(x,y, async (dest)=>{ await moveIdsAndRefresh([vid], dest); }); });
    sep();
    add("删除", async ()=>{
      if (!confirm("确定要永久删除该条目吗？此操作不可恢复。")) return;
      const ok = await deleteByIds([vid]);
      if (!ok){ alert("删除失败，请稍后重试"); return; }
      removeTilesByVideoIds([vid]);
      clearSel();
    });
    sep();
    add("在当前路径新建文件夹…", ()=> promptCreateFolder(state.path));
  } else if (oneFolder) {
    const path = [...state.selF][0];
    add("打开此文件夹", ()=> navigateToPath(path));
    add("播放此文件夹", async ()=>{ await progressivePlayFolder(path); });
    sep();
    add("在该文件夹下新建子文件夹…", ()=> promptCreateFolder(path));
    sep();
    add("在当前路径新建文件夹…", ()=> promptCreateFolder(state.path));
  } else {
    add("批量播放", async ()=>{ await progressivePlaySelection(); });
    add("批量取消订阅", async ()=>{
      const items = await expandSelectionToItems();
      const ids = items.map(x=>String(x.id));
      if (!ids.length){ alert("所选没有可取消订阅的条目"); return; }
      await openBulkUnsub(ids, 2);  // batch=2 表示批量模式
    });
    sep();
    add("移动所选到主页", async ()=>{
      const ids = await collectSelectedIds();
      await moveIdsAndRefresh(ids, "/");
    });
    add("移动所选到…", async ()=>{
      const ids = await collectSelectedIds();
      if (!ids.length){ alert("没有可移动的条目"); return; }
      showFolderPicker(x,y, async (dest)=>{ await moveIdsAndRefresh(ids, dest); });
    });
    sep();
    add("删除所选", async ()=>{
      const items = await expandSelectionToItems();
      if (!items.length) return alert("所选没有可删除的视频");
      if (!confirm(`确认永久删除 ${items.length} 项？此操作不可恢复。`)) return;
      const ids = items.map(x=>x.id);
      const ok = await deleteByIds(ids);
      if (!ok){ alert("删除失败，请稍后重试"); return; }
      removeTilesByVideoIds(ids);
      clearSel();
    });
    sep();
    add("在当前路径新建文件夹…", ()=> promptCreateFolder(state.path));
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

  const panel = $("playlistPanel");
  if (panel){
    if (window.innerHeight > window.innerWidth){
      panel.style.width = Math.min(Math.floor(window.innerWidth*0.92), 560) + "px";
    } else {
      panel.style.width = "";
    }
  }
}
function hidePlaylistPanel(){
  uiLock.byPlaylist = false;
  $("playerFS").classList.remove("locked");
  const panel = $("playlistPanel");
  if (panel) panel.classList.add("hidden");
  const shade = $("shade");
  if (shade){
    shade.classList.add("hidden");
    if (shade._closeOnShade){ shade.removeEventListener("click", shade._closeOnShade); shade._closeOnShade=null; }
    if (shade._blockScroll){
      shade.removeEventListener("wheel", shade._blockScroll);
      shade.removeEventListener("touchmove", shade._blockScroll);
      shade._blockScroll=null;
    }
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

/* ========================= 纯进度心跳检测 + 锚点缓存 + 稳定重启 ========================= */
/*
  - 舍弃能量检测，仅看 currentTime 前进；
  - 每 3s 检测一次；连续 6 次（≈18s）几乎不前进（Δpos < 0.2s）→ 掐断；
  - 掐断后的重启点使用“锚点时间缓存” lastGoodLogical（逻辑时间 = currentTime - audioBias）；
  - 采用 doSilentRestart()：新建 Audio → 等 loadedmetadata → 计算 bias → seek 到 (lastGoodLogical + bias) → 替换元素 → 重绑事件 → play()；
  - 掐断后进入 45s 冷却；暂停/切集/寻位/载入元数据 会重置计数和锚点；
  - 仅在「后台 + 音频模式 + 正在播放」下运行。
*/
const stallHB = {
  active:false,
  timer:null,
  intervalMs:3000,     // 3s 心跳
  eps:0.2,             // 认为“几乎不动”的阈值（秒）
  needCount:6,         // 连续 6 次（≈18s）
  cooldownMs:45000,    // 掐断间隔 45s
  lastPos:0,
  stallCount:0,
  cooldownUntil:0,
  lastGoodLogical:0,   // ★ 锚点缓存（逻辑时间）
  lastWall: 0          // [MIN-FIX#2] 上次墙钟心跳时间（ms, performance.now）
};
function _logicalAudioTime(aEl){
  const t = Number.isFinite(aEl?.currentTime) ? aEl.currentTime : 0;
  return Math.max(0, t - (audioBias||0));
}
function resetStallHeartbeat(aEl){
  stallHB.stallCount = 0;
  stallHB.lastPos = Number.isFinite(aEl?.currentTime) ? aEl.currentTime : 0;
  stallHB.cooldownUntil = 0; 
  stallHB.lastGoodLogical = _logicalAudioTime(aEl);
  stallHB.lastWall = performance.now(); // [MIN-FIX#2]
}

/* ★ 抽出：心跳模块音频事件（可在替换音频后重复绑定） */
function bindAudioEventsForStallHBOn(a){
  if (!a || a._stallHBBound) return;
  a._stallHBBound = true;

  a.addEventListener("playing", ()=>{
    if (document.visibilityState === "hidden" && isPlayerActive() && playbackMode==="audio"){
      // 先 Gate 观察，避免直接进入重型心跳
      resetGateBaseline(a);
      stopStallHeartbeat();
      startGateHeartbeat();
    }
  });
  a.addEventListener("pause", ()=>{
    resetGateBaseline(a);
    stopGateHeartbeat();
    resetStallHeartbeat(a);
    stopStallHeartbeat();
    try{ stopMinuteResync(); }catch(_){}
  });
  a.addEventListener("ended", ()=>{
    resetGateBaseline(a);
    stopGateHeartbeat();
    resetStallHeartbeat(a);
    stopStallHeartbeat();
    try{ stopMinuteResync(); }catch(_){}
  });
  a.addEventListener("seeking", ()=>{
    resetGateBaseline(a);
    resetStallHeartbeat(a);
  });
  a.addEventListener("loadedmetadata", ()=>{
    resetGateBaseline(a);
    resetStallHeartbeat(a);
  });
}

/* ★ 替换后重绑：near-end、stalled、position、keepAlive、心跳等 */
function bindAudioCoreEventsAfterReplace(a){
  if (!a) return;
  try{
    a.playsInline = true; a.setAttribute("playsinline",""); a.setAttribute("webkit-playsinline","");
    a.disableRemotePlayback = true;
    a.preload = "auto";
  }catch(_){}

  a.addEventListener("ended", ()=> handleEndedFromAny(a));
  installAudioNearEndDetector(a);
  installStallListeners(media.v||$("fsVideo"), a);

  a.addEventListener("timeupdate", updatePositionState);
  a.addEventListener("loadedmetadata", updatePositionState);
  a.addEventListener("durationchange", updatePositionState);
  a.addEventListener("playing", ()=>{
    clearUserPaused(); updatePositionState(); startPosTicker();
    if (playbackMode==="audio") startBgKeepAlive();
    try{ startMinuteResync(); }catch(_){}
  });
  a.addEventListener("pause",   ()=>{
    if (document.visibilityState==='visible') markUserPaused();
    updatePositionState(); stopBgKeepAlive();
  });

  bindAudioEventsForStallHBOn(a);
}

/* —— 首次为现有 bgAudio 绑定心跳监听 —— */
(function initialBindAudioHB(){
  const a = $("bgAudio");
  if (!a) return;
  bindAudioEventsForStallHBOn(a);
})();

/* ★ 核心：稳定后台重启，避免回到开头（并用墙钟推算累计播放点） */
async function doSilentRestart(oldAudio, phase="stallHB"){
  const id = player.ids[player.index];
  if (!id) return;

  const wasPaused = !!oldAudio?.paused;
  const wasMuted  = !!oldAudio?.muted;

  // [MIN-FIX#1] —— 用墙钟时间推算 resumeAtLogical，避免锚点滞后累积
  const nowMs = performance.now();
  const elapsed = Math.max(0, (nowMs - (stallHB.lastWall || nowMs)) / 1000);
  const predictedLogical = Math.max(0, (stallHB.lastGoodLogical || 0) + elapsed * 0.9);
  const resumeAtLogical = predictedLogical;

  console.log(`[StallHB] ${phase} restart → resume at ${resumeAtLogical.toFixed(3)}s (logical, +${elapsed.toFixed(2)}s*0.9)`);

  try{
    // 1) 只创建新元素与 src，不立即播放
    const newSrc = audioSrcOf(id, /*cacheBust*/ true);
    const newAudio = new Audio();
    newAudio.src = newSrc;
    newAudio.preload = "auto";
    newAudio.muted = wasMuted;
    newAudio.volume = wasMuted ? 0 : Math.max(0.6, oldAudio?.volume || 0.6);

    // 2) 等待元数据（可安全 seek）
    await new Promise((resolve, reject)=>{
      const onMeta = ()=>{ newAudio.removeEventListener("loadedmetadata", onMeta); resolve(); };
      const onErr  = (e)=>{ newAudio.removeEventListener("error", onErr); reject(e); };
      newAudio.addEventListener("loadedmetadata", onMeta);
      newAudio.addEventListener("error", onErr);
      newAudio.load();
    });

    // 同步/计算新的 bias
    audioBias = computeAudioBias(newAudio);

    // 3) 目标 = 预测逻辑时间 + 新 bias
    const target = Math.max(0, resumeAtLogical + (audioBias||0));
    try { newAudio.currentTime = target; } catch (err) {
      console.warn("[StallHB] initial seek failed, fallback to 0", err);
      newAudio.currentTime = 0;
    }

    // 保险：首个 timeupdate 验证位置，不对则强制再 seek 一次
    const verifyOnce = ()=>{
      const cur = newAudio.currentTime || 0;
      if (Math.abs(cur - target) > 1.5){
        try{ newAudio.currentTime = target; }catch(_){}
      }
    };
    newAudio.addEventListener("timeupdate", verifyOnce, { once:true });

    // 4) 替换旧的 bgAudio 元素
    const old = $("bgAudio");
    if (old && old.parentNode) old.parentNode.replaceChild(newAudio, old);
    newAudio.id = "bgAudio";
    media.a = newAudio;

    // 5) 重新绑定项目依赖的所有音频事件
    bindAudioCoreEventsAfterReplace(newAudio);

    // 6) 播放（如原先在播放）
    if (!wasPaused){
      try { await newAudio.play(); } catch (err) {
        console.warn("[StallHB] play() failed:", err);
      }
    }

    // 7) 刷新心跳基线与锚点 & 记下墙钟
    stallHB.lastPos = Number.isFinite(newAudio.currentTime) ? newAudio.currentTime : 0;
    stallHB.lastGoodLogical = resumeAtLogical;
    stallHB.lastWall = performance.now(); // [MIN-FIX#2]

    console.log(`[StallHB] restart complete, playing from ${resumeAtLogical.toFixed(3)}s (logical), bias=${(audioBias||0).toFixed(3)}s`);
  }catch(err){
    console.warn("[StallHB] restart failed:", err);
  }
}

function stopStallHeartbeat(){
  stallHB.active = false;
  if (stallHB.timer){ clearInterval(stallHB.timer); stallHB.timer = null; }
}
function startStallHeartbeat(){
  if (stallHB.active) return;
  const a = media.a || $("bgAudio");
  if (!a) return;
  if (document.visibilityState !== "hidden") return;
  if (playbackMode !== "audio") return;
  if (a.paused) return;

  resetStallHeartbeat(a);
  stallHB.active = true;

  if (stallHB.timer) clearInterval(stallHB.timer);
  stallHB.timer = setInterval(async ()=>{
    const aEl = media.a || $("bgAudio");
    if (!isPlayerActive() || playbackMode!=="audio" || !aEl){ stopStallHeartbeat(); return; }
    if (document.visibilityState!=="hidden" || aEl.paused) return;
    if (aEl.seeking) { resetStallHeartbeat(aEl); return; }
    if (scrubGuard.active) return;
    if (stallRepair.inFlight) return;

    // [MIN-FIX#2] 每次 tick 更新 lastWall，用于墙钟推算
    stallHB.lastWall = performance.now();

    const pos = Number.isFinite(aEl.currentTime) ? aEl.currentTime : 0;
    const advanced = (pos - stallHB.lastPos) >= stallHB.eps;
    stallHB.lastPos = pos;

    if (advanced){
      // ★ 进度在向前，更新锚点为“最近一次可靠播放时间（逻辑）”
      stallHB.lastGoodLogical = _logicalAudioTime(aEl);
      stallHB.stallCount = 0;
      return;
    } else {
      stallHB.stallCount++;
    }

    if (stallHB.stallCount >= stallHB.needCount){
      if (performance.now() < stallHB.cooldownUntil){
        stallHB.stallCount = 0;
        return;
      }
      // ★ 改为“硬重启”以保证后台 seek 生效
      await doSilentRestart(aEl, "stallHB");

      // 进入冷却并刷新基线
      const aa = media.a || $("bgAudio");
      stallHB.cooldownUntil = performance.now() + stallHB.cooldownMs;
      stallHB.stallCount = 0;
      stallHB.lastPos = Number.isFinite(aa?.currentTime) ? aa.currentTime : 0;
      stallHB.lastGoodLogical = _logicalAudioTime(aa);
      stallHB.lastWall = performance.now(); // [MIN-FIX#2]
    }
  }, stallHB.intervalMs);
}

/* === 静音每分钟重播对齐（Minute Resync） === */
const _minuteResync = { timer:null, active:false, periodMs:60000 };
function startMinuteResync(){
  if (_minuteResync.active) return;
  _minuteResync.active = true;
  if (_minuteResync.timer) clearInterval(_minuteResync.timer);
  _minuteResync.timer = setInterval(async ()=>{
    try{
      const aEl = media.a || $("bgAudio");
      if (!isPlayerActive() || playbackMode!=="audio" || !aEl) return;
      if (document.visibilityState!=="hidden") return;
      if (aEl.paused || aEl.seeking) return;
      if (scrubGuard.active || stallRepair.inFlight) return;
      // 每周期进行一次“硬重播+对齐”以防 UA 挂起静音段
      await doSilentRestart(aEl, "minute-resync");
    }catch(_){}
  }, _minuteResync.periodMs);
}
function stopMinuteResync(){
  _minuteResync.active = false;
  if (_minuteResync.timer){ clearInterval(_minuteResync.timer); _minuteResync.timer = null; }
}
/* === 静音每分钟重播对齐（Minute Resync）·完 === */

/* —— 生命周期：使用 Gate 作为前置，再决定是否进入 stallHB —— */
document.addEventListener("visibilitychange", ()=>{
  const a = media.a || $("bgAudio");
  if (!a) return;
  if (document.visibilityState === "hidden" && isPlayerActive() && playbackMode==="audio" && !a.paused){
    resetGateBaseline(a);
    stopStallHeartbeat();
    startGateHeartbeat();     startMinuteResync(); // 先门卫，再纯心跳
  } else {
    stopGateHeartbeat();
    stopStallHeartbeat();
  stopMinuteResync(); }
});

/* —— 兜底：极少设备不发 visibilitychange，这里每 5s 尝试一次 —— */
setInterval(()=>{
  const a = media.a || $("bgAudio");
  if (document.visibilityState === "hidden" && isPlayerActive() && playbackMode==="audio" && a && !a.paused){
    startStallHeartbeat();
  }
}, 5000);

/* ========================= 纯进度心跳检测 + 稳定重启（完） ========================= */
