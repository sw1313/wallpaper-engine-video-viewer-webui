/* app/static/app.js (fs-32+repair-2)
   - 修复：faststart 后统一通过 playIndex 重启当前条目，避免显示成上一集
   - 新增：playIndex(i,{cacheBust,resumeAt}) + setSrcAndLoad()
   - 保持：stalled/首帧超时触发修复、后台看门狗、UA/可见性处理等
*/
console.log("app.js version fs-32+repair-2");

/* ---- 全局状态 ---- */
let state = { path:"/", page:1, per_page:45, sort_idx:0, mature_only:false, q:"",
  selV:new Set(), selF:new Set(), lastIdx:null, tiles:[], dragging:false, dragStart:null, keepSelection:false,
  isLoading:false, hasMore:true, queryKey:"" };

let player = { ids:[], titles:{}, index:0, idleTimer:null, returnPath:"/" };

/* —— 预取状态 —— */
let prefetchState = { key:"", page:0, opts:null, data:null, controller:null, inflight:false };

/* —— 渐进播放 —— */
let progressive = { key:"", running:false, cancel:false, seen:new Set() };

/* —— 模态锁 —— */
let uiLock = { byPlaylist:false };

/* —— 事件守卫 —— */
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

/* ====== 服务端“已观看”缓存 & API ====== */
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
   Hash 路由
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

/* 预取下一页 */
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

/* 自动补页 */
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

/* 加载一页并渲染 */
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

/* 追加 tiles：返回新增视频 id 列表 */
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
  });

  return batchVideoIds;
}

/* 状态条 */
function setInfStatus(text){ const el=$("infiniteStatus"); if(el) el.textContent = text || ""; }

/* 切换上下文 */
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

/* ===============================
   播放解锁与“Muted Hack”
   =============================== */
async function playWithMutedHack(el, {force=false} = {}){
  try{
    if (!force) { await el.play(); return true; }
  }catch(_){ /* ignore */ }
  const prevMuted = el.muted;
  try{
    el.muted = true;
    const p = el.play(); if (p && typeof p.then==="function") await p;
    el.muted = prevMuted;
    if (typeof el.volume === "number" && el.volume === 0) el.volume = 1;
    if (el.muted !== prevMuted){
      const onPlaying = ()=>{ try{ el.muted = prevMuted; el.removeEventListener("playing", onPlaying); }catch(_){ } };
      el.addEventListener("playing", onPlaying, { once:true });
    }
    return true;
  }catch(_){
    try{ el.muted = prevMuted; }catch(_){}
    return false;
  }
}

/* —— 事件委托（含 watched 按钮） —— */
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
    else await startPlaylist([{id:t.vid, title:t.title}], 0, state.path);
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

/* 右键/⋮菜单 */
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

/* —— 递归列出某路径全部视频 —— */
async function getFolderItems(path){
  const params = new URLSearchParams({ path, sort_idx: state.sort_idx, mature_only: state.mature_only, with_meta: "1" });
  const r = await fetch(`/api/folder_videos?${params.toString()}`);
  const j = await r.json();
  return (j.items || []).map(it => ({id: String(it.id), title: it.title || `视频 ${it.id}`}));
}
async function expandSelectionToItems(){
  const list = [];
  state.selV.forEach(id => list.push({id: String(id), title: (state.tiles.find(t=>t.vid===id)?.title) || `视频 ${id}`}));
  for (const p of state.selF) list.push(...await getFolderItems(p));
  const seen = new Set(); const out=[];
  for (const it of list) if(!seen.has(String(it.id))){ seen.add(String(it.id)); out.push(it); }
  return out;
}

/* ===== 抽屉模态 / 播放清单 ===== */
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

