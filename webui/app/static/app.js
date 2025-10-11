/* app/static/app.js  (fs-14：无限滚动 + 预取下一页 + 不等待图片 + 自动补页 + 返回所在路径) */

/* ---- 全局状态 ---- */
let state = {
  path: "/",
  page: 1,                  // 下一次要加载的页码（从 1 开始）
  per_page: 45,
  sort_idx: 0,
  mature_only: false,
  q: "",
  selV: new Set(),
  selF: new Set(),
  lastIdx: null,
  tiles: [],
  dragging: false,
  dragStart: null,
  keepSelection: false,

  // 无限滚动控制
  isLoading: false,
  hasMore: true,
  queryKey: "",             // 用于丢弃过期请求
};

let player = {
  ids: [],
  titles: {},
  index: 0,
  idleTimer: null,
  returnPath: "/",          // ✅ 记录本次播放的来源路径
};

/* —— 预取状态（只预取“下一页”） —— */
let prefetchState = {
  key: "",
  page: 0,                  // 预取的是哪一页
  opts: null,               // 请求快照（path、sort_idx 等）
  data: null,               // 预取到的 JSON 数据
  controller: null,         // AbortController
  inflight: false,
};

const $ = (id) => document.getElementById(id);
const grid = () => $("grid");
const isTouch = ("ontouchstart" in window) || (navigator.maxTouchPoints > 0);

let io = null;              // IntersectionObserver
let rubberBound = false;    // 防重复绑定
let autoFillRunning = false; // 自动补页重入保护

/* 禁止拖拽 + （仅手机）屏蔽系统长按菜单 */
document.addEventListener("dragstart", e => e.preventDefault());
if (isTouch) window.addEventListener("contextmenu", e => e.preventDefault(), { passive:false });

/* 通用 */
function showNotice(msg){ const n=$("notice"); if(!n) return; n.style.display="block"; n.textContent="ℹ︎ "+msg; }
function clearNotice(){ const n=$("notice"); if(!n) return; n.style.display="none"; n.textContent=""; }
function fmtSize(sz){ if (sz>=1<<30) return (sz/(1<<30)).toFixed(1)+" GB"; if (sz>=1<<20) return (sz/(1<<20)).toFixed(1)+" MB"; if (sz>=1<<10) return (sz/(1<<10)).toFixed(1)+" KB"; return sz+" B"; }
function fmtDate(ts){ return new Date(ts*1000).toLocaleString(); }
function isSel(t){ return t.type==="video" ? state.selV.has(t.vid) : state.selF.has(t.path); }
function setSel(t,on){ if(t.type==="video"){on?state.selV.add(t.vid):state.selV.delete(t.vid);} else {on?state.selF.add(t.path):state.selF.delete(t.path);} t.el.classList.toggle("selected",on); }
function clearSel(){ state.tiles.forEach(t=>t.el.classList.remove("selected")); state.selV.clear(); state.selF.clear(); }

/* 骨架屏（首次进入/切换上下文时显示少量占位） */
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

/* 生成当前查询 key（用于丢弃过期响应 / 复用预取） */
function makeQueryKey(){
  return `${state.path}|${state.sort_idx}|${state.mature_only?'1':'0'}|${state.q}`;
}

/* 拍快照（用于请求 & 预取） */
function snapshotOpts(){
  return {
    path: state.path,
    sort_idx: state.sort_idx,
    mature_only: state.mature_only,
    q: state.q,
    per_page: state.per_page,
  };
}

