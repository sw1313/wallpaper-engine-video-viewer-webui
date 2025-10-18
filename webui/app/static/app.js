/* app/static/app.js (fs-27)
   关键改动：
   - “全屏内物理返回键”：进入播放时 pushState 占位；popstate 时若播放器开启则仅退出全屏
   - 息屏/切后台继续播放音频：
       * 独立 <audio id="bgAudio"> 不用 display:none（避免被浏览器挂起）
       * 首次用户手势解锁播放（unlockPlaybackOnUserGesture）
       * visibilitychange/pagehide/freeze 时切换到 audio；前台恢复 video
       * play() Promise 失败时优雅提示并等待下一次用户手势
       * Media Session API：绝对 URL 的封面、上一/下一/seek 控制
   - 保留：hash 路由、渐进“边拉边播”、已播放打勾
*/
console.log("app.js version fs-27");

/* ---- 全局状态 ---- */
let state = { path:"/", page:1, per_page:45, sort_idx:0, mature_only:false, q:"",
  selV:new Set(), selF:new Set(), lastIdx:null, tiles:[], dragging:false, dragStart:null, keepSelection:false,
  isLoading:false, hasMore:true, queryKey:"" };

let player = { ids:[], titles:{}, index:0, idleTimer:null, returnPath:"/" };

/* —— 预取状态（滚动加载网格） —— */
let prefetchState = { key:"", page:0, opts:null, data:null, controller:null, inflight:false };

/* —— 渐进播放（后台追加器） —— */
let progressive = { key:"", running:false, cancel:false, seen:new Set() };

/* —— 模态锁 —— */
let uiLock = { byPlaylist:false };

/* —— 手势/滚动防穿透管理 —— */
const modalGuards = [];
function addModalGuard(type, handler, opts){ document.addEventListener(type, handler, opts); modalGuards.push([type, handler, opts]); }
function removeModalGuards(){ for(const [t,h,o] of modalGuards){ document.removeEventListener(t,h,o); } modalGuards.length = 0; }

const $ = (id) => document.getElementById(id);
const grid = () => $("grid");

/* ======== UA 识别 ======== */
function detectByUA(){
  const ua = navigator.userAgent || navigator.vendor || window.opera || "";
  try { const o = localStorage.getItem("uaMode");
    if (o === "desktop") return { isMobile: false, ua };
    if (o === "mobile")  return { isMobile: true, ua };
  } catch(_) {}
  const isMobile = /Android|iPhone|iPad|iPod|Windows Phone|Mobi|Mobile|Tablet|Kindle|Silk|Opera Mini|BlackBerry|BB10/i.test(ua);
  return { isMobile, ua };
}
const UA = detectByUA();
const IS_MOBILE_UA = UA.isMobile;

/* ====== 已完成持久化 ====== */
const WATCH_KEY = "we_watched_ids_v1";
let watched = new Set();
function loadWatched(){ try{ watched = new Set(JSON.parse(localStorage.getItem(WATCH_KEY) || "[]")); }catch(_){ watched = new Set(); } }
function saveWatched(){ try{ localStorage.setItem(WATCH_KEY, JSON.stringify([...watched])); }catch(_){ } }
function isWatched(id){ return watched.has(id); }
function markWatched(id){ if (!id) return; if (!watched.has(id)){ watched.add(id); saveWatched(); } updateTileWatchedUI(id, true); }
function updateTileWatchedUI(id, done){
  const t = state.tiles.find(t => t.type==="video" && t.vid===id);
  if (t){ const badge = t.el.querySelector(".status-badge"); if (badge) badge.classList.toggle("done", !!done); }
}

/* ===== 通用工具 ===== */
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

/* ======================
   Hash 路由（返回到上一路径）
   ====================== */
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

/* 骨架屏 */
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

/* 查询 key & 快照 */
function makeQueryKey(){ return `${state.path}|${state.sort_idx}|${state.mature_only?'1':'0'}|${state.q}`; }
function snapshotOpts(){ return { path:state.path, sort_idx:state.sort_idx, mature_only:state.mature_only, q:state.q, per_page:state.per_page }; }