/* ===== 渐进追加器 / 播放逻辑 ===== */
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
  cancelProgressive();
  const current = getCurrentlyLoadedVideoItems();
  await syncWatched(current.map(x=>x.id));
  const initial = current.filter(x => !isWatched(x.id)).slice(0, 30);
  if (initial.length){ await startPlaylist(initial, 0, state.path); progressive.seen = new Set(player.ids); }
  const exclude = new Set(initial.map(i=>String(i.id)));
  const all = await getFolderItems(state.path);
  await syncWatched(all.map(x=>x.id));
  const pending = all.filter(x => !isWatched(x.id) && !exclude.has(String(x.id)));
  if (!initial.length && !pending.length){ setInfStatus("当前路径下没有未完成的视频"); return; }
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
  cancelProgressive();
  setInfStatus("准备读取文件夹…");
  const all = await getFolderItems(path);
  await syncWatched(all.map(x=>x.id));
  if (!all.length){ alert("该文件夹没有可播放视频"); return; }
  const initial = all.filter(x=>!isWatched(x.id)).slice(0, Math.min(30, all.length));
  if (!initial.length){ alert("该文件夹没有未完成的视频"); return; }
  await startPlaylist(initial, 0, path);
  progressive.seen = new Set(player.ids);
  const rest = all.filter(x => !isWatched(x.id) && !progressive.seen.has(x.id));
  const BATCH = 200;
  const producer = async function* (){ for (const part of chunk(rest, BATCH)) yield part; };
  progressiveAppendFrom(producer, "文件夹后台加载");
}
async function progressivePlaySelection(){
  cancelProgressive();
  const selVideos = [...state.selV].map(String), selFolders = [...state.selF];
  let initial = selVideos.map(id => ({ id, title: (state.tiles.find(t=>String(t.vid)===id)?.title) || `视频 ${id}` }));
  await syncWatched(initial.map(x=>x.id));
  if (!initial.length && selFolders.length){
    const firstFolderItems = await getFolderItems(selFolders[0]);
    await syncWatched(firstFolderItems.map(x=>x.id));
    if (!firstFolderItems.length){ alert("所选文件夹没有可播放视频"); return; }
    initial = firstFolderItems.filter(x=>!isWatched(x.id)).slice(0, Math.min(30, firstFolderItems.length));
  }
  if (!initial.length){ alert("所选没有未完成的视频"); return; }
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
function getCurrentlyLoadedVideoItems(){
  const out = []; for (const t of state.tiles){ if (t.type === "video") out.push({ id:String(t.vid), title:t.title || `视频 ${t.vid}` }); }
  return out;
}

/* =========================
   播放器（全屏 & 后台音频）
   ========================= */
let fsOverlayInHistory = false;
let playbackMode = "video";
const media = { v:null, a:null };
function isPlayerActive(){ return $("playerFS").style.display !== "none"; }

/* === 预防 bgAudio 首次抢跑 === */
(function disableBgAutoplayEarly(){
  const a = $("bgAudio");
  if (a){
    try{ a.autoplay = false; a.removeAttribute && a.removeAttribute("autoplay"); }catch(_){}
    try{ a.pause(); }catch(_){}
  }
})();

/* ---- 用户手势解锁 ---- */
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

/* 返回键仅退出全屏 */
function installPopStateGuard(){
  window.addEventListener("popstate", () => {
    if (isPlayerActive()){
      fsOverlayInHistory = false;
      exitPlayer();
    }
  });
}
installPopStateGuard();

/* 播放封装 */
async function safePlay(el){ try { await el.play(); return true; } catch { return false; } }

/* ====== 后台“看门狗” ====== */
const bgAdvanceGuard = { timer:null };
function startBgAdvanceGuard(){
  if (bgAdvanceGuard.timer) return;
  const a = media.a || $("bgAudio");
  if (!a) return;
  bgAdvanceGuard.timer = setInterval(()=>{
    if (!isPlayerActive() || playbackMode !== "audio") return;
    if (!a.duration || a.paused || !isFinite(a.duration)) return;
    const remain = a.duration - a.currentTime;
    if (remain <= 2) advanceToNextOnce();
  }, 1000);
}
function stopBgAdvanceGuard(){
  if (bgAdvanceGuard.timer){ clearInterval(bgAdvanceGuard.timer); bgAdvanceGuard.timer = null; }
}

/* —— 切换前后台 —— */
async function switchToAudio(){
  if (!isPlayerActive() || playbackMode === "audio") return;
  const v = media.v || $("fsVideo");
  const a = media.a || $("bgAudio");
  media.v = v; media.a = a;
  const src = v.src || `/media/video/${player.ids[player.index]}`;
  if (a.src !== src) { a.src = src; try{ a.load(); }catch(_){ } }
  try { if (!isNaN(v.currentTime)) a.currentTime = v.currentTime; } catch(_){}
  const ok = await playWithMutedHack(a, {force: document.visibilityState === "hidden"});
  if (ok){
    try{ v.pause(); }catch(_){}
    playbackMode = "audio"; updateMediaSessionPlaybackState();
    startBgAdvanceGuard();
  } else { showNotice("后台播放被阻止，点一下屏幕以继续"); installUserGestureUnlock(); }
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
    playbackMode = "video"; updateMediaSessionPlaybackState();
    stopBgAdvanceGuard();
  } else { showNotice("恢复前台播放被阻止，点一下屏幕"); installUserGestureUnlock(); }
}