/* REST 调用：scan（支持可选 signal） */
async function apiScan(opts, page, signal){
  const params = new URLSearchParams({
    path: opts.path,
    page,
    per_page: opts.per_page,
    sort_idx: opts.sort_idx,
    mature_only: opts.mature_only,
    q: opts.q
  });
  const res = await fetch(`/api/scan?${params.toString()}`, { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/* —— 预取工具 —— */
function resetPrefetch(){
  if (prefetchState.controller) try{ prefetchState.controller.abort(); }catch(_){}
  prefetchState = { key:"", page:0, opts:null, data:null, controller:null, inflight:false };
}

async function schedulePrefetch(){
  if (!state.hasMore) return;
  const key = makeQueryKey();
  const pageToPrefetch = state.page; // 此时 state.page 已指向“下一次要加载的页”
  if (prefetchState.inflight && prefetchState.key === key && prefetchState.page === pageToPrefetch) return;
  if (prefetchState.data && prefetchState.key === key && prefetchState.page === pageToPrefetch) return;

  resetPrefetch();

  prefetchState.key = key;
  prefetchState.page = pageToPrefetch;
  prefetchState.opts = snapshotOpts();
  prefetchState.controller = new AbortController();
  prefetchState.inflight = true;

  try {
    const data = await apiScan(prefetchState.opts, prefetchState.page, prefetchState.controller.signal);
    if (prefetchState.key === key && prefetchState.page === pageToPrefetch){
      prefetchState.data = data;
    }
  } catch(_err){
    prefetchState.data = null;
  } finally {
    prefetchState.inflight = false;
  }
}

/* —— 自动补页：数据追加后，如哨兵仍接近视口，连续再拉最多 maxLoops 页 —— */
async function autoFillViewport(maxLoops=3){
  if (autoFillRunning) return;
  autoFillRunning = true;
  try{
    let loops = 0;
    while (loops < maxLoops) {
      if (!state.hasMore || state.isLoading) break;
      const sent = $("sentinel"); if (!sent) break;
      const rect = sent.getBoundingClientRect();
      // 若哨兵距可视区底部 < 1000px，认为仍“接近底部”，继续拉下一页
      if (rect.top - window.innerHeight > 1000) break;
      // 触发下一页加载（注意：loadNextPage 内部会把 isLoading 设为 true/false）
      await loadNextPage();
      loops++;
    }
  } finally {
    autoFillRunning = false;
  }
}

/* —— 无限滚动：加载一页并“追加渲染” —— */
async function loadNextPage(){
  if (state.isLoading || !state.hasMore) return;
  state.isLoading = true;
  const keyAtStart = state.queryKey = makeQueryKey();

  setInfStatus("加载中…");

  const usePrefetch = (prefetchState.data &&
                       prefetchState.key === keyAtStart &&
                       prefetchState.page === state.page);

  try{
    let data;
    if (usePrefetch){
      // ✅ 直接使用预取数据，零等待
      data = prefetchState.data;
      prefetchState.data = null; // 用过即丢
    } else {
      // 常规拉取（不等待图片）
      const opts = snapshotOpts();
      data = await apiScan(opts, state.page, undefined);
      if (keyAtStart !== makeQueryKey()){ state.isLoading=false; return; }
    }

    // 面包屑（每页一致，更新一次无妨）
    const crumb = ["<a class='link' href='#/' data-path='/'>/</a>"].concat(
      data.breadcrumb.map((seg,i)=>{const p="/"+data.breadcrumb.slice(0,i+1).join("/"); return `<a class='link' href='#${p}' data-path='${p}'>${seg}</a>`;})
    ).join(" / ");
    $("crumb").innerHTML = "当前位置：" + crumb;
    $("crumb").querySelectorAll("a[data-path]").forEach(a=>{
      a.onclick = (ev)=>{ ev.preventDefault(); changeContext({path: a.getAttribute("data-path")}); };
    });

    // 首次页：清空骨架
    if (state.page === 1) { grid().innerHTML = ""; state.tiles = []; }

    appendTiles(data); // ✅ 仅根据数据立即渲染，占位方形容器先撑开高度；不等待图片 onload

    // 更新翻页状态
    state.hasMore = state.page < data.total_pages;
    state.page += 1;

    setInfStatus(state.hasMore ? "下拉加载更多…" : "已到底部");

    // 绑定一次事件委托 & 框选（不会重复）
    bindDelegatedEvents();
    bindRubber();

    // ✅ 立刻预取“下一页”，提升后续滚动速度
    schedulePrefetch();
  } catch(err){
    setInfStatus("加载失败，请重试");
  } finally{
    state.isLoading = false;
    // ✅ 页面没撑满时，自动补页（不等图片）
    queueMicrotask(()=> autoFillViewport(3));
  }
}

/* 将一页数据追加为 tiles（图片异步加载 + 占位不抖动） */
function appendTiles(data){
  let idx = state.tiles.length;

  data.folders.forEach(f=>{
    const path = (state.path.endsWith("/")? state.path : state.path + "/") + f.title;
    const el = document.createElement("div");
    el.className = "tile folder"; el.dataset.type="folder"; el.dataset.path=path; el.dataset.idx=idx;
    el.innerHTML = `
      <div class="thumb"><div class="big">📁</div></div>
      <div class="title">${f.title}</div>
      <div class="meta">(${f.count}) 项</div>
      <button class="tile-menu" title="菜单">⋮</button>
    `;
    grid().appendChild(el);
    state.tiles.push({el, type:"folder", path, idx, title:f.title}); idx++;
  });

  data.videos.forEach(v=>{
    const el = document.createElement("div");
    el.className = "tile"; el.dataset.type="video"; el.dataset.vid=v.id; el.dataset.idx=idx;
    // ✅ 不等待图片：使用 aspect-ratio 方形容器先占位；图片 lazy+async 解码
    el.innerHTML = `
      <div class="thumb">
        <img src="${v.preview_url}" alt="preview" draggable="false"
             loading="lazy" decoding="async" fetchpriority="low"/>
      </div>
      <div class="title">${v.title}</div>
      <div class="meta">${fmtDate(v.mtime)} · ${fmtSize(v.size)} · ${v.rating||"-"}</div>
      <button class="tile-menu" title="菜单">⋮</button>
    `;
    grid().appendChild(el);
    state.tiles.push({el, type:"video", vid:v.id, idx, title:v.title}); idx++;
  });
}

/* 状态条 */
function setInfStatus(text){ const el=$("infiniteStatus"); if(el) el.textContent = text || ""; }

/* 切换上下文（路径/筛选/排序/搜索变化）→ 重置并从第一页开始累积 */
function changeContext({path, sort_idx, mature_only, q}={}){
  if (path!==undefined) state.path = path;
  if (sort_idx!==undefined) state.sort_idx = sort_idx;
  if (mature_only!==undefined) state.mature_only = mature_only;
  if (q!==undefined) state.q = q;

  clearSel();
  state.page = 1;
  state.hasMore = true;
  state.isLoading = false;
  state.queryKey = makeQueryKey();

  // 取消旧预取，准备新预取
  resetPrefetch();

  // 骨架 + 状态条
  renderSkeleton(buildCrumbHtml(state.path));
  setInfStatus("加载中…");

  // 触底观察器（仅初始化一次）
  if (!io){
    const sentinel = $("sentinel");
    io = new IntersectionObserver((entries)=>{
      entries.forEach(e=>{
        if (e.isIntersecting) loadNextPage();
      });
    }, { root:null, rootMargin:"1000px 0px", threshold:0 }); // 提前 1000px 触发
    io.observe(sentinel);
  }

  // 拉取第一页
  loadNextPage();
}

/* 面包屑 helper */
function buildCrumbHtml(pathStr){
  const html = ["<a class='link' href=\"#/\" data-path=\"/\">/</a>"];
  const segs = pathStr.split("/").filter(Boolean);
  segs.forEach((seg,i)=>{
    const p = "/"+segs.slice(0,i+1).join("/");
    html.push(`<a class='link' href='#${p}' data-path='${p}'>${seg}</a>`);
  });
  return "当前位置：" + html.join(" / ");
}

/* —— 事件委托（点击/右键/三点菜单） —— */
function getTile(target){ const el = target.closest(".tile"); if(!el) return null; const idx = parseInt(el.dataset.idx,10); return state.tiles[idx] || null; }

function bindDelegatedEvents(){
  // 赋值到容器属性，不会重复累加
  grid().onclick = async (ev)=>{
    const menuBtn = ev.target.closest(".tile-menu");
    if (menuBtn) {
      const t = getTile(menuBtn); if (!t) return;
      clearSel(); setSel(t, true); state.lastIdx = t.idx;   // 强制单选
      const b = menuBtn.getBoundingClientRect();
      openContextMenu(b.left + b.width/2, b.top + b.height);
      ev.stopPropagation();
      return;
    }

    const t = getTile(ev.target); if (!t) return;

    if (ev.ctrlKey) { setSel(t, !isSel(t)); state.lastIdx=t.idx; ev.preventDefault(); return; }
    if (ev.shiftKey) {
      const start = state.lastIdx==null ? t.idx : state.lastIdx;
      const [a,b] = [start, t.idx].sort((x,y)=>x-y);
      if (!ev.ctrlKey) clearSel();
      for (let i=a;i<=b;i++) setSel(state.tiles[i], true);
      ev.preventDefault(); return;
    }

    t.el.classList.add("pulse"); setTimeout(()=> t.el.classList.remove("pulse"), 200);
    clearSel(); setSel(t,true); state.lastIdx=t.idx;

    if (t.type === "folder") {
      changeContext({path: t.path});
    } else {
      await startPlaylist([{id:t.vid, title:t.title}], 0, state.path);
    }
  };

  grid().oncontextmenu = (ev)=>{
    if (isTouch) return;
    const t = getTile(ev.target); if (!t) return;
    ev.preventDefault();
    if (!isSel(t)) { clearSel(); setSel(t,true); state.lastIdx=t.idx; }
    openContextMenu(ev.clientX, ev.clientY);
  };
}

/* 右键/⋮菜单 */
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
    add("播放此视频（全屏）", ()=> startPlaylist([{id:vid}], 0, state.path));
    add("打开创意工坊链接", ()=> window.open(`/go/workshop/${vid}`, "_blank"));
    sep();
    add("删除（不可恢复）", async ()=>{
      if (!confirm("确定要永久删除该条目吗？此操作不可恢复。")) return;
      await deleteByIds([vid]); clearSel(); changeContext({}); // 刷新当前列表
    });
  } else if (oneFolder) {
    const path = [...state.selF][0];
    add("打开此文件夹", ()=> changeContext({path}));
    add("播放此文件夹（全屏顺序播放）", async ()=>{
      const items = await getFolderItems(path);
      if (!items.length) return alert("该文件夹没有可播放视频");
      await startPlaylist(items, 0, path);
    });
  } else {
    add("批量播放（全屏顺序播放）", async ()=>{
      const items = await expandSelectionToItems();
      if (!items.length) return alert("所选没有可播放视频");
      await startPlaylist(items, 0, state.path);
    });
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
async function deleteByIds(ids){
  await fetch("/api/delete", { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({ids}) });
}

/* 扩展为 items（含 title） */
async function getFolderItems(path){
  const params = new URLSearchParams({ path, sort_idx: state.sort_idx, mature_only: state.mature_only, with_meta: "1" });
  const r = await fetch(`/api/folder_videos?${params.toString()}`); const j = await r.json();
  return (j.items || []).map(it => ({id: it.id, title: it.title || `视频 ${it.id}`}));
}
async function expandSelectionToItems(){
  const list = [];
  state.selV.forEach(id => list.push({id, title: (state.tiles.find(t=>t.vid===id)?.title) || `视频 ${id}`}));
  for (const p of state.selF) list.push(...await getFolderItems(p));
  const seen = new Set(); const out=[];
  for (const it of list) if(!seen.has(it.id)){ seen.add(it.id); out.push(it); }
  return out;
}

/* 全屏播放器逻辑（含“返回所在路径”） */
async function startPlaylist(items, startIndex=0, returnPath=null){
  player.ids = items.map(x=>x.id);
  player.titles = {}; items.forEach(x=> player.titles[x.id] = x.title || `视频 ${x.id}`);
  player.index = Math.max(0, Math.min(startIndex, player.ids.length-1));
  player.returnPath = returnPath || state.path;

  const wrap = $("playerFS"); const v = $("fsVideo");
  wrap.style.display = "flex";
  if (!v._bound) { v.addEventListener("ended", ()=> nextInPlaylist()); v._bound = true; }
  try {
    if (wrap.requestFullscreen) await wrap.requestFullscreen({ navigationUI: "hide" });
    else if (wrap.webkitRequestFullscreen) await wrap.webkitRequestFullscreen();
  } catch(_){}

  $("btnBack").onclick = async ()=>{
    await exitPlayer();
    if (state.path !== player.returnPath) changeContext({path: player.returnPath});
  };
  $("btnMenu").onclick = ()=> togglePlaylistPanel();

  wrap.addEventListener("mousemove", wakeOverlay);
  wrap.addEventListener("touchstart", wakeOverlay);
  wakeOverlay();

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
  const id = player.ids[i]; const v = $("fsVideo");
  v.src = `/media/video/${id}`;
  try { await v.play().catch(()=>{}); } catch(_){}
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
function togglePlaylistPanel(){ $("playlistPanel").classList.toggle("hidden"); }
async function nextInPlaylist(){ if (player.index < player.ids.length - 1) await playIndex(player.index + 1); }
async function exitPlayer(){
  const wrap = $("playerFS"); const v = $("fsVideo");
  try { if (document.fullscreenElement) await document.exitFullscreen(); } catch(_){}
  v.pause(); v.removeAttribute("src"); v.load();
  wrap.style.display = "none";
  $("playlistPanel").classList.add("hidden");
}

/* 框选 & 快捷键（仅绑定一次） */
function bindRubber(){
  if (rubberBound) return;
  rubberBound = true;

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
    if ((e.key==="a"||e.key==="A") && (e.ctrlKey||e.metaKey)) {
      e.preventDefault(); state.tiles.forEach(t=> setSel(t,true));
    }
  });
}

/* 顶部控件（变化 → 重置并无限滚动加载） */
$("sort").onchange = ()=> changeContext({sort_idx: parseInt($("sort").value,10)});
$("mature").onchange = ()=> changeContext({mature_only: $("mature").checked});
$("refresh").onclick = ()=> changeContext({});
let qTimer=null;
$("q").oninput = ()=>{ clearTimeout(qTimer); qTimer=setTimeout(()=> changeContext({q:$("q").value.trim()}), 250); };

/* 首次进入：骨架 + 无限滚动启动 */
window.addEventListener("load", ()=>{
  renderSkeleton(buildCrumbHtml(state.path));
  changeContext({});
});