/* REST：scan（分页） */
async function apiScan(opts, page, signal){
  const params = new URLSearchParams({ path:opts.path, page, per_page:opts.per_page, sort_idx:opts.sort_idx, mature_only:opts.mature_only, q:opts.q });
  const res = await fetch(`/api/scan?${params.toString()}`, { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/* 预取下一页（网格滚动） */
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

/* 自动补页（网格） */
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

/* 加载一页并渲染（网格） */
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
    appendTiles(data);

    state.hasMore = state.page < data.total_pages;
    state.page += 1;
    setInfStatus(state.hasMore ? "下拉加载更多…" : "已到底部");

    bindDelegatedEvents(); bindRubber(); schedulePrefetch();
  }catch{ setInfStatus("加载失败，请重试"); }
  finally{ state.isLoading=false; queueMicrotask(()=>autoFillViewport(3)); }
}

/* 追加 tiles */
function appendTiles(data){
  let idx = state.tiles.length;
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
    const el = document.createElement("div");
    el.className="tile"; el.dataset.type="video"; el.dataset.vid=v.id; el.dataset.idx=idx;
    el.innerHTML = `<div class="thumb">
                      <img src="${v.preview_url}" alt="preview" draggable="false" loading="lazy" decoding="async" fetchpriority="low"/>
                    </div>
                    <div class="status-badge ${done?'done':''}" title="${done?'已播放完成':''}">✓</div>
                    <div class="title">${v.title}</div>
                    <div class="meta">${fmtDate(v.mtime)} · ${fmtSize(v.size)} · ${v.rating||"-"}</div>
                    <button class="tile-menu" title="菜单">⋮</button>`;
    grid().appendChild(el); state.tiles.push({el, type:"video", vid:v.id, idx, title:v.title}); idx++;
  });
}

/* 状态条 */
function setInfStatus(text){ const el=$("infiniteStatus"); if(el) el.textContent = text || ""; }

/* 切换上下文（网格） */
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

/* 面包屑 html */
function buildCrumbHtml(pathStr){
  const html = ["<a class='link' href=\"#/\">/</a>"];
  const segs = pathStr.split("/").filter(Boolean);
  segs.forEach((seg,i)=>{ const p="/"+segs.slice(0,i+1).join("/"); html.push(`<a class='link' href='#${p}'>${seg}</a>`); });
  return "当前位置：" + html.join(" / ");
}

/* —— 事件委托（网格 + 右键） —— */
function getTile(target){ const el = target.closest(".tile"); if(!el) return null; const idx = parseInt(el.dataset.idx,10); return state.tiles[idx] || null; }