/* === 仅第一次隐藏静音 video 去重 === */
let firstHiddenHandled = false;
let videoMutedByFirstHiddenFix = false;

/* 可见性监听 */
document.addEventListener("visibilitychange", async ()=>{
  if (!isPlayerActive()) return;

  if (document.visibilityState === "hidden") {
    const a0 = $("bgAudio"); if (a0){ try{ a0.autoplay=false; a0.removeAttribute && a0.removeAttribute("autoplay"); }catch(_){ } }

    await switchToAudio();
    const ok = await playWithMutedHack(media.a||$("bgAudio"), {force:true});
    if (!ok){ showNotice("后台播放被阻止，需要点击以继续"); installUserGestureUnlock(); }
    startBgAdvanceGuard();

    if (!firstHiddenHandled){
      const v = media.v || $("fsVideo");
      const a = media.a || $("bgAudio");
      if (a && v && !a.paused && !v.paused){
        try{ v.muted = true; videoMutedByFirstHiddenFix = true; }catch(_){}
      }
      firstHiddenHandled = true;
    }

  } else {
    try{ const a=$("bgAudio"); a.autoplay=false; a.pause(); }catch(_){}
    await switchToVideo();
    const ok = await safePlay(media.v||$("fsVideo"));
    if (!ok){ showNotice("恢复前台播放被阻止，点击屏幕继续"); installUserGestureUnlock(); }
    stopBgAdvanceGuard();

    if (videoMutedByFirstHiddenFix){
      const v = media.v || $("fsVideo");
      try{ v.muted = false; }catch(_){}
      videoMutedByFirstHiddenFix = false;
    }
  }
});
window.addEventListener("pagehide", ()=> { if (isPlayerActive()) switchToAudio(); });
document.addEventListener("freeze",   ()=> { if (isPlayerActive()) switchToAudio(); });

/* —— “结束→下一集”更稳的处理 —— */
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
    if (remain <= 2) advanceToNextOnce();
  };
  a.addEventListener("timeupdate", check);
  a.addEventListener("progress",   check);
}

/* Media Session 元数据 */
function setMediaSessionMeta(id){
  if (!("mediaSession" in navigator)) return;
  const title = player.titles[id] || `视频 ${id}`;
  const origin = location.origin;
  const artwork = [
    { src: `${origin}/media/preview/${id}?s=512`, sizes:"512x512", type:"image/png" },
    { src: `${origin}/media/preview/${id}?s=128`, sizes:"128x128", type:"image/png" },
  ];
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title, artist:"Wallpaper Engine", album: state.path, artwork
    });
  } catch(_){}
  if (!setMediaSessionMeta._installed){
    const getActive = ()=> (playbackMode==="video" ? (media.v||$("fsVideo")) : (media.a||$("bgAudio")));
    navigator.mediaSession.setActionHandler("play", async ()=>{ const el=getActive(); await playWithMutedHack(el); });
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
  const el = (playbackMode==="video" ? (media.v||$("fsVideo")) : (media.a||$("bgAudio")));
  try { navigator.mediaSession.playbackState = el.paused ? "paused" : "playing"; } catch(_){}
}

/* =========================================================
   🔧 stalled/首帧超时 → 自动修复（最多一次）
   ========================================================= */
const stallRepair = {
  inFlight: false,
  tried: new Set(),
  timer: null,
  detach: null,
};
function installStallListeners(v, a){
  if (!v._stallBound){
    const vh = async ()=> await maybeRepairFromEl('video', v);
    v.addEventListener('stalled', vh);
    v.addEventListener('waiting', vh);
    v.addEventListener('error',   vh);
    v._stallBound = true;
  }
  if (!a._stallBound){
    const ah = async ()=> await maybeRepairFromEl('audio', a);
    a.addEventListener('stalled', ah);
    a.addEventListener('waiting', ah);
    a.addEventListener('error',   ah);
    a._stallBound = true;
  }
}
async function maybeRepairFromEl(which, el){
  if (!isPlayerActive()) return;
  const id = player.ids[player.index];
  if (!id || stallRepair.inFlight || stallRepair.tried.has(String(id))) return;
  const early = (el.currentTime || 0) < 1.0;
  const starving = (el.readyState || 0) < 3;
  if (!(early || starving)) return;
  await triggerRepair(id, el.currentTime || 0);
}
function armFirstPlayWatch(id, el){
  disarmFirstPlayWatch();
  let started = false;
  const onPlaying = ()=>{ started = true; disarmFirstPlayWatch(); };
  const onProgress = ()=>{ if ((el.currentTime||0) >= 0.25){ started = true; disarmFirstPlayWatch(); } };
  el.addEventListener('playing', onPlaying, {once:true});
  el.addEventListener('timeupdate', onProgress);
  stallRepair.detach = ()=>{
    try{ el.removeEventListener('timeupdate', onProgress); }catch(_){}
  };
  stallRepair.timer = setTimeout(()=>{
    if (!started && !stallRepair.tried.has(String(id))) triggerRepair(id, el.currentTime||0);
  }, 3500);
}
function disarmFirstPlayWatch(){
  if (stallRepair.timer){ clearTimeout(stallRepair.timer); stallRepair.timer=null; }
  if (stallRepair.detach){ try{ stallRepair.detach(); }catch(_){ } stallRepair.detach=null;
  }
}
async function triggerRepair(id, resumeAt){
  stallRepair.inFlight = true;
  stallRepair.tried.add(String(id));
  showNotice("正在修复该视频（无损重封装）…");
  try{
    const r = await fetch(`/api/faststart/${id}`, { method:"POST" });
    if (r && r.ok){
      await playIndex(player.index, { cacheBust:true, resumeAt: resumeAt||0 }); // ★ 关键：统一走 playIndex
      showNotice("已修复，正在重新播放…");
      setTimeout(clearNotice, 1200);
    } else {
      showNotice("修复失败：无法完成 faststart");
      setTimeout(clearNotice, 2000);
    }
  }catch(_){
    showNotice("修复失败：网络或权限问题");
    setTimeout(clearNotice, 2000);
  }finally{
    stallRepair.inFlight = false;
  }
}