function bindDelegatedEvents(){
  const el = grid(); if (el._allBound) return; el._allBound = true;

  // 点击/选择/进入
  el.addEventListener("click", async (ev)=>{
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
    else await startPlaylist([{id:t.vid, title:t.title}], 0, state.path);
  });

  // 右键（桌面 UA）
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

/* 右键/⋮菜单（渐进播放；仅“打开此文件夹”做导航） */
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
    add("播放此视频（全屏）", ()=> startPlaylist([{id:vid, title}], 0, state.path));
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

/* 删除 */
async function deleteByIds(ids){ await fetch("/api/delete", { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({ids}) }); }

/* —— 递归列出某路径全部视频 —— */
async function getFolderItems(path){
  const params = new URLSearchParams({ path, sort_idx: state.sort_idx, mature_only: state.mature_only, with_meta: "1" });
  const r = await fetch(`/api/folder_videos?${params.toString()}`);
  const j = await r.json();
  return (j.items || []).map(it => ({id: it.id, title: it.title || `视频 ${it.id}`}));
}

/* —— 选择集展开（删除用） —— */
async function expandSelectionToItems(){
  const list = [];
  state.selV.forEach(id => list.push({id, title: (state.tiles.find(t=>t.vid===id)?.title) || `视频 ${id}`}));
  for (const p of state.selF) list.push(...await getFolderItems(p));
  const seen = new Set(); const out=[];
  for (const it of list) if(!seen.has(it.id)){ seen.add(it.id); out.push(it); }
  return out;
}

/* ===== 抽屉模态 ===== */
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

/* ===== 渐进追加器 ===== */
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

/* ======= 顶部“播放未完成” ======= */
async function handlePlayUnwatched(){
  cancelProgressive();
  const initial = getCurrentlyLoadedVideoItems().filter(x => !isWatched(x.id)).slice(0, 30);
  if (initial.length){ await startPlaylist(initial, 0, state.path); progressive.seen = new Set(player.ids); }
  const initialSet = new Set(initial.map(i=>i.id));
  const BATCH = 200;
  const producer = async function* (){
    const all = await getFolderItems(state.path);
    const pending = all.filter(x => !isWatched(x.id) && !initialSet.has(x.id));
    for (const part of chunk(pending, BATCH)) yield part;
  };
  if (!initial.length){
    const all = await getFolderItems(state.path);
    const pending = all.filter(x => !isWatched(x.id));
    const first = pending.slice(0, 30);
    if (!first.length){ setInfStatus("当前路径下没有未完成的视频"); return; }
    await startPlaylist(first, 0, state.path);
    progressive.seen = new Set(player.ids);
    const restSet = new Set(first.map(i=>i.id));
    const p2 = async function* (){
      const all2 = await getFolderItems(state.path);
      const pend2 = all2.filter(x => !isWatched(x.id) && !restSet.has(x.id));
      for (const part of chunk(pend2, BATCH)) yield part;
    };
    progressiveAppendFrom(p2, "未完成后台加载");
  } else {
    progressiveAppendFrom(producer, "未完成后台加载");
  }
}

/* ======= 从该处开始播放 ======= */
async function handlePlayFromHereProgressive(vid, title){
  cancelProgressive();
  const initial = [{ id: vid, title: title || `视频 ${vid}` }];
  await startPlaylist(initial, 0, state.path);
  progressive.seen = new Set(player.ids);

  const initialSet = new Set([vid]);
  const BATCH = 200;
  const producer = async function* (){
    const all = await getFolderItems(state.path);
    const idx = all.findIndex(x => x.id === vid);
    const tail = (idx>=0) ? all.slice(idx+1) : all;
    const pending = tail.filter(x => !initialSet.has(x.id));
    for (const part of chunk(pending, BATCH)) yield part;
  };
  progressiveAppendFrom(producer, "从该处后台加载");
}

/* ======= 播放文件夹 ======= */
async function progressivePlayFolder(path){
  cancelProgressive();
  setInfStatus("准备读取文件夹…");
  const all = await getFolderItems(path);
  if (!all.length){ alert("该文件夹没有可播放视频"); return; }

  const initial = all.slice(0, Math.min(30, all.length));
  await startPlaylist(initial, 0, path);
  progressive.seen = new Set(player.ids);

  const initialSet = new Set(initial.map(i=>i.id));
  const BATCH = 200;
  const producer = async function* (){
    const rest = all.filter(x => !initialSet.has(x.id));
    for (const part of chunk(rest, BATCH)) yield part;
  };
  progressiveAppendFrom(producer, "文件夹后台加载");
}

/* ======= 批量播放 ======= */
async function progressivePlaySelection(){
  cancelProgressive();
  const selVideos = [...state.selV], selFolders = [...state.selF];

  let initial = selVideos.map(id => ({ id, title: (state.tiles.find(t=>t.vid===id)?.title) || `视频 ${id}` }));
  if (!initial.length && selFolders.length){
    const firstFolderItems = await getFolderItems(selFolders[0]);
    if (!firstFolderItems.length){ alert("所选文件夹没有可播放视频"); return; }
    initial = firstFolderItems.slice(0, Math.min(30, firstFolderItems.length));
  }
  if (!initial.length){ alert("所选没有可播放视频"); return; }

  await startPlaylist(initial, 0, state.path);
  progressive.seen = new Set(player.ids);

  const initialSet = new Set(initial.map(i=>i.id));
  const BATCH = 200;

  const producer = async function* (){
    const extraVideos = selVideos.filter(id => !initialSet.has(id)).map(id => ({ id, title: (state.tiles.find(t=>t.vid===id)?.title) || `视频 ${id}` }));
    if (extraVideos.length) yield extraVideos;
    for (let i=0;i<selFolders.length;i++){
      const items = await getFolderItems(selFolders[i]);
      const pending = items.filter(x => !progressive.seen.has(x.id));
      for (const part of chunk(pending, BATCH)) yield part;
    }
  };
  progressiveAppendFrom(producer, "批量后台加载");
}

/* 取得当前已加载视频（用于“播放未完成”的首批） */
function getCurrentlyLoadedVideoItems(){
  const out = []; for (const t of state.tiles){ if (t.type === "video") out.push({ id:t.vid, title:t.title || `视频 ${t.vid}` }); }
  return out;
}

/* =========================
   播放器（全屏 & 后台音频）
   ========================= */
let fsOverlayInHistory = false;     // 是否压入了“全屏占位”的历史项
let playbackMode = "video";         // 'video' | 'audio'
const media = { v:null, a:null };

function isPlayerActive(){ return $("playerFS").style.display !== "none"; }

/* ---- 首次用户手势解锁播放 ---- */
let userGestureUnlocked = false;
async function unlockPlaybackOnUserGesture(){
  if (userGestureUnlocked) return;
  const a = $("bgAudio"), v = $("fsVideo");
  try {
    await a.play(); a.pause();
    userGestureUnlocked = true;
    console.log("playback unlocked via audio");
  } catch (e) {
    try { await v.play(); v.pause(); userGestureUnlocked = true; console.log("playback unlocked via video"); }
    catch(e2){ console.log("unlock playback failed — will retry on next gesture"); }
  }
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

/* ---- popstate：全屏内第一次返回仅退出全屏 ---- */
function installPopStateGuard(){
  window.addEventListener("popstate", () => {
    if (isPlayerActive()){
      fsOverlayInHistory = false; // 弹出这层占位
      exitPlayer();               // 仅退出全屏，不做路径跳转
    }
  });
}
installPopStateGuard();

/* ---- 播放封装 ---- */
async function safePlay(el){
  try { await el.play(); return true; }
  catch(e){ console.warn("play() rejected:", e); return false; }
}

/* ---- 切换：前台 video / 后台 audio ---- */
async function switchToAudio(){
  if (!isPlayerActive() || playbackMode === "audio") return;
  const v = media.v || $("fsVideo");
  const a = media.a || $("bgAudio");
  media.v = v; media.a = a;

  const src = v.src || `/media/video/${player.ids[player.index]}`;
  if (a.src !== src) a.src = src;
  try { if (!isNaN(v.currentTime)) a.currentTime = v.currentTime; } catch(_){}

  // 先尝试 audio 播放，成功后再暂停 video（失败则维持 video）
  const ok = await safePlay(a);
  if (ok){
    try{ v.pause(); }catch(_){}
    playbackMode = "audio";
    updateMediaSessionPlaybackState();
  } else {
    showNotice("浏览器阻止后台播放，请点击页面任意处以解锁。");
    installUserGestureUnlock();
  }
}
async function switchToVideo(){
  if (!isPlayerActive() || playbackMode === "video") return;
  const v = media.v || $("fsVideo");
  const a = media.a || $("bgAudio");
  media.v = v; media.a = a;

  try { if (!isNaN(a.currentTime)) v.currentTime = a.currentTime; } catch(_){}
  const ok = await safePlay(v);
  if (ok){
    try{ a.pause(); }catch(_){}
    playbackMode = "video";
    updateMediaSessionPlaybackState();
  } else {
    showNotice("恢复视频播放被阻止，点击屏幕继续。");
    installUserGestureUnlock();
  }
}

/* ---- 前后台切换监听 ---- */
document.addEventListener("visibilitychange", async ()=>{
  if (!isPlayerActive()) return;
  if (document.visibilityState === "hidden") {
    await switchToAudio();
    const ok = await safePlay(media.a || $("bgAudio"));
    if (!ok){ showNotice("后台播放被阻止，需要点击一次屏幕以继续。"); installUserGestureUnlock(); }
  } else {
    await switchToVideo();
    const ok = await safePlay(media.v || $("fsVideo"));
    if (!ok){ showNotice("恢复前台播放被阻止，点击屏幕继续。"); installUserGestureUnlock(); }
  }
});
// 兼容：部分浏览器在 pagehide/freeze 时冻结
window.addEventListener("pagehide", ()=> { if (isPlayerActive()) switchToAudio(); });
document.addEventListener("freeze",   ()=> { if (isPlayerActive()) switchToAudio(); });

/* ---- 统一结束事件（避免双触发） ---- */
function handleEndedFromActive(el){
  const activeElId = (playbackMode === "video" ? "fsVideo" : "bgAudio");
  if (el.id !== activeElId) return;
  const curId = player.ids[player.index];
  markWatched(curId);
  nextInPlaylist();
}

/* ---- Media Session ---- */
function setMediaSessionMeta(id){
  if (!("mediaSession" in navigator)) return;
  const title = player.titles[id] || `视频 ${id}`;
  const origin = location.origin;
  const artwork = [
    { src: `${origin}/media/preview/${id}`, sizes:"512x512", type:"image/png" },
    { src: `${origin}/media/preview/${id}?s=128`, sizes:"128x128", type:"image/png" },
  ];
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title, artist:"Wallpaper Engine", album: state.path, artwork
    });
  } catch(_){}

  if (!setMediaSessionMeta._installed){
    const getActive = ()=> (playbackMode==="video" ? media.v || $("fsVideo") : media.a || $("bgAudio"));
    navigator.mediaSession.setActionHandler("play", async ()=>{ await safePlay(getActive()); });
    navigator.mediaSession.setActionHandler("pause", ()=>{ try{ getActive().pause(); }catch(_){ } });
    navigator.mediaSession.setActionHandler("previoustrack", async ()=>{ if (player.index>0) await playIndex(player.index-1); });
    navigator.mediaSession.setActionHandler("nexttrack", async ()=>{ await nextInPlaylist(); });
    navigator.mediaSession.setActionHandler("seekbackward", (d)=>{ const el=getActive(); el.currentTime=Math.max(0, el.currentTime-(d?.seekOffset||10)); });
    navigator.mediaSession.setActionHandler("seekforward", (d)=>{ const el=getActive(); el.currentTime=Math.min((el.duration||1e9), el.currentTime+(d?.seekOffset||10)); });
    navigator.mediaSession.setActionHandler("seekto", (d)=>{ const el=getActive(); if (d.fastSeek && "fastSeek" in el) el.fastSeek(d.seekTime); else el.currentTime = d.seekTime; });
    setMediaSessionMeta._installed = true;
  }
  updateMediaSessionPlaybackState();
}
function updateMediaSessionPlaybackState(){
  if (!("mediaSession" in navigator)) return;
  const el = (playbackMode==="video" ? media.v || $("fsVideo") : media.a || $("bgAudio"));
  try { navigator.mediaSession.playbackState = el.paused ? "paused" : "playing"; } catch(_){}
}

/* ===== 全屏播放器（结束→打勾→自动播下一个） ===== */
async function startPlaylist(items, startIndex=0, returnPath=null){
  cancelProgressive();

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

  if (!v._bound) {
    v.addEventListener("ended", ()=> handleEndedFromActive(v));
    a.addEventListener("ended", ()=> handleEndedFromActive(a));
    v._bound = a._bound = true;
  }

  // 进入全屏 + 压入占位历史项（保证物理返回先退出全屏）
  try { 
    if (wrap.requestFullscreen) await wrap.requestFullscreen({ navigationUI: "hide" });
    else if (wrap.webkitRequestFullscreen) await wrap.webkitRequestFullscreen();
  } catch(_){}
  try { history.pushState({ fsOverlay:true }, ""); fsOverlayInHistory = true; } catch(_) {}

  $("btnBack").onclick = async ()=>{
    if (uiLock.byPlaylist) return;
    await exitPlayer();
    if (fsOverlayInHistory){ fsOverlayInHistory = false; try{ history.back(); }catch(_){ } }
    if (state.path !== player.returnPath) navigateToPath(player.returnPath);
  };

  $("btnMenu").onclick = ()=>{
    if ($("playlistPanel").classList.contains("hidden")) showPlaylistPanel();
    else hidePlaylistPanel();
  };

  wrap.addEventListener("mousemove", wakeOverlay);
  wrap.addEventListener("touchstart", wakeOverlay);
  wakeOverlay();

  // 确保尽早解锁
  unlockPlaybackOnUserGesture();

  await playIndex(player.index);
}
function wakeOverlay(){
  const wrap = $("playerFS");
  wrap.classList.remove("idle");
  if (player.idleTimer) clearTimeout(player.idleTimer);
  player.idleTimer = setTimeout(()=> wrap.classList.add("idle"), 1500);
}