/* ===== 工具：设置媒体源并在 loadedmetadata 后续播 ===== */
async function setSrcAndLoad(v, a, src, resumeAt=0){
  try{ v.src = src; v.load(); }catch(_){}
  try{ a.src = src; a.load(); }catch(_){}
  if (resumeAt > 0){
    const set = (el)=>{ try{ el.currentTime = resumeAt; }catch(_){} };
    const waitV = new Promise(res=>{
      const h = ()=>{ v.removeEventListener('loadedmetadata', h); set(v); res(); };
      v.addEventListener('loadedmetadata', h, {once:true});
      setTimeout(()=>{ try{ v.removeEventListener('loadedmetadata', h);}catch(_){}; set(v); res(); }, 500);
    });
    const waitA = new Promise(res=>{
      const h = ()=>{ a.removeEventListener('loadedmetadata', h); set(a); res(); };
      a.addEventListener('loadedmetadata', h, {once:true});
      setTimeout(()=>{ try{ a.removeEventListener('loadedmetadata', h);}catch(_){}; set(a); res(); }, 500);
    });
    await Promise.all([waitV, waitA]);
  }
}

/* ===== 全屏播放器 ===== */
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
    v.addEventListener("ended", ()=> handleEndedFromAny(v));
    a.addEventListener("ended", ()=> handleEndedFromAny(a));
    installAudioNearEndDetector(a);
    installStallListeners(v, a); // 绑定 stalled 修复监听
    v._bound = a._bound = true;
  }

  try{ a.autoplay = false; a.pause(); }catch(_){}

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

  const wakeOverlay = ()=>{
    const wrap = $("playerFS");
    wrap.classList.remove("idle");
    if (player.idleTimer) clearTimeout(player.idleTimer);
    player.idleTimer = setTimeout(()=> wrap.classList.add("idle"), 1500);
  };
  wrap.addEventListener("mousemove", wakeOverlay);
  wrap.addEventListener("touchstart", wakeOverlay);
  wakeOverlay();

  unlockPlaybackOnUserGesture();

  await playIndex(player.index);
}

async function playIndex(i, {cacheBust=false, resumeAt=0} = {}){
  player.index = i;
  lastAdvanceId = null;
  disarmFirstPlayWatch();

  const id = player.ids[i];
  const v = media.v || $("fsVideo");
  const a = media.a || $("bgAudio");

  const bust = cacheBust ? `?v=${Date.now()}` : "";
  const src = `/media/video/${id}${bust}`;
  await setSrcAndLoad(v, a, src, resumeAt);

  setMediaSessionMeta(id);

  if (document.visibilityState === "hidden") {
    playbackMode = "audio";
    try{ v.pause(); }catch(_){}
    const ok = await playWithMutedHack(a, {force:true});
    if (!ok){ showNotice("播放被阻止：请点击屏幕以继续播放。"); installUserGestureUnlock(); }
    startBgAdvanceGuard();
    armFirstPlayWatch(id, a);
  } else {
    playbackMode = "video";
    try{ a.autoplay=false; a.pause(); }catch(_){}
    const ok = await safePlay(v);
    if (!ok){ showNotice("播放被阻止：请点击屏幕以继续播放。"); installUserGestureUnlock(); }
    stopBgAdvanceGuard();
    armFirstPlayWatch(id, v);
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
  disarmFirstPlayWatch();
  try { if (document.fullscreenElement) await document.exitFullscreen(); } catch(_){}
  const wrap = $("playerFS"); const v = $("fsVideo"); const a = $("bgAudio");
  try { v.pause(); } catch(_){}
  try { a.pause(); } catch(_){}
  try { v.removeAttribute("src"); v.load(); } catch(_){}
  wrap.style.display = "none";
  $("playlistPanel").classList.add("hidden");
  stopBgAdvanceGuard();
  if (videoMutedByFirstHiddenFix){
    try{ v.muted = false; }catch(_){}
    videoMutedByFirstHiddenFix = false;
  }
}

/* 框选 & 快捷键 */
let rubberBound=false;
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

/* 首次进入 */
window.addEventListener("load", ()=>{
  const initPath = pathFromHash();
  renderSkeleton(buildCrumbHtml(initPath));
  changeContext({path: initPath});
});