async function playIndex(i){
  player.index = i;
  const id = player.ids[i];
  const v = media.v || $("fsVideo");
  const a = media.a || $("bgAudio");

  const src = `/media/video/${id}`;
  v.src = src;
  a.src = src; // 方便随时切后台音频

  setMediaSessionMeta(id);

  // 根据当前模式选择播放介质
  if (document.visibilityState === "hidden") playbackMode = "audio"; else playbackMode = "video";
  const ok = await safePlay(playbackMode==="audio" ? a : v);
  if (!ok){
    showNotice("播放被阻止：请点击屏幕以继续播放。");
    installUserGestureUnlock();
  }
  renderPlaylistPanel();
}
function renderPlaylistPanel(){
  const ul = $("plist"); ul.innerHTML = "";
  player.ids.forEach((id, i)=>{
    const li = document.createElement("li");
    li.className = (i===player.index) ? "active" : "";
    li.innerHTML = `<span class="dot"></span><span>${player.titles[id] || ("视频 "+id)}</span>`;
    li.onclick = ()=> playIndex(i);
    ul.appendChild(li);
  });
}
async function nextInPlaylist(){ if (player.index < player.ids.length - 1) await playIndex(player.index + 1); }
async function exitPlayer(){
  cancelProgressive();
  hidePlaylistPanel();
  try { if (document.fullscreenElement) await document.exitFullscreen(); } catch(_){}
  const wrap = $("playerFS"); const v = $("fsVideo"); const a = $("bgAudio");
  try { v.pause(); } catch(_){}
  try { a.pause(); } catch(_){}
  // 保留 audio 元素（不 display:none），只是暂停
  try { v.removeAttribute("src"); v.load(); } catch(_){}
  wrap.style.display = "none";
  $("playlistPanel").classList.add("hidden");
}

/* 框选 & 快捷键 */
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

/* 顶部控件绑定 */
$("sort").onchange = ()=> changeContext({sort_idx: parseInt($("sort").value,10)});
$("mature").onchange = ()=> changeContext({mature_only: $("mature").checked});
$("refresh").onclick = ()=> changeContext({});
let qTimer=null;
$("q").oninput = ()=>{ clearTimeout(qTimer); qTimer=setTimeout(()=> changeContext({q:$("q").value.trim()}), 250); };

/* 顶部“播放未完成” */
$("playUnwatched").onclick = handlePlayUnwatched;

/* 首次进入：读 hash 作为初始路径 */
window.addEventListener("load", ()=>{
  loadWatched();
  const initPath = pathFromHash();
  renderSkeleton(buildCrumbHtml(initPath));
  changeContext({path: initPath});
});