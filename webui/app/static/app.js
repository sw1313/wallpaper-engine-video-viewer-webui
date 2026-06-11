/* app/static/app.js (fs-42d-stall-hb-wallclock-projection+end-guard+gate-FULL+hotfix-2025-11-01b) */
console.log("app.js version fs-117-float-gpu-warm-2026-06-11");

/* ===================== 公共状态与工具 ===================== */

let state = { path:"/", page:1, per_page:45, sort_idx:0, mature_only:false, q:"",
  selV:new Set(), selF:new Set(), lastIdx:null, tiles:[], dragging:false, dragStart:null, keepSelection:false,
  isLoading:false, hasMore:true, queryKey:"" };

let player = { ids:[], titles:{}, index:0, idleTimer:null, returnPath:"/", loop:false, returnScrollY:0 };

const SHIFT_RANGE_GRACE_MS = 300;
let shiftKeyDown = false;
let lastShiftReleasedAt = 0;

let media = { v: null, a: null };
let playbackMode = "video";
let fsOverlayInHistory = false;
window.addEventListener("error", (ev)=>{
  const msg = String(ev?.message || ev?.error?.message || "");
  if (msg.includes("responseText") && msg.includes("arraybuffer")){
    console.warn("[hls] ignored XHR responseText/arraybuffer compatibility error", ev.error || msg);
    try{ ev.preventDefault(); }catch(_){}
  }
}, true);
const URL_PARAMS = new URLSearchParams(window.location.search || "");
const POPOUT_PATH_MATCH = (typeof window !== "undefined" && window.location.pathname || "").match(/^\/watch\/([^/?#]+)/);
const POPOUT_VID = POPOUT_PATH_MATCH ? decodeURIComponent(POPOUT_PATH_MATCH[1]) : "";
const POPOUT_MODE = !!POPOUT_VID;
const POPOUT_EMBED = POPOUT_MODE && URL_PARAMS.get("embed") === "1";
const WALLPAPER_MODE_VALUE = URL_PARAMS.get("wallpaper") || "";
const WALLPAPER_MODE = !POPOUT_MODE && ["1", "2"].includes(WALLPAPER_MODE_VALUE);
const WALLPAPER_MUTE_AWAY = WALLPAPER_MODE_VALUE === "1";
const WALLPAPER_PAUSE_AWAY = WALLPAPER_MODE_VALUE === "2";
let wallpaperDesktopVisible = !(WALLPAPER_MUTE_AWAY || WALLPAPER_PAUSE_AWAY) || document.visibilityState === "visible";
let wallpaperAutoPaused = false;
let wallpaperApplyingVisibility = false;
function shouldPersistPlaybackState(){ return !WALLPAPER_MODE; }

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

const RANDOM_PLAY_HISTORY_KEY = "wallpaperWebUI.randomPlayHistory.v1";
const RANDOM_PLAY_HISTORY_LIMIT = 300;
function loadRandomPlayHistory(){
  try{
    const arr = JSON.parse(localStorage.getItem(RANDOM_PLAY_HISTORY_KEY) || "[]");
    return Array.isArray(arr) ? arr.map(String).filter(Boolean) : [];
  }catch(_){ return []; }
}
function saveRandomPlayHistory(ids){
  try{
    const uniq = [];
    const seen = new Set();
    for (const id of (ids || []).map(String).filter(Boolean)){
      if (seen.has(id)) continue;
      seen.add(id); uniq.push(id);
      if (uniq.length >= RANDOM_PLAY_HISTORY_LIMIT) break;
    }
    localStorage.setItem(RANDOM_PLAY_HISTORY_KEY, JSON.stringify(uniq));
  }catch(_){}
}
function rememberRandomPlayed(id){
  if (!id) return;
  saveRandomPlayHistory([String(id)].concat(loadRandomPlayHistory()));
}
function weightedRandomOrder(items){
  const history = loadRandomPlayHistory();
  const recentRank = new Map();
  history.forEach((id, idx)=>{ if (!recentRank.has(id)) recentRank.set(id, idx); });
  const normalized = [];
  const seen = new Set();
  for (const it of (items || [])){
    const id = String(it.id || "");
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const rank = recentRank.get(id);
    // 伪随机：近期播放过的权重更低，但不是完全排除，避免小列表无法随机。
    const penalty = rank === undefined ? 1 : Math.max(0.08, Math.min(0.7, (rank + 1) / 80));
    const score = Math.random() * penalty;
    normalized.push({ item:{...it, id}, score });
  }
  normalized.sort((a,b)=>b.score-a.score);
  return normalized.map(x=>x.item);
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
const BACKGROUND_AUDIO_MODE = IS_MOBILE_UA;

/* ★ 新增：依据 UA 为 <html> 切换 is-desktop（仅桌面 UA 显示返回按钮） */
try { document.documentElement.classList.toggle("is-desktop", !IS_MOBILE_UA); } catch(_){}
try {
  document.documentElement.classList.toggle("wallpaper-mode", WALLPAPER_MODE);
  document.documentElement.classList.toggle("popout-mode", POPOUT_MODE);
} catch(_){}

const watchFloatState = { panels: new Map(), zCounter: 4000, audioFocus: null, pendingRestoreTimers: [], prioritySeq: 0 };
const FLOAT_PLAYER_MSE_BYTES = 56 * 1024 * 1024;
const FLOAT_MSE_BUDGET_FLOOR_BYTES = 10 * 1024 * 1024;
const FLOAT_MAX_RESTORE_PLAY = 6;
// 与双 GPU 转码槽位对齐；启动后从 /api/hls/capacity 动态刷新
const FLOAT_MAX_CONCURRENT_HLS = 8;
let _floatConcurrentHlsMax = FLOAT_MAX_CONCURRENT_HLS;
let _floatActiveHlsCount = 0;
const _floatHlsSlotWaiters = [];

async function _acquireFloatHlsSlot(){
  const maxN = Math.max(1, _floatConcurrentHlsMax || FLOAT_MAX_CONCURRENT_HLS);
  while (_floatActiveHlsCount >= maxN){
    await new Promise(resolve => _floatHlsSlotWaiters.push(resolve));
  }
  _floatActiveHlsCount += 1;
}

function _releaseFloatHlsSlot(v){
  if (v?._floatHlsSlotHeld){
    v._floatHlsSlotHeld = false;
  } else {
    return;
  }
  _floatActiveHlsCount = Math.max(0, _floatActiveHlsCount - 1);
  const w = _floatHlsSlotWaiters.shift();
  if (w) w();
}

function _cancelFloatHlsSlotAcquire(){
  _floatActiveHlsCount = Math.max(0, _floatActiveHlsCount - 1);
  const w = _floatHlsSlotWaiters.shift();
  if (w) w();
}

// 冷启动并发闸：同时只让少数浮窗触发后端 ffmpeg 冷启（NAS 磁盘 seek + GPU init 很重），
// 其余按优先级（打开/聚焦顺序）排队；某窗解出首帧或失败即释放，下一个补位。
const FLOAT_WARMUP_MAX = 4;
let _floatWarmupActive = 0;
const _floatWarmupWaiters = [];

function _pumpFloatWarmup(){
  while (_floatWarmupActive < Math.max(1, FLOAT_WARMUP_MAX) && _floatWarmupWaiters.length){
    _floatWarmupWaiters.sort((a, b)=> (Number(b.panel?._floatPriority) || 0) - (Number(a.panel?._floatPriority) || 0));
    const w = _floatWarmupWaiters.shift();
    _floatWarmupActive += 1;
    try { w.resolve(); } catch(_){}
  }
}

function _acquireFloatWarmupSlot(panel, video){
  if (video) video._floatWarmupHeld = true;
  return new Promise(resolve=>{
    _floatWarmupWaiters.push({ panel, video, resolve });
    _pumpFloatWarmup();
  });
}

function _releaseFloatWarmupSlot(video){
  if (!video) return;
  // 还在排队没拿到槽位 → 从等待队列剔除
  const qi = _floatWarmupWaiters.findIndex(w=> w.video === video);
  if (qi >= 0){
    _floatWarmupWaiters.splice(qi, 1);
    video._floatWarmupHeld = false;
    return;
  }
  if (!video._floatWarmupHeld) return;
  video._floatWarmupHeld = false;
  _floatWarmupActive = Math.max(0, _floatWarmupActive - 1);
  _pumpFloatWarmup();
}
// 浮动预览不读写 /api/progress，避免多窗/全屏播放互相覆盖断点；HLS preview playhead 仍上报给后端。
const FLOAT_PERSIST_PROGRESS = false;
const FLOAT_SEEK_GRACE_MS = 22000;

function _floatPanelActive(panel, video){
  return !!panel?._floatAlive && !!video && !video._floatClosed && document.body.contains(video);
}

function _invalidateFloatVideoLoad(video){
  if (!video) return;
  video._floatLoadToken = (video._floatLoadToken || 0) + 1;
}

function _destroyFloatVideo(video){
  if (!video || video._floatDestroyed) return;
  video._floatDestroyed = true;
  video._floatClosed = true;
  video._floatUserPaused = true;
  _releaseFloatHlsSlot(video);
  _releaseFloatWarmupSlot(video);
  _invalidateFloatVideoLoad(video);
  try { video.pause(); } catch(_){}
  try { video.muted = true; video.volume = 0; } catch(_){}
  try { video.srcObject = null; } catch(_){}
  try { video.removeAttribute("src"); } catch(_){}
  teardownMSE(video);
  try { video.load(); } catch(_){}
}

function _cancelAllFloatRestoreTimers(){
  (watchFloatState.pendingRestoreTimers || []).forEach(tid=> clearTimeout(tid));
  watchFloatState.pendingRestoreTimers = [];
}

function _floatVideoMayPlay(v, panel){
  return _floatPanelActive(panel, v) && !v._floatUserPaused;
}

function _floatPlayerCount(){
  try { return watchFloatState.panels.size; } catch(_){ return 0; }
}

function _floatPlaybackBudgetBytes(){
  const n = Math.max(1, _floatPlayerCount());
  return Math.max(FLOAT_MSE_BUDGET_FLOOR_BYTES, Math.floor(FLOAT_PLAYER_MSE_BYTES / Math.sqrt(n)));
}

function _floatInSeekGrace(v){
  if (!v) return false;
  if (v._floatSeekDragging) return true;
  if (v._floatUserSeekPending) return true;
  try { if (v.seeking) return true; } catch(_){}
  return Number(v?._floatUserSeekUntil || 0) > Date.now();
}

function _floatClearUserSeekIfPlaying(v, prevT, ct){
  if (!v?._floatUserSeekPending || v.seeking) return;
  const target = Number(v._floatUserSeekTarget);
  if (!Number.isFinite(target)) return;
  const prev = Number(prevT) || 0;
  if (Math.abs(prev - target) <= 0.6 && ct > target + 0.04 && ct > prev + 0.04){
    v._floatUserSeekPending = false;
    v._floatUserSeekTarget = NaN;
  }
}

function _floatSeekResumeAt(v){
  if (!v) return 0;
  if ((v._floatUserSeekPending || _floatInSeekGrace(v)) && Number.isFinite(v._floatUserSeekTarget)){
    return Math.max(0, Number(v._floatUserSeekTarget) || 0);
  }
  return Math.max(0, Number(v.currentTime) || 0);
}

function _floatMarkUserSeek(v, targetTime, extendMs){
  if (!v) return;
  v._floatUserSeekTarget = Math.max(0, Number(targetTime) || 0);
  v._floatUserSeekPending = true;
  v._floatUserSeekUntil = Date.now() + (Number(extendMs) || FLOAT_SEEK_GRACE_MS);
  v._floatPlaybackStuck = false;
  v._floatLastMoveAt = Date.now();
}

function _floatHlsStartLoadAt(v, t){
  const hls = v?._hls;
  if (!hls) return;
  try { hls.startLoad(Math.max(0, Number(t) || 0)); } catch(_){}
}

function _floatReassertSeekIfSpurious(v){
  if (!_floatInSeekGrace(v)) return false;
  const target = Number(v._floatUserSeekTarget);
  if (!Number.isFinite(target) || target < 2) return false;
  const ct = Number(v.currentTime) || 0;
  if (ct >= 1 || Math.abs(ct - target) <= 1.5) return false;
  console.info("[float-watch] reassert seek:", ct.toFixed(2), "->", target.toFixed(2));
  try { v.currentTime = target; } catch(_){}
  _floatHlsStartLoadAt(v, target);
  return true;
}

function _floatNudgePlayback(v, reason){
  if (!v || v._floatClosed || !document.body.contains(v)) return false;
  const ct = Math.max(0, Number(v.currentTime) || 0);
  const hls = v._hls;
  if (hls){
    try { hls.startLoad(ct); } catch(_){}
  }
  v._floatPlaybackStuck = false;
  v._floatLastMoveAt = Date.now();
  if (!v._floatUserPaused && !v._floatClosed){
    try { v.play().catch(()=>{}); } catch(_){}
  }
  if (reason) console.info("[float-watch] nudge playback:", reason, ct.toFixed(2));
  return true;
}

function _applyFloatHlsBudget(v){
  const hls = v?._hls;
  if (!hls) return;
  const budget = _floatPlaybackBudgetBytes();
  const cfg = _hlsJsConfigFromBudget(budget, Number(v._hlsBitrateBps || 0), _playbackIsMobile());
  cfg.maxBufferLength = Math.max(18, Math.min(cfg.maxBufferLength || 50, 55));
  cfg.maxMaxBufferLength = cfg.maxBufferLength;
  cfg.mseBudgetBytes = budget;
  hls.config.maxBufferSize = cfg.maxBufferSize;
  hls.config.maxBufferLength = cfg.maxBufferLength;
  hls.config.maxMaxBufferLength = cfg.maxMaxBufferLength;
  hls.config.backBufferLength = cfg.backBufferLength;
  hls.config.startFragPrefetch = cfg.startFragPrefetch;
}

function reconcileFloatHlsBudgets(){
  reconcileFloatLoadPriority();
}

function _floatPanelsByPriority(){
  const out = [];
  watchFloatState.panels.forEach((panel, vid)=>{
    out.push({ panel, vid: String(vid), pri: Number(panel._floatPriority) || 0 });
  });
  out.sort((a, b)=> b.pri - a.pri);
  return out;
}

function bumpFloatPanelPriority(panel, vid){
  if (!panel) return;
  watchFloatState.prioritySeq = (watchFloatState.prioritySeq || 0) + 1;
  panel._floatPriority = watchFloatState.prioritySeq;
  apiHlsPriority(vid, panel._floatPriority);
  reconcileFloatLoadPriority();
}

function focusWatchFloatPanel(panel){
  if (!panel) return;
  bumpWatchFloatPanel(panel);
  const vid = panel.dataset?.vid;
  if (vid) bumpFloatPanelPriority(panel, vid);
}

function _floatHasDecoded(v){
  if (!v) return false;
  const ct = Number(v.currentTime) || 0;
  if (ct > 0.02) return true;
  if (v.readyState >= 2) return true;
  try{
    const buf = bufferedEndForPosition(v, ct);
    if (buf > ct + 0.2) return true;
  }catch(_){}
  return false;
}

function _floatHardRetryAttach(panel, video, id, reason){
  if (!panel || !video || video._floatDirectPlay || video._floatClosed) return;
  if (_floatInSeekGrace(video)) return;
  const now = Date.now();
  if (video._floatHardRetryAt && now - video._floatHardRetryAt < 10000) return;
  video._floatHardRetryAt = now;
  console.warn("[float-watch] hard retry:", reason, id);
  bumpFloatPanelPriority(panel, id);
  apiHlsResume(id, "preview");
  if (video._hls){
    const resumeAt = _floatSeekResumeAt(video);
    try { video._hls.startLoad(resumeAt); } catch(_){}
    try { video._hls.recoverMediaError(); } catch(_){}
  }
  if (!video._floatUserPaused) video.play().catch(()=>{});
}

async function _floatPrewarmPreviewHls(id){
  const vid = String(id || "").trim();
  if (!vid) return;
  apiHlsResume(vid, "preview");
  const pl = _hlsPlaylistUrl(mediaVideoSrcOf(vid), "preview");
  try{
    await fetch(pl, { cache: "no-store", credentials: "same-origin" });
  }catch(_){}
}

async function _floatRetryHlsWarmup(panel, video, id){
  if (!panel || !video || video._floatClosed || video._floatDirectPlay) return false;
  console.warn("[float-watch] hls warmup retry:", id);
  bumpFloatPanelPriority(panel, id);
  await _floatPrewarmPreviewHls(id);
  _floatHardRetryAttach(panel, video, id, "warmup-hls-retry");
  return true;
}

function _floatResumeHlsLoad(v, vid, reason){
  if (!v?._hls || v._floatDirectPlay || v._floatClosed) return false;
  apiHlsResume(vid, "preview");
  try { v._hls.startLoad(Number(v.currentTime) || 0); } catch(_){}
  if (!v._floatUserPaused) v.play().catch(()=>{});
  if (reason) console.info("[float-watch] resume hls:", reason, vid);
  return true;
}

function reconcileFloatLoadPriority(){
  const ranked = _floatPanelsByPriority();
  const maxN = Math.max(1, _floatConcurrentHlsMax || FLOAT_MAX_CONCURRENT_HLS);
  const hlsAttached = ranked.filter(({ panel })=>{
    const v = panel.querySelector("video.watch-float-video");
    return v && v._hls && !v._floatDirectPlay;
  });
  const activeHls = new Set(hlsAttached.slice(0, maxN).map(x=> x.vid));

  ranked.forEach(({ panel, vid })=>{
    const v = panel.querySelector("video.watch-float-video");
    if (!v) return;
    if (panel._floatAttachPending && typeof panel._floatRunAttach === "function"){
      panel._floatRunAttach();
    }
    if (v._floatDirectPlay || !v._hls) return;
    if (!activeHls.has(vid)){
      if (!_floatHasDecoded(v)) return;
      try { v._hls.stopLoad(); } catch(_){}
      v._floatLoadDeferred = true;
      return;
    }
    if (v._floatLoadDeferred || !_floatHasDecoded(v)){
      v._floatLoadDeferred = false;
      _floatResumeHlsLoad(v, vid, v._floatLoadDeferred ? "promoted" : null);
    }
  });

  forEachFloatVideo((v)=> _applyFloatHlsBudget(v));
}

function forEachFloatVideo(fn){
  watchFloatState.panels.forEach((panel, vid)=>{
    const v = panel.querySelector("video.watch-float-video");
    if (v) fn(v, String(vid), panel);
  });
}

function snapshotFloatPlayback(){
  const snap = new Map();
  forEachFloatVideo((v, vid)=>{
    snap.set(vid, {
      playing: !v.paused && !v.ended,
      muted: !!v.muted,
      userMuted: !!v._floatUserMuted,
    });
  });
  return snap;
}

async function restoreFloatPlayback(snap, exceptVid){
  if (!snap || !snap.size) return;
  const jobs = [];
  let restored = 0;
  snap.forEach((st, vid)=>{
    if (restored >= FLOAT_MAX_RESTORE_PLAY) return;
    if (String(vid) === String(exceptVid) || !st.playing) return;
    const panel = watchFloatState.panels.get(vid);
    const v = panel?.querySelector("video.watch-float-video");
    if (!_floatVideoMayPlay(v, panel)) return;
    // Chrome 同时只允许一个有声 video；其余静音后可并行播放
    v.muted = true;
    v._floatUserMuted = st.userMuted;
    restored += 1;
    jobs.push(v.play().catch(()=>{}));
  });
  if (jobs.length) await Promise.all(jobs);
}

function scheduleFloatPlaybackRestore(snap, exceptVid){
  if (!snap || !snap.size) return;
  [80, 250, 700, 1500].forEach(ms=>{
    const tid = setTimeout(()=> restoreFloatPlayback(snap, exceptVid), ms);
    watchFloatState.pendingRestoreTimers.push(tid);
  });
}

function syncFloatAudioFocus(activeVid){
  watchFloatState.audioFocus = activeVid != null ? String(activeVid) : null;
  forEachFloatVideo((v, vid)=>{
    if (String(vid) === String(activeVid)){
      v.muted = !!v._floatUserMuted;
    } else {
      v.muted = true;
    }
  });
}

function _playbackInstanceCount(){
  let n = _floatPlayerCount();
  if (typeof isPlayerActive === "function" && isPlayerActive()) n += 1;
  return Math.max(1, n);
}

function fitWatchFloatPanel(panel, vw, vh){
  if (!panel || !vw || !vh) return;
  const barH = 36;
  const ctrlH = 44;
  const chromeH = barH + ctrlH;
  const maxBodyW = Math.min(window.innerWidth * 0.38, 520);
  const maxBodyH = Math.min(window.innerHeight * 0.36, 380);
  let bodyW = maxBodyW;
  let bodyH = Math.round(bodyW * vh / vw);
  if (bodyH > maxBodyH){
    bodyH = maxBodyH;
    bodyW = Math.round(bodyH * vw / vh);
  }
  panel.style.width = `${bodyW}px`;
  panel.style.height = `${bodyH + chromeH}px`;
  const left = parseInt(panel.style.left, 10) || 0;
  const top = parseInt(panel.style.top, 10) || 0;
  if (left + bodyW > window.innerWidth - 8){
    panel.style.left = `${Math.max(8, window.innerWidth - bodyW - 8)}px`;
  }
  if (top + bodyH + chromeH > window.innerHeight - 8){
    panel.style.top = `${Math.max(8, window.innerHeight - bodyH - chromeH - 8)}px`;
  }
}

function ensureWatchFloatLayer(){
  let layer = document.getElementById("watchFloatLayer");
  if (!layer){
    layer = document.createElement("div");
    layer.id = "watchFloatLayer";
    layer.className = "watch-float-layer";
    document.body.appendChild(layer);
  }
  return layer;
}

function bumpWatchFloatPanel(panel){
  if (!panel) return;
  watchFloatState.zCounter += 1;
  panel.style.zIndex = String(watchFloatState.zCounter);
}

function stopFloatWatchServices(panel){
  if (!panel) return;
  const cleanups = panel._floatCleanups || [];
  cleanups.forEach(fn=>{ try{ fn(); }catch(_){} });
  panel._floatCleanups = [];
}

function floatFixedDuration(video, vid){
  const expected = Number(video?._expectedDuration || 0);
  if (Number.isFinite(expected) && expected > 0) return expected;
  const cached = hlsInfoCache.get(String(vid));
  const fromCache = Number(cached?.duration || 0);
  if (Number.isFinite(fromCache) && fromCache > 0) return fromCache;
  const fromServer = _serverDurationForSrc(mediaVideoSrcOf(vid));
  if (fromServer > 0) return fromServer;
  const vd = Number(video?.duration || 0);
  if (Number.isFinite(vd) && vd > 0 && vd < 86400) return vd;
  return 0;
}

function installFloatPlayerControls(panel, video, vid){
  const root = panel.querySelector(".watch-float-controls");
  if (!root || !video) return;
  const btnPlay = root.querySelector(".wfc-play");
  const btnMute = root.querySelector(".wfc-mute");
  const seek = root.querySelector(".wfc-seek");
  const curEl = root.querySelector(".wfc-cur");
  const durEl = root.querySelector(".wfc-dur");
  const bufEl = root.querySelector(".wfc-buffered");
  const playedEl = root.querySelector(".wfc-played");
  let dragging = false;

  const duration = ()=> floatFixedDuration(video, vid);

  const syncUi = ()=>{
    const dur = duration();
    const pos = Math.max(0, Number(video.currentTime) || 0);
    if (curEl) curEl.textContent = fmtClock(pos);
    if (durEl) durEl.textContent = dur > 0 ? fmtClock(dur) : "--:--";
    if (seek && !dragging){
      seek.value = dur > 0 ? String(Math.round((pos / dur) * 1000)) : "0";
    }
    if (bufEl && dur > 0){
      const bufEnd = bufferedEndForPosition(video, pos);
      const bufPct = Math.max(0, Math.min(100, (bufEnd / dur) * 100));
      const playPct = Math.max(0, Math.min(100, (pos / dur) * 100));
      bufEl.style.width = `${bufPct}%`;
      if (playedEl) playedEl.style.width = `${playPct}%`;
    }
    if (btnPlay){
      const playing = !video.paused && !video.ended && !video._floatPlaybackStuck;
      btnPlay.textContent = playing ? "⏸" : "▶";
      btnPlay.setAttribute("aria-label", playing ? "暂停" : "播放");
    }
    if (btnMute){
      const muted = !!video.muted || (video.volume || 0) <= 0;
      btnMute.textContent = muted ? "🔇" : "🔊";
    }
  };

  btnPlay && (btnPlay.onclick = (ev)=>{
    ev.stopPropagation();
    const stuck = !!video._floatPlaybackStuck && !video._floatUserPaused;
    if (stuck){
      _floatNudgePlayback(video, "user-toggle-stuck");
      syncUi();
      return;
    }
    if (video.paused || video.ended){
      video._floatUserPaused = false;
      syncFloatAudioFocus(vid);
      if (video._hls){
        try { video._hls.startLoad(Number(video.currentTime) || 0); } catch(_){}
      }
      video.play().catch(()=>{});
    } else {
      video._floatUserPaused = true;
      try { video.pause(); } catch(_){}
      if (video._hls){
        try { video._hls.stopLoad(); } catch(_){}
      }
    }
    syncUi();
  });
  btnMute && (btnMute.onclick = (ev)=>{
    ev.stopPropagation();
    video._floatUserMuted = !video._floatUserMuted;
    if (String(watchFloatState.audioFocus) === String(vid)){
      video.muted = video._floatUserMuted;
    } else {
      video.muted = true;
    }
    syncUi();
  });
  if (seek){
    seek.addEventListener("input", (ev)=>{
      ev.stopPropagation();
      dragging = true;
      video._floatSeekDragging = true;
      focusWatchFloatPanel(panel);
      const dur = duration();
      if (dur <= 0) return;
      const frac = Math.max(0, Math.min(1, Number(ev.currentTarget.value) / 1000));
      const t = frac * dur;
      _floatMarkUserSeek(video, t);
      if (curEl) curEl.textContent = fmtClock(t);
    });
    seek.addEventListener("change", (ev)=>{
      ev.stopPropagation();
      dragging = false;
      video._floatSeekDragging = false;
      focusWatchFloatPanel(panel);
      const dur = duration();
      if (dur <= 0) return;
      const frac = Math.max(0, Math.min(1, Number(ev.currentTarget.value) / 1000));
      const t = Math.max(0, Math.min(dur - 0.05, frac * dur));
      _floatMarkUserSeek(video, t);
      try{ video.currentTime = t; }catch(_){}
      if (video._hls){
        try { video._hls.stopLoad(); } catch(_){}
        _floatHlsStartLoadAt(video, t);
      }
      apiReportHlsPlayhead(vid, t, "preview");
      if (!video._floatUserPaused) video.play().catch(()=>{});
      syncUi();
    });
    ["pointerdown","mousedown","touchstart"].forEach(t=>{
      seek.addEventListener(t, ev=>{
        ev.stopPropagation();
        video._floatSeekDragging = true;
        focusWatchFloatPanel(panel);
      });
    });
  }
  video.addEventListener("seeking", ()=>{
    if (Number.isFinite(video._floatUserSeekTarget)){
      video._floatUserSeekUntil = Date.now() + FLOAT_SEEK_GRACE_MS;
    }
  });
  ["play","pause","timeupdate","durationchange","volumechange","loadedmetadata"].forEach(evt=>{
    video.addEventListener(evt, syncUi);
  });
  video.addEventListener("play", ()=>{
    if (!video._floatUserPaused && video._hls){
      try { video._hls.startLoad(Number(video.currentTime) || 0); } catch(_){}
    }
  });
  video.addEventListener("pause", ()=>{
    if (video._floatUserPaused && video._hls){
      try { video._hls.stopLoad(); } catch(_){}
    }
  });
  syncUi();
  const uiTimer = setInterval(()=>{
    if (!document.contains(panel)){ clearInterval(uiTimer); return; }
    syncUi();
  }, 500);
  (panel._floatCleanups = panel._floatCleanups || []).push(()=> clearInterval(uiTimer));
  video._floatSyncUi = syncUi;
}

async function startFloatWatchPanel(panel, vid, title, priorSnap){
  const id = String(vid || "").trim();
  const video = panel.querySelector("video.watch-float-video");
  if (!video || !panel._floatAlive) return;
  video._floatClosed = false;
  video._floatDestroyed = false;
  video._floatLoadToken = (video._floatLoadToken || 0) + 1;
  const loadToken = video._floatLoadToken;
  video._floatUserPaused = false;
  video._floatUserMuted = false;
  syncFloatAudioFocus(id);
  let resumeAt = 0;
  if (FLOAT_PERSIST_PROGRESS){
    try{
      const p = await Promise.race([
        apiGetProgress(id),
        new Promise(res => setTimeout(()=>res(null), 800)),
      ]);
      if (!_floatPanelActive(panel, video) || video._floatLoadToken !== loadToken) return;
      if (p && p.duration > 0
        && p.position >= PROGRESS_MIN_POSITION_SEC
        && p.position / p.duration < PROGRESS_COMPLETE_RATIO){
        resumeAt = p.position;
      }
    }catch(_){}
  }
  if (!_floatPanelActive(panel, video) || video._floatLoadToken !== loadToken) return;
  apiHlsResume(id, "preview");   // 仅清除 abandoned；冷启动由 attach 内的 warmup 闸错峰触发
  installFloatPlayheadReporter(video, id, panel);
  installFloatStallWatch(video, id, panel);
  installFloatPlayerControls(panel, video, id);
  video.volume = 0.85;

  panel._floatAttachPending = true;
  panel._floatAttachStarted = false;
  panel._floatRunAttach = async ()=>{
    if (!panel._floatAttachPending || panel._floatAttachStarted) return;
    if (!_floatPanelActive(panel, video) || video._floatLoadToken !== loadToken) return;
    panel._floatAttachStarted = true;
    try{
      await attachVideoSrc(mediaVideoSrcOf(id), resumeAt, { target: video, isFloat: true, floatPanel: panel, floatLoadToken: loadToken });
      if (!_floatPanelActive(panel, video) || video._floatLoadToken !== loadToken){
        _destroyFloatVideo(video);
        return;
      }
      const ok = await safePlay(video);
      if (!_floatPanelActive(panel, video) || video._floatLoadToken !== loadToken){
        _destroyFloatVideo(video);
        return;
      }
      if (!ok) video.play().catch(()=>{});
      if (priorSnap) await restoreFloatPlayback(priorSnap, id);
      if (_floatPanelActive(panel, video) && video._floatLoadToken === loadToken){
        scheduleFloatPlaybackRestore(priorSnap, id);
      }
    }catch(e){
      _releaseFloatWarmupSlot(video);
      if (_floatPanelActive(panel, video)) console.error("[float-watch] start failed", id, e);
      else _destroyFloatVideo(video);
    }finally{
      panel._floatAttachPending = false;
      panel._floatAttachStarted = false;
      reconcileFloatLoadPriority();
    }
    if (!_floatPanelActive(panel, video)) return;
    const fit = ()=>{
      if (video.videoWidth > 0 && video.videoHeight > 0){
        fitWatchFloatPanel(panel, video.videoWidth, video.videoHeight);
      }
    };
    if (video.videoWidth > 0) fit();
    else video.addEventListener("loadedmetadata", fit, { once:true });
    if (video._hls && video._expectedDuration){
      pinHlsDuration(video._hls, video, video._expectedDuration);
    }
    video._floatSyncUi?.();
  };

  bumpFloatPanelPriority(panel, id);
  refreshFloatHlsCapacity();
}

function openPopoutWatch(vid, title){
  refreshFloatHlsCapacity();
  const id = String(vid || "").trim();
  if (!id) return;
  if (POPOUT_MODE) return;
  if (isPlayerActive() && String(player.ids[player.index]) === id){
    showNotice("该视频正在全屏播放，请先返回再开浮动窗");
    setTimeout(clearNotice, 2400);
    return;
  }
  const t = String(title || "").trim() || `视频 ${id}`;
  if (watchFloatState.panels.has(id)){
    syncFloatAudioFocus(id);
    focusWatchFloatPanel(watchFloatState.panels.get(id));
    const panel = watchFloatState.panels.get(id);
    const v = panel?.querySelector("video.watch-float-video");
    if (v && !v._floatUserPaused && v.paused) v.play().catch(()=>{});
    return;
  }
  const priorSnap = snapshotFloatPlayback();
  const layer = ensureWatchFloatLayer();
  const idx = watchFloatState.panels.size;
  const panel = document.createElement("div");
  panel.className = "watch-float";
  panel.dataset.vid = id;
  panel._floatCleanups = [];
  panel._floatAlive = true;
  panel.style.left = `${24 + (idx % 4) * 40}px`;
  panel.style.top = `${48 + Math.floor(idx / 4) * 40}px`;
  panel.innerHTML = `
    <div class="watch-float-bar">
      <span class="watch-float-title"></span>
      <button type="button" class="watch-float-menu" title="菜单" aria-label="菜单">⋯</button>
      <button type="button" class="watch-float-close" title="关闭" aria-label="关闭">×</button>
    </div>
    <div class="watch-float-body">
      <video class="watch-float-video" playsinline webkit-playsinline preload="auto" crossorigin="anonymous"></video>
      <div class="watch-float-controls">
        <button type="button" class="wfc-play" aria-label="播放">▶</button>
        <span class="wfc-cur">0:00</span>
        <div class="wfc-seek-wrap">
          <div class="wfc-seek-track">
            <div class="wfc-buffered"></div>
            <div class="wfc-played"></div>
          </div>
          <input type="range" class="wfc-seek" min="0" max="1000" value="0" aria-label="进度"/>
        </div>
        <span class="wfc-dur">--:--</span>
        <button type="button" class="wfc-mute" aria-label="静音">🔊</button>
      </div>
    </div>
  `;
  panel.querySelector(".watch-float-title").textContent = t;
  panel.querySelector(".watch-float-close").onclick = (ev)=>{
    ev.stopPropagation();
    closeWatchFloatPanel(id);
  };
  const floatMenuBtn = panel.querySelector(".watch-float-menu");
  if (floatMenuBtn){
    floatMenuBtn.onclick = (ev)=>{
      ev.preventDefault();
      ev.stopPropagation();
      openFloatContextMenu(id, floatMenuBtn);
    };
  }
  installWatchFloatDrag(panel);
  panel.addEventListener("pointerdown", ()=>{
    focusWatchFloatPanel(panel);
    syncFloatAudioFocus(id);
  });
  layer.appendChild(panel);
  watchFloatState.panels.set(id, panel);
  bumpWatchFloatPanel(panel);
  fitWatchFloatPanel(panel, 16, 9);
  if (watchFloatState.panels.size > 10){
    showNotice(`已打开 ${watchFloatState.panels.size} 个浮动窗，过多并发可能导致个别画面卡住`);
    setTimeout(clearNotice, 3200);
  }
  startFloatWatchPanel(panel, id, t, priorSnap);
  reconcileFloatHlsBudgets();
}

function closeWatchFloatPanel(vid){
  const id = String(vid || "").trim();
  const panel = watchFloatState.panels.get(id);
  if (!panel) return;
  panel._floatAlive = false;
  const video = panel.querySelector("video.watch-float-video");
  if (video && !video._floatDirectPlay) apiHlsStop(id, "preview");
  else if (!video) apiHlsStop(id, "preview");
  stopFloatWatchServices(panel);
  if (video){
    try{
      if (FLOAT_PERSIST_PROGRESS && shouldPersistPlaybackState()){
        const pos = Number(video.currentTime) || 0;
        const dur = floatFixedDuration(video, id) || Number(video.duration) || 0;
        if (dur >= 1 && pos >= PROGRESS_MIN_POSITION_SEC && pos / dur >= PROGRESS_START_RATIO){
          apiSaveProgress(id, pos, dur);
        }
      }
    }catch(_){}
    _destroyFloatVideo(video);
  }
  panel.remove();
  watchFloatState.panels.delete(id);
  if (String(watchFloatState.audioFocus) === id){
    const rest = [...watchFloatState.panels.keys()];
    syncFloatAudioFocus(rest.length ? rest[rest.length - 1] : null);
  }
  if (watchFloatState.panels.size === 0){
    _cancelAllFloatRestoreTimers();
    document.querySelectorAll("video.watch-float-video").forEach(v=>{
      try { _destroyFloatVideo(v); } catch(_){}
    });
    apiHlsStopAll("preview");
  }
  reconcileFloatHlsBudgets();
}

/* ===================== 浮窗拖入文件夹（虚拟热区层，视频窗始终可见） ===================== */
const FLOAT_FOLDER_ARM_MS = 700;
const FLOAT_STILL_PX = 4;
const FLOAT_MOVE_DISARM_MS = 90;

const floatFolderDropVL = { layer: null, box: null };

function floatDropEnsureLayer(){
  if (!floatFolderDropVL.layer){
    const el = document.createElement("div");
    el.id = "floatFolderDropLayer";
    el.className = "float-folder-drop-layer";
    el.setAttribute("aria-hidden", "true");
    document.body.appendChild(el);
    floatFolderDropVL.layer = el;
  }
  return floatFolderDropVL.layer;
}

function floatDropBuildZones(){
  const zones = [];
  for (const t of state.tiles || []){
    if (t.type !== "folder" && t.type !== "parent") continue;
    const path = t.path || "/";
    if (state.selF.has(path)) continue;
    const el = t.el;
    if (!el?.isConnected) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) continue;
    zones.push({
      path,
      title: String(t.title || path),
      el,
    });
  }
  return zones;
}

function floatDropLiveRect(zone){
  const el = zone?.el;
  if (!el?.isConnected) return null;
  const r = el.getBoundingClientRect();
  if (r.width < 8 || r.height < 8) return null;
  return { left: r.left, top: r.top, width: r.width, height: r.height };
}

function floatDropApplyBox(box, zone){
  const r = floatDropLiveRect(zone);
  if (!r || !box) return false;
  box.style.left = `${r.left}px`;
  box.style.top = `${r.top}px`;
  box.style.width = `${r.width}px`;
  box.style.height = `${r.height}px`;
  return true;
}

function floatDropHitZone(zones, x, y){
  for (let i = zones.length - 1; i >= 0; i--){
    const r = floatDropLiveRect(zones[i]);
    if (!r) continue;
    if (x >= r.left && x <= r.left + r.width && y >= r.top && y <= r.top + r.height)
      return { ...zones[i], ...r };
  }
  return null;
}

function floatDropLayerClear(){
  floatFolderDropVL.layer?.classList.remove("active");
}

function floatDropLayerShowArmed(zone){
  const layer = floatDropEnsureLayer();
  if (!floatFolderDropVL.box){
    const box = document.createElement("div");
    box.className = "float-drop-vzone armed";
    box.innerHTML = `<div class="float-drop-vface"><span class="float-drop-vicon">📁</span><span class="float-drop-vtitle"></span></div>`;
    layer.appendChild(box);
    floatFolderDropVL.box = box;
  }
  const box = floatFolderDropVL.box;
  const titleEl = box.querySelector(".float-drop-vtitle");
  if (titleEl) titleEl.textContent = zone.title;
  if (!floatDropApplyBox(box, zone)) return;
  layer.classList.add("active");
}

function floatDropLayerSyncArmed(){
  if (!floatFolderDropVL.box || !floatFolderDropVL.layer?.classList.contains("active")) return;
  const z = floatFolderDropVL._zone;
  if (!z) return;
  if (!floatDropApplyBox(floatFolderDropVL.box, z)){
    floatDropLayerClear();
  }
}

function installWatchFloatDrag(panel){
  const bar = panel.querySelector(".watch-float-bar");
  if (!bar || bar._dragBound) return;
  bar._dragBound = true;
  const vid = String(panel.dataset.vid || "");

  bar.addEventListener("pointerdown", (ev)=>{
    if (ev.target.closest(".watch-float-close, .watch-float-menu")) return;
    if (WALLPAPER_MODE) return;

    const pointerId = ev.pointerId;
    let startX = ev.clientX, startY = ev.clientY;
    let lastX = ev.clientX, lastY = ev.clientY;
    let stillX = ev.clientX, stillY = ev.clientY;
    let armAtX = 0, armAtY = 0;
    let origLeft = panel.offsetLeft, origTop = panel.offsetTop;
    let dragging = false;
    let dropArmed = false;
    let movedSinceArm = false;
    let zones = [];
    let activeZone = null;
    let armTimer = null;
    let moveDisarmTimer = null;

    const syncPanelPos = ()=>{
      panel.style.left = `${Math.max(0, origLeft + lastX - startX)}px`;
      panel.style.top = `${Math.max(0, origTop + lastY - startY)}px`;
    };

    const rebuildZones = ()=>{ zones = floatDropBuildZones(); };

    const clearArmTimer = ()=>{
      if (armTimer){ clearTimeout(armTimer); armTimer = null; }
    };

    const clearMoveDisarmTimer = ()=>{
      if (moveDisarmTimer){ clearTimeout(moveDisarmTimer); moveDisarmTimer = null; }
    };

    const clearDropUI = ()=>{
      activeZone = null;
      floatFolderDropVL._zone = null;
      floatDropLayerClear();
    };

    const disarmDrop = (keepZone=false)=>{
      if (!dropArmed) return;
      dropArmed = false;
      movedSinceArm = false;
      clearMoveDisarmTimer();
      floatDropLayerClear();
      if (!keepZone){
        activeZone = null;
        floatFolderDropVL._zone = null;
      }
    };

    const armDrop = ()=>{
      if (dropArmed || !activeZone) return;
      dropArmed = true;
      movedSinceArm = false;
      armAtX = lastX;
      armAtY = lastY;
      floatFolderDropVL._zone = activeZone;
      floatDropLayerShowArmed(activeZone);
    };

    const startArmTimer = ()=>{
      clearArmTimer();
      stillX = lastX;
      stillY = lastY;
      armTimer = setTimeout(()=>{
        armTimer = null;
        if (!activeZone || dropArmed) return;
        if (floatDropHitZone(zones, lastX, lastY)?.path !== activeZone.path) return;
        if (Math.hypot(lastX - stillX, lastY - stillY) > FLOAT_STILL_PX) return;
        armDrop();
      }, FLOAT_FOLDER_ARM_MS);
    };

    const enterZone = (zone)=>{
      if (activeZone?.path !== zone.path){
        clearArmTimer();
        disarmDrop(false);
        activeZone = zone;
      }
      startArmTimer();
    };

    const scheduleDisarmOnMove = ()=>{
      if (!dropArmed || moveDisarmTimer) return;
      moveDisarmTimer = setTimeout(()=>{
        moveDisarmTimer = null;
        if (!dropArmed) return;
        const keep = !!(activeZone && floatDropHitZone(zones, lastX, lastY)?.path === activeZone.path);
        disarmDrop(keep);
        if (keep) startArmTimer();
      }, FLOAT_MOVE_DISARM_MS);
    };

    const onScrollOrResize = ()=>{
      if (!dragging) return;
      const path = activeZone?.path;
      rebuildZones();
      if (!path) return;
      const next = zones.find(z => z.path === path);
      if (!next){ clearArmTimer(); disarmDrop(false); clearDropUI(); return; }
      activeZone = next;
      if (dropArmed){
        floatFolderDropVL._zone = next;
        floatDropLayerSyncArmed();
      }
    };

    const cleanup = ()=>{
      clearArmTimer();
      clearMoveDisarmTimer();
      disarmDrop(false);
      clearDropUI();
      if (panel.isConnected) panel.style.pointerEvents = "";
      window.removeEventListener("scroll", onScrollOrResize, true);
      document.removeEventListener("scroll", onScrollOrResize, true);
      window.removeEventListener("resize", onScrollOrResize);
    };

    const onMove = (e)=>{
      if (e.pointerId !== pointerId) return;
      lastX = e.clientX;
      lastY = e.clientY;

      if (!dragging){
        if (Math.hypot(lastX - startX, lastY - startY) < FOLDER_DROP_THRESHOLD) return;
        dragging = true;
        panel.style.pointerEvents = "none";
        bumpWatchFloatPanel(panel);
        rebuildZones();
        window.addEventListener("scroll", onScrollOrResize, { passive:true, capture:true });
        document.addEventListener("scroll", onScrollOrResize, { passive:true, capture:true });
        window.addEventListener("resize", onScrollOrResize, { passive:true });
      }

      if (dropArmed){
        if (Math.hypot(lastX - armAtX, lastY - armAtY) > FLOAT_STILL_PX){
          movedSinceArm = true;
          scheduleDisarmOnMove();
        }
        floatDropLayerSyncArmed();
      }

      syncPanelPos();

      if (dropArmed) return;

      const hit = floatDropHitZone(zones, lastX, lastY);
      if (hit){
        enterZone(hit);
        if (Math.hypot(lastX - stillX, lastY - stillY) > FLOAT_STILL_PX) startArmTimer();
        return;
      }

      clearArmTimer();
      disarmDrop(false);
      clearDropUI();
    };

    const onUp = async (e)=>{
      if (e.pointerId !== pointerId) return;
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onUp);

      const hit = floatDropHitZone(zones, e.clientX, e.clientY);
      if (dropArmed && !movedSinceArm && activeZone && hit?.path === activeZone.path){
        const path = activeZone.path;
        cleanup();
        folderDrop.suppressClickUntil = Date.now() + 400;
        await moveIdsAndRefresh([vid], path);
        return;
      }
      cleanup();
    };

    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onUp);
  });
}

// 浮窗"三个点"按钮：复用与右键完全一致的上下文菜单。
// 选中该浮窗对应的视频（若网格内仍存在对应 tile 则同步高亮），再在按钮下方弹出菜单。
function openFloatContextMenu(vid, anchorEl){
  const id = String(vid || "").trim();
  if (!id || !anchorEl) return;
  try { clearSel(); } catch(_){}
  const tile = (state.tiles || []).find(t => t && t.type === "video" && String(t.vid) === id);
  if (tile){
    setSel(tile, true);
    state.lastIdx = tile.idx;
  } else {
    state.selV.add(id);
  }
  const b = anchorEl.getBoundingClientRect();
  openContextMenu(b.left + b.width / 2, b.top + b.height);
}

if (!POPOUT_MODE){
  window.addEventListener("message", (ev)=>{
    if (ev.origin !== window.location.origin) return;
    const d = ev.data;
    if (d && d.type === "watch-close" && d.vid) closeWatchFloatPanel(d.vid);
  });
}

function installFloatPlayheadReporter(vEl, vid, panel){
  const id = String(vid || "");
  if (!vEl || !id || !panel) return;
  let lastPos = -1;
  const tick = ()=>{
    if (!document.contains(vEl)) return;
    const pos = Number(vEl.currentTime);
    if (!Number.isFinite(pos)) return;
    if (Math.abs(pos - lastPos) < 0.25) return;
    lastPos = pos;
    apiReportHlsPlayhead(id, pos, "preview");
  };
  vEl.addEventListener("timeupdate", tick);
  const interval = setInterval(()=>{
    if (!document.contains(vEl)) return;
    if (vEl.paused || vEl.ended) return;
    tick();
  }, 1200);
  (panel._floatCleanups = panel._floatCleanups || []).push(()=> clearInterval(interval));
}

function installFloatStallWatch(vEl, vid, panel){
  const id = String(vid || "");
  if (!vEl || !id || !panel) return;
  let lastT = 0, lastWall = 0, stuck = 0;
  vEl._floatLastMoveAt = Date.now();
  vEl._floatPlaybackStuck = false;
  vEl.addEventListener("timeupdate", ()=>{
    const ct = Number(vEl.currentTime) || 0;
    const prevT = lastT;
    if (Math.abs(ct - lastT) >= 0.08){
      _floatClearUserSeekIfPlaying(vEl, prevT, ct);
      vEl._floatLastMoveAt = Date.now();
      vEl._floatPlaybackStuck = false;
      stuck = 0;
      lastT = ct;
      // 解出首帧 → 释放冷启动槽位，让排队的下一个浮窗开始预热
      if (ct > 0.02) _releaseFloatWarmupSlot(vEl);
    }
  });
  vEl.addEventListener("loadeddata", ()=>{ if ((Number(vEl.currentTime)||0) >= 0) _releaseFloatWarmupSlot(vEl); }, { once:true });
  vEl.addEventListener("waiting", ()=>{
    apiReportHlsPlayhead(id, vEl.currentTime || 0, "preview");
    if (vEl._floatUserPaused) return;
    if (_floatInSeekGrace(vEl)) return;
    _floatHlsStartLoadAt(vEl, _floatSeekResumeAt(vEl));
  });
  vEl.addEventListener("stalled", ()=>{
    if (vEl._floatUserPaused) return;
    if (_floatInSeekGrace(vEl)) return;
    _floatHlsStartLoadAt(vEl, _floatSeekResumeAt(vEl));
  });
  const watchdog = setInterval(()=>{
    if (!document.contains(vEl) || vEl._floatClosed || !panel._floatAlive) return;
    if (vEl._floatUserPaused || vEl.ended) return;
    if (vEl._floatSeekDragging || _floatInSeekGrace(vEl)){
      _floatReassertSeekIfSpurious(vEl);
      stuck = 0;
      vEl._floatPlaybackStuck = false;
      return;
    }
    if (vEl.paused){
      if (String(watchFloatState.audioFocus) !== String(id)) vEl.muted = true;
      if (!vEl._floatClosed) vEl.play().catch(()=>{});
      return;
    }
    const ct = Number(vEl.currentTime) || 0;
    const now = Date.now();
    const bufEnd = bufferedEndForPosition(vEl, ct);
    const hasBufferedAhead = bufEnd > ct + 0.35;
    const idleMs = now - (vEl._floatLastMoveAt || now);
    if (ct < 0.05 && !hasBufferedAhead && idleMs > 22000 && vEl._hls && !_floatInSeekGrace(vEl)){
      // 预热超时：先放掉冷启动槽位（别卡住排队中的其它浮窗），再重试
      _releaseFloatWarmupSlot(vEl);
      vEl._floatWarmupRetries = (vEl._floatWarmupRetries || 0) + 1;
      _floatHardRetryAttach(panel, vEl, id, "warmup-timeout");
      vEl._floatLastMoveAt = now;
      stuck = 0;
      if (vEl._floatWarmupRetries >= 3){
        _floatRetryHlsWarmup(panel, vEl, id).catch(()=>{});
        vEl._floatWarmupRetries = 0;
      }
      return;
    }
    if (idleMs > 1800 && Math.abs(ct - lastT) < 0.12){
      if (_floatInSeekGrace(vEl)){
        stuck = 0;
        vEl._floatPlaybackStuck = false;
        return;
      }
      stuck += 1;
      vEl._floatPlaybackStuck = true;
      apiReportHlsPlayhead(id, ct, "preview");
      // 浮窗 preview：不自动 nudge（pause/recoverMediaError 易把 seek 打回开头）
      if (vEl._hls){
        if (stuck >= 1) _floatHlsStartLoadAt(vEl, _floatSeekResumeAt(vEl));
        if (stuck >= 5){ try { vEl._hls.recoverMediaError(); } catch(_){} }
      }
      if (stuck >= 2 && hasBufferedAhead) vEl.play().catch(()=>{});
    } else if (Math.abs(ct - lastT) >= 0.12) {
      stuck = 0;
      vEl._floatPlaybackStuck = false;
      vEl._floatLastMoveAt = now;
    }
    lastT = ct;
    lastWall = now;
  }, 1500);
  (panel._floatCleanups = panel._floatCleanups || []).push(()=> clearInterval(watchdog));
}

async function exitPlayerOrClosePopout(){
  await exitPlayer();
  if (POPOUT_MODE){
    if (POPOUT_EMBED && window.parent !== window){
      try{
        window.parent.postMessage({ type:"watch-close", vid: POPOUT_VID }, window.location.origin);
      }catch(_){}
      return;
    }
    try { window.close(); } catch(_){}
  }
}

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
  if (!shouldPersistPlaybackState()) return;
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
  if (!shouldPersistPlaybackState()) return;
  const idStr = String(id);
  const prev = isWatched(idStr);
  watchedCache.set(idStr, on);
  updateTileWatchedUI(idStr, on);
  // 切换观看状态时与服务器同步清除本地进度缓存，避免短 TTL 内仍命中旧进度
  progressLocalCache.delete(idStr);
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

/* ===== 播放进度（断点续播） =====
 * 后端阈值：完成 90%、起始 5%（或绝对 5s），低于起始不上报，高于完成自动清除+标记已看
 * 前端节流：10s 间隔、位置变化 ≥ 2s 才上报一次，减少网络请求与跨端抖动
 */
const PROGRESS_COMPLETE_RATIO = 0.90;
const PROGRESS_START_RATIO    = 0.05;
const PROGRESS_MIN_POSITION_SEC = 5;
const PROGRESS_SAVE_INTERVAL_MS = 10000;
const PROGRESS_SAVE_MIN_DELTA_SEC = 2;

// 本地进度缓存：仅用于"退出→立即重进"的竞态兜底（避免 POST 未到 / GET 先到读空）
// 不是长期缓存！TTL 很短，以免多端播放时 A 设备读到陈旧的本地值
const progressLocalCache = new Map(); // id -> {position, duration, ts}
const PROGRESS_LOCAL_TTL_MS = 20 * 1000;
// playIndex 启动后，若服务器拉到的进度与已使用的 resumeAt 差异 >= 此阈值，平滑 seek 到服务器值
const PROGRESS_SERVER_OVERRIDE_DELTA_SEC = 5;

function _beaconJson(url, body){
  try{
    const blob = new Blob([JSON.stringify(body)], { type: "application/json" });
    if (navigator.sendBeacon && navigator.sendBeacon(url, blob)) return true;
  }catch(_){}
  return false;
}

async function apiGetProgress(id){
  try{
    const qs = new URLSearchParams({ ids: String(id) });
    const r = await fetch(`/api/progress?${qs.toString()}`, { cache: "no-store" });
    if (!r.ok) return null;
    const j = await r.json();
    const p = j?.progress?.[String(id)];
    return p && Number.isFinite(p.position) ? p : null;
  }catch(_){ return null; }
}
function apiSaveProgress(id, position, duration){
  if (!shouldPersistPlaybackState()) return;
  const body = { id: String(id), position, duration };
  // 更新本地缓存（关键：不依赖网络回执，下次 playIndex 能立即命中）
  progressLocalCache.set(String(id), { position, duration, ts: Date.now() });
  // 先尝试 sendBeacon（最可靠），失败回退到 fetch keepalive
  if (_beaconJson("/api/progress", body)) return;
  try{
    fetch("/api/progress", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      keepalive: true,
      body: JSON.stringify(body),
    }).catch(()=>{});
  }catch(_){}
}
function apiClearProgress(id){
  if (!shouldPersistPlaybackState()) return;
  const body = { ids: [String(id)] };
  progressLocalCache.delete(String(id));
  if (_beaconJson("/api/progress/clear", body)) return;
  try{
    fetch("/api/progress/clear", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      keepalive: true,
      body: JSON.stringify(body),
    }).catch(()=>{});
  }catch(_){}
}

function apiHlsStop(id, tier = "preview"){
  const body = { id: String(id), tier: tier === "preview" ? "preview" : "full" };
  if (_beaconJson("/api/hls/stop", body)) return;
  try{
    fetch("/api/hls/stop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      keepalive: true,
      body: JSON.stringify(body),
    }).catch(()=>{});
  }catch(_){}
}

function apiHlsStopAll(tier = "preview"){
  const body = { tier: tier === "preview" ? "preview" : "full" };
  if (_beaconJson("/api/hls/stop-all", body)) return;
  try{
    fetch("/api/hls/stop-all", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      keepalive: true,
      body: JSON.stringify(body),
    }).catch(()=>{});
  }catch(_){}
}

function apiHlsResume(id, tier = "preview"){
  const body = { id: String(id), tier: tier === "preview" ? "preview" : "full" };
  try{
    fetch("/api/hls/resume", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      keepalive: true,
      body: JSON.stringify(body),
    }).catch(()=>{});
  }catch(_){}
}

function apiHlsPriority(id, priority, tier = "preview"){
  const body = {
    id: String(id),
    priority: Number(priority) || 0,
    tier: tier === "preview" ? "preview" : "full",
  };
  try{
    fetch("/api/hls/priority", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      keepalive: true,
      body: JSON.stringify(body),
    }).catch(()=>{});
  }catch(_){}
}

async function refreshFloatHlsCapacity(){
  try{
    const r = await fetch("/api/hls/capacity?tier=preview", { cache: "no-store", credentials: "same-origin" });
    if (!r.ok) return;
    const j = await r.json();
    const n = Number(j.concurrent_max);
    if (Number.isFinite(n) && n > 0){
      _floatConcurrentHlsMax = Math.min(Math.floor(n), 10);
      reconcileFloatLoadPriority();
    }
  }catch(_){}
}

function apiReportHlsPlayhead(id, position, tier = "full"){
  const body = {
    id: String(id),
    position: Math.max(0, Number(position) || 0),
    tier: tier === "preview" ? "preview" : "full",
  };
  if (_beaconJson("/api/hls/playhead", body)) return;
  try{
    fetch("/api/hls/playhead", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      keepalive: true,
      body: JSON.stringify(body),
    }).catch(()=>{});
  }catch(_){}
}

let _popoutPlayheadVideo = null;
function installPopoutPlayheadReporter(vEl){
  if (!POPOUT_MODE || !vEl) return;
  if (_popoutPlayheadVideo === vEl) return;
  _popoutPlayheadVideo = vEl;
  let lastAt = 0, lastPos = -1;
  vEl.addEventListener("timeupdate", ()=>{
    if (!isPlayerActive()) return;
    const curId = player?.ids?.[player.index];
    if (!curId) return;
    const now = Date.now();
    if (now - lastAt < 2500) return;
    const pos = Number(vEl.currentTime);
    if (!Number.isFinite(pos)) return;
    if (Math.abs(pos - lastPos) < 0.5) return;
    lastAt = now;
    lastPos = pos;
    apiReportHlsPlayhead(curId, pos);
  });
}
function getLocalProgress(id){
  const p = progressLocalCache.get(String(id));
  if (!p) return null;
  if (Date.now() - (p.ts || 0) > PROGRESS_LOCAL_TTL_MS){
    progressLocalCache.delete(String(id));
    return null;
  }
  return p;
}

const progressSaveState = { id: null, lastSavedAt: 0, lastSavedPos: -1, completedFor: null };
function resetProgressSaveState(){
  progressSaveState.id = null;
  progressSaveState.lastSavedAt = 0;
  progressSaveState.lastSavedPos = -1;
  progressSaveState.completedFor = null;
}
function maybeMarkPlaybackComplete(id, pos, dur){
  if (!shouldPersistPlaybackState() || !id) return false;
  if (!Number.isFinite(pos) || !Number.isFinite(dur) || dur < 1) return false;
  if (pos / dur < PROGRESS_COMPLETE_RATIO) return false;
  const sid = String(id);
  if (progressSaveState.completedFor === sid) return true;
  progressSaveState.completedFor = sid;
  markWatched(id);
  // 服务端在 >=90% 时会清 progress 并写入 watched；仅 clear 不会标记已观看。
  apiSaveProgress(id, pos, dur);
  return true;
}
function reportProgressTick(){
  if (!shouldPersistPlaybackState()) return;
  if (typeof isPlayerActive !== "function" || !isPlayerActive()) return;
  const id = player?.ids?.[player.index];
  if (!id) return;
  const { pos, dur } = getLogicalPosDur();
  if (!Number.isFinite(pos) || !Number.isFinite(dur) || dur < 1) return;

  if (maybeMarkPlaybackComplete(id, pos, dur)) return;

  if (progressSaveState.id !== String(id)){
    progressSaveState.id = String(id);
    progressSaveState.lastSavedAt = 0;
    progressSaveState.lastSavedPos = -1;
    progressSaveState.completedFor = null;
  }
  const now = Date.now();
  if (now - progressSaveState.lastSavedAt < PROGRESS_SAVE_INTERVAL_MS) return;
  if (Math.abs(pos - progressSaveState.lastSavedPos) < PROGRESS_SAVE_MIN_DELTA_SEC) return;
  if (pos < PROGRESS_MIN_POSITION_SEC) return;
  if (pos / dur < PROGRESS_START_RATIO) return;

  progressSaveState.lastSavedAt = now;
  progressSaveState.lastSavedPos = pos;
  apiSaveProgress(id, pos, dur);
}

let _progressTickTimer = null;
function startProgressTicker(){
  if (_progressTickTimer) return;
  _progressTickTimer = setInterval(reportProgressTick, PROGRESS_SAVE_INTERVAL_MS);
}
function stopProgressTicker(){
  if (_progressTickTimer){ clearInterval(_progressTickTimer); _progressTickTimer = null; }
}

// 返回当前"逻辑播放位置/时长"（与视频时间轴一致）
// audio 模式下需要扣除 audioBias（audio 流相对 video 的偏移）
function getLogicalPosDur(){
  try{
    const v = media.v || document.getElementById("fsVideo");
    const a = media.a || document.getElementById("bgAudio");
    if (playbackMode === "audio" && a){
      const rawPos = Number(a.currentTime) || 0;
      const pos = Math.max(0, rawPos - (audioBias || 0));
      let dur = fixedMediaDuration();
      if (!Number.isFinite(dur) || dur <= 0) dur = Number(v?.duration) || 0;
      if (!Number.isFinite(dur) || dur <= 0) dur = Number(a.duration) || 0;
      return { pos, dur };
    }
    if (v){
      const pos = Number(v.currentTime) || 0;
      let dur = fixedMediaDuration();
      if (!Number.isFinite(dur) || dur <= 0) dur = Number(v.duration) || 0;
      return { pos, dur };
    }
  }catch(_){}
  return { pos: 0, dur: 0 };
}

function fmtClock(sec){
  sec = Math.max(0, Number(sec) || 0);
  const s = Math.floor(sec % 60);
  const m = Math.floor(sec / 60) % 60;
  const h = Math.floor(sec / 3600);
  return h > 0
    ? `${h}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`
    : `${m}:${String(s).padStart(2,"0")}`;
}

function cpcIcon(name){
  const attrs = 'class="cpc-svg" viewBox="0 0 24 24" aria-hidden="true" focusable="false"';
  const icons = {
    play: `<svg ${attrs}><polygon points="6 4 20 12 6 20 6 4"></polygon></svg>`,
    pause: `<svg ${attrs}><rect x="6" y="4" width="4" height="16" rx="1"></rect><rect x="14" y="4" width="4" height="16" rx="1"></rect></svg>`,
    previous: `<svg ${attrs}><polygon points="19 20 9 12 19 4 19 20"></polygon><line x1="5" y1="19" x2="5" y2="5"></line></svg>`,
    next: `<svg ${attrs}><polygon points="5 4 15 12 5 20 5 4"></polygon><line x1="19" y1="5" x2="19" y2="19"></line></svg>`,
    volume: `<svg ${attrs}><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M15.5 8.5a5 5 0 0 1 0 7"></path><path d="M19 5a10 10 0 0 1 0 14"></path></svg>`,
    mute: `<svg ${attrs}><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><line x1="22" y1="9" x2="16" y2="15"></line><line x1="16" y1="9" x2="22" y2="15"></line></svg>`,
    pip: `<svg ${attrs}><rect x="3" y="5" width="18" height="14" rx="2"></rect><rect x="13" y="12" width="6" height="4" rx="1"></rect></svg>`,
    fullscreen: `<svg ${attrs}><path d="M8 3H5a2 2 0 0 0-2 2v3"></path><path d="M16 3h3a2 2 0 0 1 2 2v3"></path><path d="M8 21H5a2 2 0 0 1-2-2v-3"></path><path d="M16 21h3a2 2 0 0 0 2-2v-3"></path></svg>`,
    fullscreenExit: `<svg ${attrs}><path d="M8 3v3a2 2 0 0 1-2 2H3"></path><path d="M16 3v3a2 2 0 0 0 2 2h3"></path><path d="M8 21v-3a2 2 0 0 0-2-2H3"></path><path d="M16 21v-3a2 2 0 0 1 2-2h3"></path></svg>`,
    rotate: `<svg ${attrs}><rect x="7" y="3" width="10" height="18" rx="2"></rect><path d="M4 8a8 8 0 0 1 8-6"></path><path d="m9 2 3 0 0 3"></path><path d="M20 16a8 8 0 0 1-8 6"></path><path d="m15 22-3 0 0-3"></path></svg>`,
    back: `<svg ${attrs}><path d="M19 12H5"></path><path d="M12 19l-7-7 7-7"></path></svg>`,
    menu: `<svg ${attrs}><path d="M4 6h16"></path><path d="M4 12h16"></path><path d="M4 18h16"></path></svg>`,
    chevronDown: `<svg ${attrs}><path d="m6 9 6 6 6-6"></path></svg>`,
    home: `<svg ${attrs}><path d="m3 10 9-7 9 7"></path><path d="M5 10v10h14V10"></path><path d="M9 20v-6h6v6"></path></svg>`,
  };
  return icons[name] || "";
}

function setCpcIcon(btn, name){
  if (!btn || btn.dataset.icon === name) return;
  btn.dataset.icon = name;
  btn.innerHTML = cpcIcon(name);
}

const customControls = {
  els:null,
  dragging:false,
  previewTime:0,
  seekBufferClampUntil:0,
  timer:null,
  lastUiAt:0,
  lastVolume:0.8,
  pipPending:false,
  pipActive:false,
  orientationLocked:false,
};

function fixedMediaDuration(){
  const v = media.v || $("fsVideo");
  const a = media.a || $("bgAudio");
  const expected = Number(v?._expectedDuration || 0);
  if (Number.isFinite(expected) && expected > 0) return expected;
  const id = player?.ids?.[player.index];
  if (id){
    const cached = hlsInfoCache.get(String(id));
    const d = Number(cached?.duration || 0);
    if (Number.isFinite(d) && d > 0) return d;
  }
  const { dur } = getLogicalPosDur();
  if (Number.isFinite(dur) && dur > 0) return dur;
  const vd = Number(v?.duration || 0);
  if (Number.isFinite(vd) && vd > 0) return vd;
  const ad = Number(a?.duration || 0);
  if (Number.isFinite(ad) && ad > 0) return ad;
  return 0;
}

function bufferedEndForPosition(el, pos){
  try{
    const b = el?.buffered;
    if (!b || !b.length) return 0;
    const p = Math.max(0, Number(pos) || 0);
    for (let i=0; i<b.length; i++){
      const start = b.start(i), end = b.end(i);
      if (end >= p && start <= p + 0.25) return Math.max(p, end);
    }
    return p;
  }catch(_){ return Math.max(0, Number(pos) || 0); }
}

function setCustomControlPct(playedPct, bufferPct){
  const els = customControls.els;
  if (!els) return;
  const p = Math.max(0, Math.min(100, playedPct || 0));
  const b = Math.max(0, Math.min(100, bufferPct || 0));
  els.played.style.width = `${p}%`;
  els.buffered.style.width = `${b}%`;
  els.thumb.style.left = `${p}%`;
}

function isFsActive(){
  return !!(document.fullscreenElement || document.webkitFullscreenElement);
}

function hasUserActivation(){
  try{
    const ua = navigator.userActivation;
    return !ua || !!ua.isActive;
  }catch(_){
    return true;
  }
}

function requestPlayerFullscreen({ requireActivation=false, showError=false } = {}){
  const wrap = $("playerFS");
  if (!wrap || isFsActive()) return false;
  if (requireActivation && !hasUserActivation()) return false;
  try{
    let p = null;
    if (wrap.requestFullscreen) p = wrap.requestFullscreen({ navigationUI:"hide" });
    else if (wrap.webkitRequestFullscreen) p = wrap.webkitRequestFullscreen();
    if (p && typeof p.catch === "function"){
      p.catch(()=>{
        if (showError){
          showNotice("全屏需要由点击触发，请再点一次全屏按钮");
          setTimeout(clearNotice, 1800);
        }
      }).finally(()=>{
        adjustFSViewport();
        renderCustomControls(true);
      });
    } else {
      setTimeout(()=>{
        adjustFSViewport();
        renderCustomControls(true);
      }, 0);
    }
    return true;
  }catch(_){
    if (showError){
      showNotice("全屏需要由点击触发，请再点一次全屏按钮");
      setTimeout(clearNotice, 1800);
    }
    renderCustomControls(true);
    return false;
  }
}

function isPipActiveOrPending(){
  return !!(customControls.pipPending || customControls.pipActive || document.pictureInPictureElement);
}

async function handlePiPEntered(){
  customControls.pipPending = false;
  customControls.pipActive = true;
  if (playbackMode === "audio" && isPlayerActive()){
    await switchToVideo();
  }
  stopBgAdvanceGuard();
  stopBgKeepAlive();
  stopStallHeartbeat();
  renderCustomControls(true);
}

async function handlePiPLeft(){
  customControls.pipPending = false;
  customControls.pipActive = false;
  renderCustomControls(true);
  if (!isPlayerActive()) return;
  if (document.visibilityState === "hidden" && BACKGROUND_AUDIO_MODE && !WALLPAPER_MODE && !scrubGuard.active && !_repairInProgress){
    await switchToAudio();
  }
}

function setActiveVolume(value){
  const active = getActiveEl();
  const v = media.v || $("fsVideo");
  const a = media.a || $("bgAudio");
  const vol = Math.max(0, Math.min(1, Number(value) || 0));
  if (vol > 0) customControls.lastVolume = vol;
  try{
    if (active){
      active.volume = vol;
      active.muted = vol <= 0;
    }
    if (playbackMode === "video" && v){
      v.volume = vol;
      v.muted = vol <= 0;
    } else if (playbackMode === "audio" && a){
      a.volume = vol;
      a.muted = vol <= 0;
    }
  }catch(_){}
  renderCustomControls(true);
}

function toggleActiveMute(){
  const active = getActiveEl();
  if (!active) return;
  const currentlyMuted = !!active.muted || Number(active.volume || 0) <= 0;
  if (currentlyMuted){
    setActiveVolume(customControls.lastVolume || 0.8);
  } else {
    customControls.lastVolume = Math.max(0.05, Number(active.volume || 0.8));
    setActiveVolume(0);
  }
}

function setPlaybackRate(rate){
  const r = Math.max(0.25, Math.min(4, Number(rate) || 1));
  const v = media.v || $("fsVideo");
  const a = media.a || $("bgAudio");
  try{ if (v) v.playbackRate = r; }catch(_){}
  try{ if (a) a.playbackRate = r; }catch(_){}
  renderCustomControls(true);
}

function cyclePlaybackRate(){
  const rates = [0.5, 0.75, 1, 1.25, 1.5, 2];
  const active = getActiveEl();
  const cur = Number(active?.playbackRate || 1);
  const next = rates.find(r => r > cur + 0.01) || rates[0];
  setPlaybackRate(next);
}

async function togglePictureInPicture(){
  const v = media.v || $("fsVideo");
  if (!v || !document.pictureInPictureEnabled || typeof v.requestPictureInPicture !== "function") return;
  try{
    if (document.pictureInPictureElement) await document.exitPictureInPicture();
    else {
      customControls.pipPending = true;
      await v.requestPictureInPicture();
      await handlePiPEntered();
    }
  }catch(_){
    customControls.pipPending = false;
  }
  renderCustomControls(true);
}

async function toggleFullscreen(){
  try{
    if (isFsActive()){
      if (document.exitFullscreen) await document.exitFullscreen();
      else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
    } else {
      requestPlayerFullscreen({ showError:true });
    }
  }catch(_){}
  renderCustomControls(true);
}

async function toggleScreenOrientation(){
  if (!IS_MOBILE_UA) return;
  const orientation = screen.orientation;
  if (!orientation || typeof orientation.lock !== "function"){
    showNotice("当前浏览器不支持网页转屏锁定");
    setTimeout(clearNotice, 1800);
    return;
  }
  try{
    if (!isFsActive()) requestPlayerFullscreen({ showError:true });
    const type = String(orientation.type || "");
    const isPortrait = type ? type.includes("portrait") : window.innerHeight >= window.innerWidth;
    const target = isPortrait ? "landscape" : "portrait";
    await orientation.lock(target);
    customControls.orientationLocked = true;
  }catch(_){
    showNotice("转屏失败：浏览器可能要求先进入全屏或不支持该功能");
    setTimeout(clearNotice, 2200);
  }
  renderCustomControls(true);
  wakeOverlay();
}

async function toggleCustomPlayback(){
  const active = getActiveEl();
  if (!active) return;
  try{
    if (active.paused){
      clearUserPaused();
      await active.play();
    } else {
      markUserPaused();
      active.pause();
    }
  }catch(_){
    installUserGestureUnlock();
  }
  renderCustomControls(true);
  wakeOverlay();
}

async function playPreviousInPlaylist(){
  if (!player.ids || player.ids.length <= 1) return;
  if (player.index > 0) await playIndex(player.index - 1, { resumeAt: 0 });
  else if (player.loop) await playIndex(player.ids.length - 1, { resumeAt: 0 });
  renderCustomControls(true);
  wakeOverlay();
}

function renderCustomControls(force=false){
  const els = customControls.els;
  if (!els || !isPlayerActive()) return;
  const now = performance.now();
  if (!force && !customControls.dragging && now - customControls.lastUiAt < 250) return;
  customControls.lastUiAt = now;

  const duration = fixedMediaDuration();
  const { pos } = getLogicalPosDur();
  const shownPos = customControls.dragging ? customControls.previewTime : pos;
  const pct = duration > 0 ? (shownPos / duration) * 100 : 0;

  const v = media.v || $("fsVideo");
  const active = getActiveEl() || v;
  let bufferEnd = bufferedEndForPosition(active, pos);
  if (performance.now() < customControls.seekBufferClampUntil && active?.seeking){
    bufferEnd = pos;
  }
  const bufferPct = duration > 0 ? (bufferEnd / duration) * 100 : 0;

  setCustomControlPct(pct, bufferPct);
  els.cur.textContent = fmtClock(shownPos);
  els.dur.textContent = duration > 0 ? fmtClock(duration) : "--:--";
  const isPlaying = !!(active && !active.paused);
  const hasPlaylistNav = (player.ids || []).length > 1;
  if (els.prev && els.next){
    els.prev.hidden = !hasPlaylistNav;
    els.next.hidden = !hasPlaylistNav;
    els.prev.disabled = hasPlaylistNav && !player.loop && player.index <= 0;
    els.next.disabled = hasPlaylistNav && !player.loop && player.index >= player.ids.length - 1;
  }
  els.play.classList.toggle("playing", isPlaying);
  setCpcIcon(els.play, isPlaying ? "pause" : "play");
  els.play.setAttribute("aria-label", isPlaying ? "暂停" : "播放");
  if (els.centerPlay){
    els.centerPlay.classList.toggle("playing", isPlaying);
    els.centerPlay.classList.toggle("paused", !isPlaying);
    setCpcIcon(els.centerPlay, isPlaying ? "pause" : "play");
    els.centerPlay.setAttribute("aria-label", isPlaying ? "暂停" : "播放");
  }
  if (els.mute && active){
    const vol = Math.max(0, Math.min(1, Number(active.volume || 0)));
    const muted = !!active.muted || vol <= 0;
    els.mute.classList.toggle("muted", muted);
    setCpcIcon(els.mute, muted ? "mute" : "volume");
    els.mute.setAttribute("aria-label", muted ? "解除静音" : "静音");
    els.volume.value = String(Math.round((muted ? 0 : vol) * 100));
  }
  if (els.rate && active){
    const rate = Number(active.playbackRate || 1);
    els.rate.textContent = `${Number.isInteger(rate) ? rate.toFixed(0) : rate.toFixed(2).replace(/0$/,"")}x`;
  }
  if (els.pip){
    const pipSupported = !!(document.pictureInPictureEnabled && v && typeof v.requestPictureInPicture === "function");
    els.pip.disabled = !pipSupported;
    els.pip.classList.toggle("active", !!document.pictureInPictureElement);
  }
  if (els.fullscreen){
    const fs = isFsActive();
    els.fullscreen.classList.toggle("active", fs);
    setCpcIcon(els.fullscreen, fs ? "fullscreenExit" : "fullscreen");
    els.fullscreen.setAttribute("aria-label", fs ? "退出全屏" : "全屏");
  }
  if (els.rotate){
    els.rotate.hidden = !IS_MOBILE_UA;
  }
  els.root.classList.toggle("dragging", customControls.dragging);
}

function seekFromCustomControls(clientX){
  const els = customControls.els;
  const duration = fixedMediaDuration();
  if (!els || duration <= 0) return 0;
  const rect = els.track.getBoundingClientRect();
  const frac = rect.width > 0 ? Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)) : 0;
  const target = frac * duration;
  customControls.previewTime = target;
  const bufferEnd = bufferedEndForPosition(getActiveEl() || media.v || $("fsVideo"), target);
  const bufferPct = duration > 0 ? (bufferEnd / duration) * 100 : 0;
  setCustomControlPct(frac * 100, bufferPct);
  els.cur.textContent = fmtClock(target);
  return target;
}

function commitCustomSeek(target){
  const duration = fixedMediaDuration();
  if (!Number.isFinite(target) || duration <= 0) return;
  const t = Math.max(0, Math.min(duration - 0.05, target));
  beginScrubGuard();
  customControls.seekBufferClampUntil = performance.now() + 1500;
  try{
    if (playbackMode === "audio"){
      const a = media.a || $("bgAudio");
      if (a) a.currentTime = Math.max(0, t + (audioBias || 0));
      const v = media.v || $("fsVideo");
      if (v) v.currentTime = t;
    } else {
      const v = media.v || $("fsVideo");
      if (v) v.currentTime = t;
      const a = media.a || $("bgAudio");
      if (a && !a.paused) a.currentTime = Math.max(0, t + (audioBias || 0));
    }
  }catch(_){}
  endScrubGuardSoon();
  updatePositionState();
  renderCustomControls(true);
}

function ensureCustomPlayerControls(){
  if (customControls.els) return customControls.els;
  const overlay = $("overlay");
  if (!overlay) return null;
  const root = document.createElement("div");
  root.id = "customPlayerControls";
  root.className = "custom-player-controls";
  root.innerHTML = `
    <button class="cpc-btn cpc-prev" type="button" aria-label="上一曲" hidden>${cpcIcon("previous")}</button>
    <button class="cpc-play" type="button" aria-label="播放">${cpcIcon("play")}</button>
    <button class="cpc-btn cpc-next" type="button" aria-label="下一曲" hidden>${cpcIcon("next")}</button>
    <div class="cpc-row-time">
      <div class="cpc-time cpc-current">0:00</div>
      <div class="cpc-seek" role="slider" aria-label="播放进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" tabindex="0">
        <div class="cpc-track">
          <div class="cpc-buffered"></div>
          <div class="cpc-played"></div>
          <div class="cpc-thumb"></div>
        </div>
      </div>
      <div class="cpc-time cpc-duration">--:--</div>
    </div>
    <button class="cpc-btn cpc-mute" type="button" aria-label="静音">${cpcIcon("volume")}</button>
    <input class="cpc-volume" type="range" min="0" max="100" value="80" aria-label="音量">
    <button class="cpc-btn cpc-rate" type="button" aria-label="倍速">1x</button>
    <button class="cpc-btn cpc-pip" type="button" aria-label="画中画">${cpcIcon("pip")}</button>
    <button class="cpc-btn cpc-rotate" type="button" aria-label="切换横竖屏" hidden>${cpcIcon("rotate")}</button>
    <button class="cpc-btn cpc-fullscreen" type="button" aria-label="全屏">${cpcIcon("fullscreen")}</button>
  `;
  const centerPlay = document.createElement("button");
  centerPlay.className = "cpc-center-play paused";
  centerPlay.type = "button";
  centerPlay.setAttribute("aria-label", "播放");
  centerPlay.innerHTML = cpcIcon("play");
  overlay.appendChild(centerPlay);
  overlay.appendChild(root);
  const els = customControls.els = {
    root,
    centerPlay,
    prev: root.querySelector(".cpc-prev"),
    play: root.querySelector(".cpc-play"),
    next: root.querySelector(".cpc-next"),
    cur: root.querySelector(".cpc-current"),
    dur: root.querySelector(".cpc-duration"),
    seek: root.querySelector(".cpc-seek"),
    track: root.querySelector(".cpc-track"),
    buffered: root.querySelector(".cpc-buffered"),
    played: root.querySelector(".cpc-played"),
    thumb: root.querySelector(".cpc-thumb"),
    mute: root.querySelector(".cpc-mute"),
    volume: root.querySelector(".cpc-volume"),
    rate: root.querySelector(".cpc-rate"),
    pip: root.querySelector(".cpc-pip"),
    rotate: root.querySelector(".cpc-rotate"),
    fullscreen: root.querySelector(".cpc-fullscreen"),
  };

  els.prev.onclick = async (ev)=>{
    ev.preventDefault(); ev.stopPropagation();
    await playPreviousInPlaylist();
  };
  els.play.onclick = async (ev)=>{
    ev.preventDefault(); ev.stopPropagation();
    await toggleCustomPlayback();
  };
  els.next.onclick = async (ev)=>{
    ev.preventDefault(); ev.stopPropagation();
    await nextInPlaylist();
    renderCustomControls(true);
    wakeOverlay();
  };
  els.centerPlay.onclick = async (ev)=>{
    ev.preventDefault(); ev.stopPropagation();
    await toggleCustomPlayback();
  };
  els.mute.onclick = (ev)=>{
    ev.preventDefault(); ev.stopPropagation();
    toggleActiveMute();
    wakeOverlay();
  };
  els.volume.addEventListener("input", (ev)=>{
    ev.stopPropagation();
    setActiveVolume(Number(ev.currentTarget.value || 0) / 100);
    wakeOverlay();
  });
  const stopVolumePointer = (ev)=>{ ev.stopPropagation(); wakeOverlay(); };
  ["pointerdown","pointermove","pointerup","pointercancel","touchstart","touchmove","touchend","mousedown","mousemove","mouseup","click"].forEach((type)=>{
    els.volume.addEventListener(type, stopVolumePointer, { passive:true });
  });
  els.rate.onclick = (ev)=>{
    ev.preventDefault(); ev.stopPropagation();
    cyclePlaybackRate();
    wakeOverlay();
  };
  els.pip.onclick = (ev)=>{
    ev.preventDefault(); ev.stopPropagation();
    togglePictureInPicture();
    wakeOverlay();
  };
  els.rotate.onclick = (ev)=>{
    ev.preventDefault(); ev.stopPropagation();
    toggleScreenOrientation();
  };
  els.fullscreen.onclick = (ev)=>{
    ev.preventDefault(); ev.stopPropagation();
    toggleFullscreen();
    wakeOverlay();
  };
  if (!customControls.docEventsInstalled){
    customControls.docEventsInstalled = true;
    document.addEventListener("fullscreenchange", ()=> renderCustomControls(true));
    document.addEventListener("webkitfullscreenchange", ()=> renderCustomControls(true));
    document.addEventListener("enterpictureinpicture", ()=>{ handlePiPEntered(); }, true);
    document.addEventListener("leavepictureinpicture", ()=>{ handlePiPLeft(); }, true);
  }

  const onDown = (ev)=>{
    ev.preventDefault(); ev.stopPropagation();
    wakeOverlay();
    customControls.dragging = true;
    beginScrubGuard();
    const target = seekFromCustomControls(ev.clientX);
    try{ els.seek.setPointerCapture(ev.pointerId); }catch(_){}
    customControls.previewTime = target;
    renderCustomControls(true);
  };
  const onMove = (ev)=>{
    if (!customControls.dragging) return;
    ev.preventDefault(); ev.stopPropagation();
    customControls.previewTime = seekFromCustomControls(ev.clientX);
  };
  const onUp = (ev)=>{
    if (!customControls.dragging) return;
    ev.preventDefault(); ev.stopPropagation();
    const target = seekFromCustomControls(ev.clientX);
    customControls.dragging = false;
    commitCustomSeek(target);
    try{ els.seek.releasePointerCapture(ev.pointerId); }catch(_){}
  };
  els.seek.addEventListener("pointerdown", onDown);
  els.seek.addEventListener("pointermove", onMove);
  els.seek.addEventListener("pointerup", onUp);
  els.seek.addEventListener("pointercancel", onUp);
  els.seek.addEventListener("keydown", (ev)=>{
    const duration = fixedMediaDuration();
    if (duration <= 0) return;
    const { pos } = getLogicalPosDur();
    let target = null;
    if (ev.key === "ArrowLeft") target = pos - 10;
    else if (ev.key === "ArrowRight") target = pos + 10;
    else if (ev.key === "Home") target = 0;
    else if (ev.key === "End") target = duration - 0.05;
    if (target !== null){
      ev.preventDefault(); ev.stopPropagation();
      commitCustomSeek(target);
      wakeOverlay();
    }
  });
  return els;
}

function startCustomControlsTicker(){
  ensureCustomPlayerControls();
  if (customControls.timer) clearInterval(customControls.timer);
  customControls.timer = setInterval(()=>renderCustomControls(false), 250);
  renderCustomControls(true);
}

function stopCustomControlsTicker(){
  if (customControls.timer){ clearInterval(customControls.timer); customControls.timer = null; }
  customControls.dragging = false;
}

function installCustomControlKeys(){
  if (customControls.keysInstalled) return;
  customControls.keysInstalled = true;
  window.addEventListener("keydown", async (ev)=>{
    if (!isPlayerActive()) return;
    const tag = String(ev.target?.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select" || ev.target?.isContentEditable) return;
    if (ev.key === " " || ev.key === "k" || ev.key === "K"){
      ev.preventDefault();
      await toggleCustomPlayback();
      return;
    }
    if (ev.key === "ArrowLeft" || ev.key === "ArrowRight"){
      ev.preventDefault();
      const { pos } = getLogicalPosDur();
      commitCustomSeek(pos + (ev.key === "ArrowRight" ? 10 : -10));
      wakeOverlay();
    }
  });
}

document.addEventListener("dragstart", e => e.preventDefault());
const sleep = (ms)=> new Promise(r=>setTimeout(r,ms));
function chunk(arr, size){ const out=[]; for(let i=0;i<arr.length;i+=size) out.push(arr.slice(i, i+size)); return out; }
function showNotice(msg){ const n=$("notice"); if(!n) return; n.style.display="block"; n.innerHTML="ℹ︎ " + msg; }
function clearNotice(){ const n=$("notice"); if(!n) return; n.style.display="none"; n.textContent=""; }

// 旧版本曾用 Service Worker 缓存媒体。HLS 方案不再需要 SW，这里只做静默清理：
// - 不注册 /sw.js
// - 如果浏览器里残留旧注册，尝试注销并删除旧 Cache Storage
function cleanupLegacyServiceWorker(){
  try{
    if ("serviceWorker" in navigator && navigator.serviceWorker.getRegistrations){
      navigator.serviceWorker.getRegistrations()
        .then(regs => regs.forEach(reg => { try{ reg.unregister(); }catch(_){} }))
        .catch(()=>{});
    }
    if (window.caches && caches.keys){
      caches.keys()
        .then(keys => keys
          .filter(k => /^wwui-(preview|media)-/i.test(k))
          .forEach(k => { try{ caches.delete(k); }catch(_){} }))
        .catch(()=>{});
    }
  }catch(_){}
}
cleanupLegacyServiceWorker();

// 兼容旧调用点：媒体修复后已靠 URL cacheBust / HLS segment 版本规避旧缓存。
function notifySWMediaInvalidate(){}
function _escHtml(s){
  // 注意：部分安卓 WebView/旧浏览器没有 String.prototype.replaceAll，会导致这里直接抛错，
  // 进而出现“点了修复完全没提示”的现象。用正则 replace 保守兼容。
  const str = (s === null || s === undefined) ? "" : String(s);
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
function showNoticeProgress(title, sub){
  try{
    const n = $("notice"); if (!n) return null;
    const t = _escHtml(title || "正在处理…");
    const s = _escHtml(sub || "");
    n.style.display = "block";
    n.innerHTML = `
      <div class="notice-wrap">
        <div class="notice-line"><span>🛠 ${t}</span><span class="notice-pct" id="noticePct"></span></div>
        <div class="notice-sub" id="noticeSub">${s}</div>
        <div class="pbar"><div class="bar indeterminate" id="noticeBar"></div></div>
      </div>
    `.trim();
    return {
      root: n,
      subEl: document.getElementById("noticeSub"),
      pctEl: document.getElementById("noticePct"),
      barEl: document.getElementById("noticeBar"),
    };
  }catch(e){
    // 兜底：任何渲染异常都退回到纯文本 notice，避免“完全无提示”
    try{ showNotice(`正在处理…（提示条渲染失败：${String(e||"error")}）`); }catch(_){}
    return null;
  }
}
function setNoticeSubText(text){
  const el = document.getElementById("noticeSub");
  if (el) el.textContent = String(text ?? "");
}
function setNoticePct(pct){
  const p = Math.max(0, Math.min(100, Number(pct)));
  const bar = document.getElementById("noticeBar");
  const pctEl = document.getElementById("noticePct");
  if (bar){
    bar.classList.remove("indeterminate");
    bar.style.width = p.toFixed(0) + "%";
  }
  if (pctEl) pctEl.textContent = isFinite(p) ? (p.toFixed(0) + "%") : "";
}
function fmtSize(sz){ if (sz>=1<<30) return (sz/(1<<30)).toFixed(1)+" GB"; if (sz>=1<<20) return (sz/(1<<20)).toFixed(1)+" MB"; if (sz>=1<<10) return (sz/(1<<10)).toFixed(1)+" KB"; return sz+" B"; }
function fmtDate(ts){ return new Date(ts*1000).toLocaleString(); }
function tileMetaHtml(v){
  return `<span class="meta-date">${_escHtml(fmtDate(v.mtime))}</span><span class="meta-sep">·</span><span class="meta-size">${_escHtml(fmtSize(v.size))}</span>`;
}
function tileAuthorHtml(v){
  return _escHtml(String(v?.author || "").trim());
}
function tileSelectionInside(tileEl){
  if (!tileEl) return false;
  const sel = window.getSelection && window.getSelection();
  if (!sel || sel.isCollapsed) return false;
  const anchor = sel.anchorNode;
  const focus = sel.focusNode;
  return (anchor && tileEl.contains(anchor)) || (focus && tileEl.contains(focus));
}
function tileTextFieldFromNode(node){
  if (!node) return null;
  const el = node.nodeType === 3 ? node.parentElement : node;
  return el && el.closest ? el.closest(".tile .title, .tile .author") : null;
}
function tileTextSelectionActive(){
  const sel = window.getSelection && window.getSelection();
  if (!sel || sel.isCollapsed) return false;
  return !!(tileTextFieldFromNode(sel.anchorNode) || tileTextFieldFromNode(sel.focusNode));
}
const _tileTextPick = { tileEl: null, suppressClick: false, dragging: false, picking: false, startX: 0, startY: 0 };
function shouldIgnoreTileClick(t){
  if (!t?.el) return false;
  if (_tileTextPick.suppressClick && _tileTextPick.tileEl === t.el) return true;
  if (!tileTextSelectionActive()) return false;
  const sel = window.getSelection && window.getSelection();
  if (!sel) return false;
  const anchorTile = tileTextFieldFromNode(sel.anchorNode)?.closest(".tile");
  const focusTile = tileTextFieldFromNode(sel.focusNode)?.closest(".tile");
  return anchorTile === t.el || focusTile === t.el;
}
function clearTileTextSelection(){
  try {
    const sel = window.getSelection && window.getSelection();
    if (sel) sel.removeAllRanges();
  } catch(_){}
  clearTileTextPickSuppress();
  _tileTextPick.picking = false;
  _tileTextPick.dragging = false;
}
function clearTileTextPickSuppress(){
  _tileTextPick.suppressClick = false;
  _tileTextPick.tileEl = null;
}
function installTileTextPickGuard(gridEl){
  if (!gridEl || gridEl._textPickBound) return;
  gridEl._textPickBound = true;

  const clearSelectionIfOutsideText = (ev)=>{
    if (ev.button !== 0) return;
    if (ev.target.closest(".tile .title, .tile .author")) return;
    if (tileTextSelectionActive()) clearTileTextSelection();
  };

  if (!document._tileTextPickDocBound) {
    document._tileTextPickDocBound = true;
    document.addEventListener("mousedown", clearSelectionIfOutsideText, true);
  }

  gridEl.addEventListener("mousedown", (ev)=>{
    if (ev.button !== 0) return;
    const textEl = ev.target.closest(".tile .title, .tile .author");
    if (!textEl) return;
    const tileEl = textEl.closest(".tile");
    if (!tileEl) return;
    _tileTextPick.picking = true;
    _tileTextPick.dragging = false;
    _tileTextPick.suppressClick = false;
    _tileTextPick.tileEl = tileEl;
    _tileTextPick.startX = ev.clientX;
    _tileTextPick.startY = ev.clientY;
  }, true);
  gridEl.addEventListener("mousemove", (ev)=>{
    if (!_tileTextPick.picking) return;
    if (Math.abs(ev.clientX - _tileTextPick.startX) > 2 || Math.abs(ev.clientY - _tileTextPick.startY) > 2) {
      _tileTextPick.dragging = true;
    }
  }, true);
  gridEl.addEventListener("mouseup", ()=>{
    if (!_tileTextPick.picking) return;
    const tileEl = _tileTextPick.tileEl;
    const dragged = _tileTextPick.dragging;
    _tileTextPick.picking = false;
    _tileTextPick.dragging = false;
    if (dragged || tileSelectionInside(tileEl)) {
      _tileTextPick.suppressClick = true;
      _tileTextPick.tileEl = tileEl;
    }
  }, true);
}
function ratingBadgeInfo(rating){
  const raw = String(rating || "").trim();
  const low = raw.toLowerCase();
  if (low.includes("adult") || low.includes("mature") || low.includes("成人") || low === "18+" || low.includes("r18")) return { label:"成人", cls:"adult" };
  if (low.includes("sensitive") || low.includes("questionable") || low.includes("partial") || low.includes("较敏感") || low.includes("敏感")) return { label:"较敏感", cls:"sensitive" };
  return { label:"全年龄", cls:"safe" };
}
function ratingBadgeHtml(rating){
  const info = ratingBadgeInfo(rating);
  return `<span class="rating-badge ${info.cls}">${info.label}</span>`;
}
function isSelectableTile(t){ return !!t && (t.type === "video" || t.type === "folder"); }
function isSel(t){ if (!isSelectableTile(t)) return false; return t.type==="video" ? state.selV.has(t.vid) : state.selF.has(t.path); }
function setSel(t,on){
  if (!isSelectableTile(t)) return;
  if(t.type==="video"){on?state.selV.add(t.vid):state.selV.delete(t.vid);} else {on?state.selF.add(t.path):state.selF.delete(t.path);}
  t.el.classList.toggle("selected",on);
}
function clearSel(){ state.tiles.forEach(t=>t.el.classList.remove("selected")); state.selV.clear(); state.selF.clear(); }
function hasSelectionAnchor(){
  return state.lastIdx != null || state.selV.size > 0 || state.selF.size > 0;
}
function shouldRangeSelect(ev){
  if (ev?.shiftKey || shiftKeyDown) return true;
  return hasSelectionAnchor() && (Date.now() - lastShiftReleasedAt) <= SHIFT_RANGE_GRACE_MS;
}
window.addEventListener("keydown", (ev)=>{
  if (ev.key === "Shift") shiftKeyDown = true;
}, { passive:true });
window.addEventListener("keyup", (ev)=>{
  if (ev.key === "Shift") {
    shiftKeyDown = false;
    lastShiftReleasedAt = Date.now();
  }
}, { passive:true });

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
async function apiMoveDetailed(payload, dest_path){
  const p = normalizeMovePayload(payload);
  const r = await fetch("/api/move", {
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body: JSON.stringify({ ids: p.ids, folder_paths: p.folderPaths, dest_path: dest_path || "/" })
  }).catch(()=>null);
  if (!r || !r.ok) return { ok: false, moved: 0, moved_folders: 0 };
  const j = await r.json().catch(()=>({}));
  return {
    ok: true,
    moved: Number(j.moved) || 0,
    moved_folders: Number(j.moved_folders) || 0,
  };
}
function moveResultOk(payload, result){
  const idsOk = !payload.ids.length || result.moved > 0;
  const foldersOk = !payload.folderPaths.length || result.moved_folders > 0;
  return idsOk && foldersOk;
}
async function apiMove(payload, dest_path){
  const r = await apiMoveDetailed(payload, dest_path);
  return r.ok && moveResultOk(normalizeMovePayload(payload), r);
}

/* ====================== 视频修复（针对“固定秒数卡住”） ====================== */
async function apiRepairVideo(id, mode="reencode"){
  try{
    const qs = new URLSearchParams({ mode: String(mode||"reencode") });
    const r = await fetch(`/api/repair/${encodeURIComponent(String(id))}?${qs.toString()}`, { method:"POST" });
    const j = await r.json().catch(()=>({}));
    return { ok: !!(r && r.ok), data: j };
  }catch(e){
    return { ok:false, data: { error: String(e||"network-error") } };
  }
}
// ★ 全局标记：修复进行中时阻止自动切换到 audio 模式
let _repairInProgress = false;
// ★ 记录已修复的视频 ID，下次播放时强制 cacheBust
const _repairedVideos = new Set();

async function repairVideoAndReload(id, mode="reencode"){
  if (!id || String(id) === "undefined" || String(id) === "null"){
    showNotice("修复失败：无效视频ID（可能是前端状态异常或脚本报错导致）");
    setTimeout(clearNotice, 3500);
    return;
  }
  const v = media.v || $("fsVideo");
  const resumeAt = Number.isFinite(v?.currentTime) ? v.currentTime : 0;
  const title = (mode==="copy" ? "无损重封装修复中…" : "强制转码修复中（更慢但更稳）…");
  const t0 = Date.now();
  _repairInProgress = true;  // ★ 标记修复开始
  showNoticeProgress(title, "已耗时 0s");
  // "进度条"这里做成不定进度 + 实时耗时（不改后端接口也能看见正在进行）
  const tick = setInterval(()=> {
    const sec = Math.max(0, Math.floor((Date.now()-t0)/1000));
    setNoticeSubText(`已耗时 ${sec}s（请勿关闭页面）`);
  }, 500);
  let res = null;
  try{
    res = await apiRepairVideo(id, mode);
  } finally {
    clearInterval(tick);
  }
  if (!res.ok){
    const err = (res.data && res.data.error) ? String(res.data.error) : "unknown";
    const sec = Math.max(0, Math.round((Date.now()-t0)/1000));
    showNotice(`修复失败：${_escHtml(err)}（耗时 ${sec}s）`);
    setTimeout(clearNotice, 3000);
    return;
  }
  setNoticePct(100);
  const m = (res.data && res.data.mode) ? String(res.data.mode) : String(mode||"unknown");
  const before = (res.data && res.data.before!=null) ? String(res.data.before) : "";
  const after  = (res.data && res.data.after!=null) ? String(res.data.after) : "";
  const sec = Math.max(0, Math.round((Date.now()-t0)/1000));
  
  // ★ 标记这个视频已修复（下次播放时强制 cacheBust）
  _repairedVideos.add(String(id));
  // ★ 让 SW 把媒体缓存丢掉，避免重新播放时仍命中旧字节
  notifySWMediaInvalidate();

  showNotice(`修复完成（${_escHtml(m)}${before&&after?`，${_escHtml(before)}→${_escHtml(after)}`:""}，耗时 ${sec}s）。下次播放时将使用修复后的文件。`);
  setTimeout(clearNotice, 4000);
  _repairInProgress = false;  // ★ 标记修复结束
  
  // ★ 修复完成后不自动播放，只是清理浏览器/音频缓存，等用户下次手动播放时才使用修复后的文件
  // 清空当前音频元素（避免缓存旧的音频流）
  try{
    const a = media.a || $("bgAudio");
    const v = media.v || $("fsVideo");
    // 清理 audio
    if (a){
      const wasPlaying = !a.paused;
      a.pause();
      a.muted = true;
      a.volume = 0;
      a.removeAttribute("src");
      a.load();
      // 如果之前在播放，提示用户需要重新播放
      if (wasPlaying && isPlayerActive()){
        setTimeout(()=>{
          showNotice("修复已完成。请关闭播放器后重新点击该视频。");
          setTimeout(clearNotice, 3000);
        }, 4100);
      }
    }
    // 清理 video（避免浏览器缓存"无视频流"的判断）
    if (v){
      v.pause();
      v.removeAttribute("src");
      v.load();
    }
  }catch(_){}
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
// ★ 新增：根据所选收集移动载荷（视频 id + 文件夹路径，文件夹不展开）
function collectMovePayload(){
  return {
    ids: Array.from(state.selV).map(String).filter(Boolean),
    folderPaths: Array.from(state.selF).map(String).filter(Boolean),
  };
}
function normalizeMovePayload(arg){
  if (Array.isArray(arg)) return { ids: arg.map(String).filter(Boolean), folderPaths: [] };
  return {
    ids: (arg?.ids || []).map(String).filter(Boolean),
    folderPaths: (arg?.folderPaths || arg?.folder_paths || []).map(String).filter(Boolean),
  };
}
function movePayloadEmpty(payload){
  return !(payload.ids.length || payload.folderPaths.length);
}
function folderDropDestValid(destPath, payload){
  const dest = String(destPath || "/").replace(/\/+$/, "") || "/";
  for (const raw of payload.folderPaths || []){
    const fp = String(raw).replace(/\/+$/, "") || "/";
    if (fp === dest) return false;
    if (dest.startsWith(fp + "/")) return false;
  }
  return true;
}

/* ===================== 移动撤销（双击 Esc） ===================== */
const MOVE_UNDO_ESC_MS = 450;
const MOVE_UNDO_TTL_MS = 10 * 60 * 1000;
let moveUndoState = null;
let moveUndoBusy = false;

function folderPathAfterMove(srcPath, destPath){
  const name = String(srcPath || "").split("/").filter(Boolean).pop();
  if (!name) return String(srcPath || "/");
  const dest = String(destPath || "/").replace(/\/+$/, "") || "/";
  if (dest === "/") return "/" + name;
  return dest + "/" + name;
}
function folderParentPath(path){
  const parts = String(path || "/").split("/").filter(Boolean);
  if (parts.length <= 1) return "/";
  return "/" + parts.slice(0, -1).join("/");
}
function captureMoveUndoRecord(payload, destPath, fromPath){
  return {
    ids: [...payload.ids],
    folderSources: [...payload.folderPaths],
    destPath: destPath || "/",
    fromPath: fromPath || state.path || "/",
    ts: Date.now(),
  };
}
async function undoLastMove(){
  if (moveUndoBusy) return;
  const record = moveUndoState;
  if (!record){
    showNotice("没有可撤销的移动");
    setTimeout(clearNotice, 1600);
    return;
  }
  if (Date.now() - record.ts > MOVE_UNDO_TTL_MS){
    moveUndoState = null;
    showNotice("撤销已过期");
    setTimeout(clearNotice, 1800);
    return;
  }

  moveUndoBusy = true;
  moveUndoState = null;
  primeBusy("正在撤销移动…");
  let ok = true;
  try{
    if (record.ids.length){
      const r = await apiMoveDetailed({ ids: record.ids, folderPaths: [] }, record.fromPath);
      ok = r.ok && r.moved > 0;
    }
    for (const src of record.folderSources){
      const current = folderPathAfterMove(src, record.destPath);
      const backTo = folderParentPath(src);
      const r = await apiMoveDetailed({ ids: [], folderPaths: [current] }, backTo);
      if (!r.ok || r.moved_folders < 1) ok = false;
    }
  }catch(_){
    ok = false;
  }
  hideBusy();
  moveUndoBusy = false;

  if (!ok){
    moveUndoState = record;
    showNotice("撤销失败，请重试");
    setTimeout(clearNotice, 2200);
    return;
  }

  showNotice("已撤销上一次移动");
  setTimeout(clearNotice, 2000);
  await changeContext({});
}
function installMoveUndoHotkey(){
  if (installMoveUndoHotkey._bound) return;
  installMoveUndoHotkey._bound = true;
  let lastEsc = 0;
  window.addEventListener("keydown", (ev)=>{
    if (ev.key !== "Escape") return;
    if (WALLPAPER_MODE) return;
    if (typeof isPlayerActive === "function" && isPlayerActive()) return;
    const tag = String(ev.target?.tagName || "").toUpperCase();
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    if (ev.target?.isContentEditable) return;
    const now = Date.now();
    if (now - lastEsc <= MOVE_UNDO_ESC_MS){
      lastEsc = 0;
      ev.preventDefault();
      ev.stopPropagation();
      void undoLastMove();
    } else {
      lastEsc = now;
    }
  }, { capture: true });
}

async function buildMoveSubmenuEntries(payload){
  const p = normalizeMovePayload(payload);
  if (movePayloadEmpty(p)){
    return [{ text:"（没有可移动的条目）", fn: ()=>{} }];
  }
  const entries = [];
  if (folderDropDestValid("/", p)){
    entries.push({ text:"主页 (/)", fn: async ()=>{ await moveIdsAndRefresh(p, "/"); } });
  }
  const cur = String(state.path || "/").replace(/\/+$/, "") || "/";
  if (cur !== "/"){
    const parts = cur.split("/").filter(Boolean);
    const parentPath = parts.length > 1 ? "/" + parts.slice(0, -1).join("/") : "/";
    if (parentPath !== "/" && folderDropDestValid(parentPath, p)){
      entries.push({
        text: `上一层 (${parentPath})`,
        fn: async ()=>{ await moveIdsAndRefresh(p, parentPath); },
      });
    }
  }
  const tree = flattenFolderTree(await getFoldersMenuTree());
  const MAX = 240;
  for (let i=0;i<tree.length && i<MAX;i++){
    const n = tree[i];
    if (!folderDropDestValid(n.path, p)) continue;
    const indent = "　".repeat(Math.min(10, n.depth||0));
    const label = `${indent}${n.title} (${n.path})`;
    entries.push({ text: label, fn: async ()=>{ await moveIdsAndRefresh(p, n.path); } });
  }
  if (!entries.length){
    return [{ text:"（没有可用的目标位置）", fn: ()=>{} }];
  }
  return entries;
}
function moveSubmenuLoader(getPayload){
  return async ()=>{
    const payload = typeof getPayload === "function" ? getPayload() : getPayload;
    return buildMoveSubmenuEntries(payload);
  };
}
// ★ 新增：根据所选收集视频 ID（可含文件夹→展开，供删除/取消订阅等）
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

async function moveIdsAndRefresh(payloadOrIds, destPath, opts={}){
  const payload = normalizeMovePayload(payloadOrIds);
  if (movePayloadEmpty(payload)){ alert("没有可移动的条目"); return false; }
  if (!folderDropDestValid(destPath, payload)){
    showNotice("无法移动到该位置");
    setTimeout(clearNotice, 1800);
    return false;
  }
  if (moveUndoBusy) return false;
  const undoSnap = opts.skipUndoRecord ? null : captureMoveUndoRecord(payload, destPath, state.path);
  primeBusy("正在移动…");
  const result = await apiMoveDetailed(payload, destPath);
  hideBusy();
  if (!result.ok || !moveResultOk(payload, result)){
    alert("移动失败，请重试");
    return false;
  }
  if (!opts.skipUndoRecord) moveUndoState = undoSnap;
  showNotice(`已移动到：${destPath}（双击 Esc 撤销）`);
  setTimeout(clearNotice, 2800);
  payload.ids.forEach(id=>{ try{ closeWatchFloatPanel(String(id)); }catch(_){} });
  if (payload.folderPaths.length){
    await changeContext({});
  } else if (destPath !== state.path){
    removeTilesByVideoIds(payload.ids);
  }
  clearSel();
  return true;
}

/* ===================== 拖拽到文件夹（等同右键「移动到」） ===================== */
const FOLDER_DROP_ARM_MS = 680;
const FOLDER_DROP_THRESHOLD = 12;
const folderDrop = {
  pending: false,
  active: false,
  pointerId: null,
  startX: 0,
  startY: 0,
  ids: null,
  payload: null,
  idsPreset: null,
  dragSourceTile: null,
  panel: null,
  ghost: null,
  sourcePayload: null,
  armRequired: false,
  targetEl: null,
  targetPath: null,
  armTimer: null,
  armed: false,
  suppressClickUntil: 0,
  _move: null,
  _up: null,
  _cancel: null,
};

function folderDropTileAt(x, y){
  let el = null;
  try{ el = document.elementFromPoint(x, y); }catch(_){}
  if (!el) return null;
  const tileEl = el.closest(".tile.folder, .tile.parent-folder");
  if (!tileEl) return null;
  const t = getTile(tileEl);
  if (!t || (t.type !== "folder" && t.type !== "parent")) return null;
  return t;
}

function folderDropFolderValid(t){
  return !!(t && !state.selF.has(t.path || "/"));
}

function folderDropRemoveMeter(el){
  if (!el) return;
  el.querySelector(".folder-drop-meter")?.remove();
}

function folderDropClearTarget(){
  if (folderDrop.armTimer){
    clearTimeout(folderDrop.armTimer);
    folderDrop.armTimer = null;
  }
  if (folderDrop.targetEl){
    folderDrop.targetEl.classList.remove("folder-drop-hover", "folder-drop-armed");
    folderDropRemoveMeter(folderDrop.targetEl);
  }
  folderDrop.targetEl = null;
  folderDrop.targetPath = null;
  folderDrop.armed = false;
}

function folderDropAddMeter(el){
  folderDropRemoveMeter(el);
  const meter = document.createElement("div");
  meter.className = "folder-drop-meter";
  meter.innerHTML = `<div class="folder-drop-meter-bar"></div><span class="folder-drop-meter-label">悬停放入…</span>`;
  el.appendChild(meter);
}

function folderDropSetTarget(t){
  const path = t.path || "/";
  if (state.selF.has(path)) return;
  folderDrop.targetEl = t.el;
  folderDrop.targetPath = path;
  if (!folderDrop.armRequired){
    folderDrop.armed = true;
    t.el.classList.add("folder-drop-armed");
    return;
  }
  t.el.classList.add("folder-drop-hover");
  folderDropAddMeter(t.el);
  folderDrop.armTimer = setTimeout(()=>{
    if (folderDrop.targetEl !== t.el) return;
    folderDrop.armed = true;
    t.el.classList.remove("folder-drop-hover");
    t.el.classList.add("folder-drop-armed");
    const label = t.el.querySelector(".folder-drop-meter-label");
    if (label) label.textContent = "松手放入 ✓";
  }, FOLDER_DROP_ARM_MS);
}

function folderDropUpdateTarget(x, y){
  const t = folderDropTileAt(x, y);
  const path = t ? (t.path || "/") : null;
  if (folderDrop.targetEl === (t?.el || null) && folderDrop.targetPath === path) return;
  folderDropClearTarget();
  if (!t || !path) return;
  folderDropSetTarget(t);
}

function folderDropFindVideoTile(id){
  return (state.tiles || []).find(t => t && t.type === "video" && String(t.vid) === String(id)) || null;
}

function folderDropPreviewCardForId(id, stackIndex){
  const card = document.createElement("div");
  card.className = "folder-drop-ghost-card";
  card.style.setProperty("--stack-i", String(stackIndex));

  const tile = folderDropFindVideoTile(id);
  if (tile?.el){
    const thumbImg = tile.el.querySelector(".thumb img");
    if (thumbImg?.src){
      const img = document.createElement("img");
      img.src = thumbImg.src;
      img.alt = "";
      img.draggable = false;
      card.appendChild(img);
      return card;
    }
  }

  const panel = folderDrop.panel;
  if (panel && String(panel.dataset.vid || "") === String(id)){
    const video = panel.querySelector("video.watch-float-video");
    if (video && video.videoWidth > 0 && video.videoHeight > 0){
      try{
        const c = document.createElement("canvas");
        const aspect = video.videoWidth / video.videoHeight;
        c.height = 88;
        c.width = Math.max(48, Math.round(c.height * aspect));
        c.getContext("2d")?.drawImage(video, 0, 0, c.width, c.height);
        const img = document.createElement("img");
        img.src = c.toDataURL("image/jpeg", 0.72);
        img.alt = "";
        img.draggable = false;
        card.appendChild(img);
        return card;
      }catch(_){}
    }
    const title = panel.querySelector(".watch-float-title")?.textContent?.trim();
    card.innerHTML = `<div class="folder-drop-ghost-float-label">${_escHtml(title || "视频")}</div>`;
    return card;
  }

  const title = tile?.title || `视频 ${id}`;
  card.innerHTML = `<div class="folder-drop-ghost-float-label">${_escHtml(title)}</div>`;
  return card;
}

function folderDropSetSourceDim(payload, on){
  const p = normalizeMovePayload(payload);
  const set = new Set(p.ids);
  for (const t of state.tiles || []){
    if (t?.type === "video" && set.has(String(t.vid))){
      t.el?.classList.toggle("folder-drop-source-dim", on);
    }
    if (t?.type === "folder" && p.folderPaths.includes(String(t.path))){
      t.el?.classList.toggle("folder-drop-source-dim", on);
    }
  }
  if (folderDrop.panel){
    const pid = String(folderDrop.panel.dataset.vid || "");
    if (!on || set.has(pid)){
      folderDrop.panel.classList.toggle("folder-drop-source-dim", on);
    }
  }
}

function folderDropPreviewCardForFolder(path, stackIndex){
  const card = document.createElement("div");
  card.className = "folder-drop-ghost-card";
  card.style.setProperty("--stack-i", String(stackIndex));
  const tile = (state.tiles || []).find(t => t.type === "folder" && t.path === path);
  const title = tile?.title || String(path).split("/").filter(Boolean).pop() || "文件夹";
  card.innerHTML = `<div class="folder-drop-ghost-float-label">📁 ${_escHtml(title)}</div>`;
  return card;
}

function folderDropCreateGhost(payload, opts={}){
  folderDrop.ghost?.remove();
  const p = normalizeMovePayload(payload);
  const folderPaths = [...new Set(p.folderPaths)];
  const ids = [...new Set(p.ids)];
  const stackItems = [
    ...folderPaths.map(path => ({ kind:"folder", path })),
    ...ids.map(id => ({ kind:"video", id })),
  ];
  const count = stackItems.length;
  folderDrop.sourcePayload = { ids, folderPaths };

  const g = document.createElement("div");
  g.className = "folder-drop-ghost";
  const inner = document.createElement("div");
  inner.className = "folder-drop-ghost-inner";

  const stack = document.createElement("div");
  stack.className = "folder-drop-ghost-stack";
  const stackCount = Math.min(3, count);
  for (let i = 0; i < stackCount; i++){
    const item = stackItems[i];
    stack.appendChild(item.kind === "folder"
      ? folderDropPreviewCardForFolder(item.path, i)
      : folderDropPreviewCardForId(item.id, i));
  }
  inner.appendChild(stack);

  if (count > 1){
    const badge = document.createElement("span");
    badge.className = "folder-drop-ghost-badge";
    badge.textContent = String(count);
    inner.appendChild(badge);
  }

  const caption = document.createElement("span");
  caption.className = "folder-drop-ghost-caption";
  if (count > 1){
    caption.textContent = `移动 ${count} 项`;
  } else if (stackItems[0]?.kind === "folder"){
    const tile = (state.tiles || []).find(t => t.type === "folder" && t.path === stackItems[0].path);
    caption.textContent = tile?.title || "文件夹";
  } else {
    const primary = folderDropFindVideoTile(stackItems[0]?.id);
    caption.textContent = primary?.title || folderDrop.panel?.querySelector(".watch-float-title")?.textContent?.trim() || "移动";
  }
  inner.appendChild(caption);

  g.appendChild(inner);
  document.body.appendChild(g);
  folderDrop.ghost = g;
  if (!opts.skipSourceDim) folderDropSetSourceDim({ ids, folderPaths }, true);
}

function folderDropMoveGhost(x, y){
  if (!folderDrop.ghost) return;
  folderDrop.ghost.style.transform = `translate(${x + 14}px, ${y + 12}px)`;
}

function folderDropCleanupListeners(){
  if (folderDrop._move) document.removeEventListener("pointermove", folderDrop._move);
  if (folderDrop._up) document.removeEventListener("pointerup", folderDrop._up);
  if (folderDrop._cancel) document.removeEventListener("pointercancel", folderDrop._cancel);
  folderDrop._move = folderDrop._up = folderDrop._cancel = null;
}

function folderDropCancelVisual(){
  folderDropClearTarget();
  if (folderDrop.sourcePayload) folderDropSetSourceDim(folderDrop.sourcePayload, false);
  folderDrop.sourcePayload = null;
  folderDrop.ghost?.remove();
  folderDrop.ghost = null;
  folderDrop.panel?.classList.remove("folder-drop-dragging", "folder-drop-source-dim");
  document.body.classList.remove("folder-drop-active");
}

function folderDropReset(){
  folderDropCleanupListeners();
  folderDropCancelVisual();
  folderDrop.pending = false;
  folderDrop.active = false;
  folderDrop.pointerId = null;
  folderDrop.ids = null;
  folderDrop.payload = null;
  folderDrop.idsPreset = null;
  folderDrop.dragSourceTile = null;
  folderDrop.panel = null;
  folderDrop.armRequired = false;
}

async function folderDropResolvePayload(){
  if (folderDrop.idsPreset?.length){
    return { ids: folderDrop.idsPreset.map(String).filter(Boolean), folderPaths: [] };
  }
  const src = folderDrop.dragSourceTile;
  if (src?.type === "folder"){
    return { ids: [], folderPaths: [String(src.path)] };
  }
  if (src?.type === "video"){
    return { ids: [String(src.vid)], folderPaths: [] };
  }
  return collectMovePayload();
}

async function folderDropActivate(ev){
  if (folderDrop.active) return;
  folderDrop.pending = false;
  folderDrop.active = true;
  folderDrop.suppressClickUntil = Date.now() + 400;
  document.body.classList.add("folder-drop-active");
  folderDrop.panel?.classList.add("folder-drop-dragging");

  const payload = await folderDropResolvePayload();
  if (movePayloadEmpty(payload)){
    folderDropReset();
    return;
  }
  folderDrop.payload = payload;
  folderDropCreateGhost(payload);
  try{ document.body.setPointerCapture(ev.pointerId); }catch(_){}
  folderDropMoveGhost(ev.clientX, ev.clientY);
}

async function folderDropFinish(x, y){
  const t = folderDropTileAt(x, y);
  const path = t ? (t.path || "/") : null;
  const payload = folderDrop.payload || normalizeMovePayload([]);
  const canDrop = folderDrop.armed || !folderDrop.armRequired;

  if (canDrop && path && !movePayloadEmpty(payload) && folderDrop.targetPath === path && folderDropDestValid(path, payload)){
    t.el.classList.add("folder-drop-success");
    setTimeout(()=> t.el.classList.remove("folder-drop-success"), 500);
    await moveIdsAndRefresh(payload, path);
  } else if (folderDrop.active && path && folderDrop.armRequired && !folderDrop.armed){
    showNotice("悬停文件夹约 0.7 秒后再松手");
    setTimeout(clearNotice, 1800);
  }
  folderDropReset();
}

function folderDropBeginPending(ev, opts={}){
  if (WALLPAPER_MODE) return;
  if (folderDrop.pending || folderDrop.active) return;
  if (state.dragging) return;

  folderDrop.pending = true;
  folderDrop.pointerId = ev.pointerId;
  folderDrop.startX = ev.clientX;
  folderDrop.startY = ev.clientY;
  folderDrop.idsPreset = opts.ids || null;
  folderDrop.dragSourceTile = opts.dragSourceTile || null;
  folderDrop.panel = opts.panel || null;
  folderDrop.armRequired = !!opts.armRequired;

  const onMove = (e)=>{
    if (!folderDrop.pending && !folderDrop.active) return;
    if (e.pointerId !== folderDrop.pointerId) return;
    const dx = e.clientX - folderDrop.startX;
    const dy = e.clientY - folderDrop.startY;
    if (!folderDrop.active){
      if (Math.hypot(dx, dy) < FOLDER_DROP_THRESHOLD) return;
      folderDropActivate(e);
      return;
    }
    if (folderDrop.active){
      e.preventDefault();
      folderDropMoveGhost(e.clientX, e.clientY);
      folderDropUpdateTarget(e.clientX, e.clientY);
    }
  };

  const onUp = (e)=>{
    if (e.pointerId !== folderDrop.pointerId) return;
    if (folderDrop.active) e.preventDefault();
    const wasActive = folderDrop.active;
    const x = e.clientX, y = e.clientY;
    folderDropCleanupListeners();
    if (wasActive) folderDropFinish(x, y);
    else folderDropReset();
  };

  const onCancel = (e)=>{
    if (e.pointerId !== folderDrop.pointerId) return;
    folderDropReset();
  };

  folderDrop._move = onMove;
  folderDrop._up = onUp;
  folderDrop._cancel = onCancel;
  document.addEventListener("pointermove", onMove, { passive:false });
  document.addEventListener("pointerup", onUp);
  document.addEventListener("pointercancel", onCancel);
}

function onFolderDropTilePointerDown(ev){
  if (ev.button !== 0) return;
  const thumbEl = ev.target.closest(".tile .thumb");
  if (!thumbEl) return;
  const tileEl = thumbEl.closest(".tile");
  if (!tileEl) return;
  const t = getTile(tileEl);
  if (!t || (t.type !== "video" && t.type !== "folder")) return;

  const totalSel = state.selV.size + state.selF.size;
  const multiSel = isSel(t) && totalSel > 1;
  if (multiSel){
    folderDropBeginPending(ev, { armRequired: false });
    return;
  }
  if (t.type === "video"){
    folderDropBeginPending(ev, { armRequired: false, ids: [String(t.vid)] });
    return;
  }
  folderDropBeginPending(ev, { armRequired: false, dragSourceTile: t });
}

function installFolderDrop(){
  if (installFolderDrop._bound) return;
  installFolderDrop._bound = true;
  const g = grid();
  if (g) g.addEventListener("pointerdown", onFolderDropTilePointerDown, { capture:true });
}

function folderDropShouldSuppressClick(){
  return Date.now() < folderDrop.suppressClickUntil || folderDrop.active;
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
  if (nextBreadcrumb) renderCrumbFromHtml(nextBreadcrumb);
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

async function showDiagIfEmpty(){
  try{
    const res = await fetch("/api/diag");
    if (!res.ok) return;
    const d = await res.json();
    if (d.counts && d.counts.total_merged > 0) return;
    const g = grid();
    if (!g) return;
    const issues = (d.issues || []);
    let html = `<div style="padding:32px 24px;color:#b00;font-size:15px;line-height:1.8;max-width:720px">
      <h3 style="margin:0 0 12px;color:#c00">⚠ 扫描未发现任何视频</h3>
      <p style="color:#555;margin:0 0 10px">请检查 Docker 容器的卷挂载和环境变量是否正确。</p>
      <table style="border-collapse:collapse;font-size:13px;width:100%">
        <tr><th style="text-align:left;padding:4px 12px 4px 0;color:#333">路径</th><th style="text-align:left;padding:4px 8px;color:#333">值</th><th style="text-align:left;padding:4px 8px;color:#333">状态</th></tr>
        <tr><td style="padding:4px 12px 4px 0"><code>WE_PATH</code></td><td style="padding:4px 8px;word-break:break-all"><code>${d.we_path||''}</code></td><td style="padding:4px 8px">${d.exists?.we_path?'✅ 存在':'❌ <b>不存在</b>'}</td></tr>
        <tr><td style="padding:4px 12px 4px 0"><code>config.json</code></td><td style="padding:4px 8px;word-break:break-all"><code>${d.config_json||''}</code></td><td style="padding:4px 8px">${d.exists?.config_json?'✅ 存在':'❌ <b>不存在</b>'}</td></tr>
        <tr><td style="padding:4px 12px 4px 0"><code>WORKSHOP_PATH</code></td><td style="padding:4px 8px;word-break:break-all"><code>${d.workshop_path||''}</code></td><td style="padding:4px 8px">${d.exists?.workshop_path?'✅ 存在':'❌ <b>不存在</b>'}</td></tr>
        <tr><td style="padding:4px 12px 4px 0"><code>myprojects</code></td><td style="padding:4px 8px;word-break:break-all"><code>${d.myprojects_path||''}</code></td><td style="padding:4px 8px">${d.exists?.myprojects?'✅ 存在':'❌ <b>不存在</b>'}</td></tr>
      </table>
      <p style="color:#555;margin:12px 0 4px">扫描计数：workshop=${d.counts?.workshop_items??0}, myprojects=${d.counts?.myprojects_items??0}, config链接=${d.counts?.config_linked_items??0}, workshop子目录=${d.counts?.workshop_subdirs??0}</p>
      ${issues.length ? '<div style="margin-top:8px;padding:10px;background:#fff3f3;border:1px solid #e88;border-radius:4px"><b>问题列表：</b><ul style="margin:6px 0 0 18px;padding:0">' + issues.map(i=>'<li>'+i+'</li>').join('') + '</ul></div>' : ''}
      <p style="color:#888;margin:12px 0 0;font-size:12px">示例 Docker 命令：<br><code style="display:block;margin-top:4px;padding:8px;background:#f5f5f5;border-radius:4px;font-size:12px;white-space:pre-wrap">docker run -d -p 8000:8000 \\
  -v /你的/workshop路径:/data/workshop/content/431960:ro \\
  -v /你的/wallpaper_engine路径:/data/wallpaper_engine:ro \\
  wallpaper-webui:latest</code></p>
    </div>`;
    g.innerHTML = html;
  }catch(_){}
}

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
    renderCrumb(data.breadcrumb || []);

    if (state.page===1){ grid().innerHTML=""; state.tiles=[]; }
    const newIds = appendTiles(data);
    if (newIds.length) syncWatched(newIds);

    state.hasMore = state.page < data.total_pages;
    state.page += 1;
    setInfStatus(state.hasMore ? "下拉加载更多…" : "已到底部");

    if (data.total_items === 0 && state.page === 2 && !state.q) showDiagIfEmpty();

    bindDelegatedEvents(); bindRubber(); installFolderDrop(); schedulePrefetch();
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

  if (state.page === 1 && state.path !== "/"){
    const parts = state.path.split("/").filter(Boolean);
    const parentPath = parts.length > 1 ? "/" + parts.slice(0, -1).join("/") : "/";
    const el = document.createElement("div");
    el.className="tile folder parent-folder";
    el.dataset.type="parent"; el.dataset.path=parentPath; el.dataset.idx=idx;
    el.innerHTML = `<div class="thumb"><div class="big">...</div></div>
                    <div class="title">...</div>`;
    grid().appendChild(el);
    state.tiles.push({el, type:"parent", path:parentPath, idx, title:"..."});
    idx++;
  }

  data.folders.forEach(f=>{
    const path = (state.path.endsWith("/")? state.path : state.path + "/") + f.title;
    const el = document.createElement("div");
    el.className="tile folder"; el.dataset.type="folder"; el.dataset.path=path; el.dataset.idx=idx;
    el.innerHTML = `<div class="thumb"><div class="big">📁</div></div>
                    <div class="title" data-full-title="${_escHtml(f.title)}">${f.title}</div>
                    <button class="tile-menu" title="菜单">⋮</button>`;
    grid().appendChild(el); state.tiles.push({el, type:"folder", path, idx, title:f.title}); idx++;
  });

  (data.videos||[]).forEach(v=>{
    const done = isWatched(v.id);
    const base = v.preview_url;
    // 性能优化：不要用 srcset 一次性触发多尺寸缩略图生成（会导致每次打开页面都要转码/读写很多文件）。
    // 固定一个尺寸 + 固定格式，服务端 preview_cache 命中率最高，加载会明显变快。
    const thumb = `${base}?s=256&fmt=webp&q=80`;
    const fallback = base;
    const el = document.createElement("div");
    el.className="tile"; el.dataset.type="video"; el.dataset.vid=v.id; el.dataset.idx=idx;
    el.innerHTML = `<div class="thumb">
                      <img
                        src="${thumb}"
                        alt="preview" draggable="false" loading="lazy" decoding="async" fetchpriority="low"
                        onerror="this.onerror=null; this.src='${fallback}'"
                      />
                      ${ratingBadgeHtml(v.rating)}
                    </div>
                    <button class="watched-btn ${done?'on':'off'}" aria-label="切换观看状态" aria-pressed="${done?'true':'false'}" title="${done?'点击标记为未观看':'点击标记为已观看'}">✓</button>
                    <div class="title" data-full-title="${_escHtml(v.title)}">${v.title}</div>
                    <div class="author" data-full-author="${_escHtml(v.author || "")}">${tileAuthorHtml(v)}</div>
                    <div class="meta">${tileMetaHtml(v)}</div>
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

function tileKey(t){
  if (!t) return "";
  if (t.type === "parent") return `parent:${t.path || ""}`;
  if (t.type === "folder") return `folder:${t.path || ""}`;
  if (t.type === "video") return `video:${String(t.vid || "")}`;
  return "";
}
function buildTileSpecs(data, pageNum){
  const specs = [];
  if (pageNum === 1 && state.path !== "/"){
    const parts = state.path.split("/").filter(Boolean);
    const parentPath = parts.length > 1 ? "/" + parts.slice(0, -1).join("/") : "/";
    specs.push({ type:"parent", path:parentPath, title:"..." });
  }
  (data.folders || []).forEach(f=>{
    const path = (state.path.endsWith("/") ? state.path : state.path + "/") + f.title;
    specs.push({ type:"folder", path, title:f.title });
  });
  (data.videos || []).forEach(v=>{
    specs.push({ type:"video", vid:String(v.id), title:v.title, data:v });
  });
  return specs;
}
function createTileFromSpec(spec, idx){
  const el = document.createElement("div");
  if (spec.type === "parent"){
    el.className = "tile folder parent-folder";
    el.dataset.type = "parent"; el.dataset.path = spec.path; el.dataset.idx = idx;
    el.innerHTML = `<div class="thumb"><div class="big">...</div></div>
                    <div class="title">...</div>`;
    return { el, type:"parent", path:spec.path, idx, title:"..." };
  }
  if (spec.type === "folder"){
    el.className = "tile folder";
    el.dataset.type = "folder"; el.dataset.path = spec.path; el.dataset.idx = idx;
    el.innerHTML = `<div class="thumb"><div class="big">📁</div></div>
                    <div class="title" data-full-title="${_escHtml(spec.title)}">${spec.title}</div>
                    <button class="tile-menu" title="菜单">⋮</button>`;
    return { el, type:"folder", path:spec.path, idx, title:spec.title };
  }
  const v = spec.data || {};
  const done = isWatched(v.id);
  const base = v.preview_url;
  const thumb = `${base}?s=256&fmt=webp&q=80`;
  const fallback = base;
  el.className = "tile"; el.dataset.type = "video"; el.dataset.vid = v.id; el.dataset.idx = idx;
  el.innerHTML = `<div class="thumb">
                    <img
                      src="${thumb}"
                      alt="preview" draggable="false" loading="lazy" decoding="async" fetchpriority="low"
                      onerror="this.onerror=null; this.src='${fallback}'"
                    />
                    ${ratingBadgeHtml(v.rating)}
                  </div>
                  <button class="watched-btn ${done?'on':'off'}" aria-label="切换观看状态" aria-pressed="${done?'true':'false'}" title="${done?'点击标记为未观看':'点击标记为已观看'}">✓</button>
                  <div class="title" data-full-title="${_escHtml(v.title)}">${v.title}</div>
                  <div class="author" data-full-author="${_escHtml(v.author || "")}">${tileAuthorHtml(v)}</div>
                  <div class="meta">${tileMetaHtml(v)}</div>
                  <button class="tile-menu" title="菜单">⋮</button>`;
  return { el, type:"video", vid:String(v.id), idx, title:v.title };
}
function updateTileFromSpec(tile, spec, idx){
  tile.idx = idx;
  if (tile.el && tile.el.dataset) tile.el.dataset.idx = String(idx);
  if (spec.type === "video"){
    const v = spec.data || {};
    tile.vid = String(v.id);
    tile.title = v.title;
    const titleEl = tile.el && tile.el.querySelector(".title");
    const authorEl = tile.el && tile.el.querySelector(".author");
    const metaEl = tile.el && tile.el.querySelector(".meta");
    const badgeEl = tile.el && tile.el.querySelector(".rating-badge");
    if (titleEl) {
      if (titleEl.textContent !== v.title) titleEl.textContent = v.title;
      titleEl.dataset.fullTitle = v.title || "";
    }
    if (authorEl) {
      const author = String(v.author || "").trim();
      if (authorEl.textContent !== author) authorEl.textContent = author;
      authorEl.dataset.fullAuthor = author;
    }
    if (metaEl) metaEl.innerHTML = tileMetaHtml(v);
    if (badgeEl) {
      const info = ratingBadgeInfo(v.rating);
      badgeEl.className = `rating-badge ${info.cls}`;
      badgeEl.textContent = info.label;
    }
    updateTileWatchedUI(v.id, isWatched(v.id));
  } else {
    tile.title = spec.title;
    const titleEl = tile.el && tile.el.querySelector(".title");
    if (titleEl) {
      if (titleEl.textContent !== spec.title) titleEl.textContent = spec.title;
      titleEl.dataset.fullTitle = spec.title || "";
    }
  }
  if (tile.el) tile.el.classList.toggle("selected", isSel(tile));
  return tile;
}

const titleTip = { el:null, active:null };
function ensureTitleTip(){
  if (titleTip.el) return titleTip.el;
  const el = document.createElement("div");
  el.className = "title-tooltip";
  document.body.appendChild(el);
  titleTip.el = el;
  return el;
}
function showTitleTip(target, ev){
  const text = target?.dataset?.fullTitle || target?.dataset?.fullAuthor || target?.textContent || "";
  if (!text.trim()) return;
  const el = ensureTitleTip();
  titleTip.active = target;
  el.textContent = text;
  el.classList.add("show");
  moveTitleTip(ev);
}
function moveTitleTip(ev){
  const el = titleTip.el;
  if (!el || !el.classList.contains("show")) return;
  const pad = 12;
  const x = Math.min(window.innerWidth - pad, (ev?.clientX || 0) + 14);
  const y = Math.min(window.innerHeight - pad, (ev?.clientY || 0) + 16);
  el.style.left = x + "px";
  el.style.top = y + "px";
}
function hideTitleTip(){
  if (titleTip.el) titleTip.el.classList.remove("show");
  titleTip.active = null;
}
function installTitleTooltip(){
  if (installTitleTooltip.installed) return;
  installTitleTooltip.installed = true;
  document.addEventListener("mouseover", (ev)=>{
    const title = ev.target && ev.target.closest && ev.target.closest(".tile .title, .tile .author");
    if (!title) return;
    showTitleTip(title, ev);
  });
  document.addEventListener("mousemove", (ev)=>{
    if (titleTip.active) moveTitleTip(ev);
  });
  document.addEventListener("mouseout", (ev)=>{
    const title = ev.target && ev.target.closest && ev.target.closest(".tile .title, .tile .author");
    if (!title) return;
    if (ev.relatedTarget && title.contains(ev.relatedTarget)) return;
    hideTitleTip();
  });
}
async function softRefreshCurrentScanContext(){
  if (state.isLoading) return;
  const keyAtStart = makeQueryKey();
  const loadedPages = Math.max(1, state.page - 1);
  const scrollX = window.scrollX || 0;
  const scrollY = window.scrollY || 0;
  setInfStatus("检测到文件变化，正在更新…");
  state.isLoading = true;
  try{
    await fetch("/api/scan/refresh", { method: "POST", cache: "no-store" });
    const opts = snapshotOpts();
    const pages = [];
    for (let p = 1; p <= loadedPages; p++){
      const data = await apiScan(opts, p, undefined);
      if (keyAtStart !== makeQueryKey()) return;
      pages.push({ page:p, data });
      if (p >= data.total_pages) break;
    }
    const first = pages[0] && pages[0].data;
    const last = pages[pages.length - 1] && pages[pages.length - 1].data;
    if (!first || !last) return;
    renderCrumb(first.breadcrumb || []);

    const specs = [];
    pages.forEach(x=> specs.push(...buildTileSpecs(x.data, x.page)));
    const existing = new Map();
    state.tiles.forEach(t=>{ const key = tileKey(t); if (key) existing.set(key, t); });
    const frag = document.createDocumentFragment();
    const nextTiles = [];
    const videoIds = [];
    specs.forEach((spec, idx)=>{
      const key = spec.type === "parent" ? `parent:${spec.path}` : spec.type === "folder" ? `folder:${spec.path}` : `video:${String(spec.vid)}`;
      const old = existing.get(key);
      const tile = old ? updateTileFromSpec(old, spec, idx) : createTileFromSpec(spec, idx);
      frag.appendChild(tile.el);
      nextTiles.push(tile);
      if (tile.type === "video") videoIds.push(String(tile.vid));
    });
    grid().replaceChildren(frag);
    state.tiles = nextTiles;
    state.page = pages.length + 1;
    state.hasMore = pages.length < last.total_pages;
    setInfStatus(state.hasMore ? "下拉加载更多…" : "已到底部");
    if (videoIds.length) syncWatched(videoIds);
    bindDelegatedEvents(); bindRubber(); installFolderDrop(); resetPrefetch(); schedulePrefetch();
    try{ window.scrollTo(scrollX, scrollY); }catch(_){}
  }catch(_){
    setInfStatus("自动更新失败，稍后重试");
  }finally{
    state.isLoading = false;
    queueMicrotask(()=>autoFillViewport(3));
  }
}
async function refreshCurrentScanContext(reason="manual"){
  if (reason === "auto") return softRefreshCurrentScanContext();
  setInfStatus("正在重新扫描…");
  try {
    await fetch("/api/scan/refresh", { method: "POST", cache: "no-store" });
  } catch (_) {}
  changeContext({});
}

const scanWatch = { timer:null, running:false, lastAutoRefresh:0, pending:false };
async function checkScanChanges(){
  if (scanWatch.running) return;
  if (document.visibilityState !== "visible") return;
  scanWatch.running = true;
  try{
    const r = await fetch("/api/scan/watch", { cache: "no-store" });
    if (!r.ok) return;
    const j = await r.json().catch(()=>null);
    if (!j || !j.changed) return;
    if (isPlayerActive()){
      scanWatch.pending = true;
      return;
    }
    const now = Date.now();
    if (now - scanWatch.lastAutoRefresh < 10000) return;
    scanWatch.lastAutoRefresh = now;
    scanWatch.pending = false;
    await refreshCurrentScanContext("auto");
  }catch(_){
  }finally{
    scanWatch.running = false;
  }
}
async function flushPendingScanRefresh(){
  if (!scanWatch.pending) return;
  if (document.visibilityState !== "visible") return;
  scanWatch.pending = false;
  scanWatch.lastAutoRefresh = Date.now();
  await refreshCurrentScanContext("auto");
}
function startScanWatch(){
  if (scanWatch.timer) return;
  scanWatch.timer = setInterval(checkScanChanges, 15000);
}

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
function renderCrumbFromHtml(_html){
  const segs = (state.path || "/").split("/").filter(Boolean);
  renderCrumb(segs);
}
function renderCrumb(segs=[]){
  const el = $("crumb");
  if (!el) return;
  el.classList.add("path-pill");
  const parts = [`<a class="path-chip root" href="#/" title="根目录">${cpcIcon("home")}<span>/</span></a>`];
  (segs || []).forEach((seg, i)=>{
    const p = "/" + segs.slice(0, i+1).join("/");
    parts.push(`<span class="path-sep">/</span><a class="path-chip" href="#${encodeURI(p)}" title="${_escHtml(seg)}">${_escHtml(seg)}</a>`);
  });
  el.innerHTML = parts.join("");
}

/* =================== 播放控制（无 MSE） =================== */

let userGestureUnlocked = false;
async function unlockPlaybackOnUserGesture(){
  if (userGestureUnlocked) return;
  const a = $("bgAudio"), v = $("fsVideo");
  // Only attempt unlock if elements have a valid src; calling play() on empty elements
  // wastes the user gesture token on some browsers.
  if (a && a.src) { try { await a.play(); a.pause(); userGestureUnlocked = true; return; } catch{} }
  if (v && v.src) { try { await v.play(); v.pause(); userGestureUnlocked = true; return; } catch{} }
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

/* --- 全屏返回栈 --- */
let _lastPlayIndexTS = 0;
function installPopStateGuard(){
  window.addEventListener("popstate", () => {
    if (!isPlayerActive()) return;
    // During or shortly after track switching, Android Chrome may fire spurious
    // popstate events (e.g. fullscreen state changes). Block them and re-push.
    if (_switchingAdvanceLock || (Date.now() - _lastPlayIndexTS < 3000)) {
      if (POPOUT_MODE) return;
      try { history.pushState({ fsOverlay:true }, ""); fsOverlayInHistory = true; } catch(_) {}
      return;
    }
    fsOverlayInHistory = false;
    if (POPOUT_MODE) exitPlayerOrClosePopout();
    else exitPlayer();
  });
}
installPopStateGuard();

/* --- 双指右滑返回手势（移动端/平板） --- */
(function installTwoFingerSwipeBack(){
  let startX = 0, startY = 0, tracking = false, fired = false;
  const MIN_DX = 70, MAX_DY_RATIO = 0.7;

  document.addEventListener("touchstart", (e)=>{
    if (e.touches.length === 2){
      tracking = true;
      fired = false;
      const t0 = e.touches[0], t1 = e.touches[1];
      startX = (t0.clientX + t1.clientX) / 2;
      startY = (t0.clientY + t1.clientY) / 2;
    }
  }, {passive:true});

  document.addEventListener("touchmove", (e)=>{
    if (!tracking || fired) return;
    if (e.touches.length < 2){ tracking = false; return; }
    const t0 = e.touches[0], t1 = e.touches[1];
    const curX = (t0.clientX + t1.clientX) / 2;
    const curY = (t0.clientY + t1.clientY) / 2;
    const dx = curX - startX;
    const dy = Math.abs(curY - startY);
    if (dx > MIN_DX && dy < dx * MAX_DY_RATIO){
      if (window.__touchLocked) return;
      fired = true;
      tracking = false;
      try{ e.preventDefault(); }catch(_){}
      handleSwipeBack();
    }
  }, {passive:false});

  document.addEventListener("touchend", ()=>{
    tracking = false;
  }, {passive:true});

  document.addEventListener("touchcancel", ()=>{
    tracking = false;
    fired = false;
  }, {passive:true});

  function handleSwipeBack(){
    if (window.__touchLocked) return;
    if (isPlayerActive()){
      if (POPOUT_MODE){
        exitPlayerOrClosePopout();
        return;
      }
      exitPlayer();
      // 同一路径下仅退出播放器并恢复滚动，不刷新列表
      let curPath = "/";
      try{ curPath = (typeof state !== "undefined") ? state.path : pathFromHash(); }catch(_){}
      if (player.returnPath && player.returnPath !== curPath){
        navigateToPath(player.returnPath);
      }
      return;
    }
    const p = (typeof state !== "undefined") ? state.path : pathFromHash();
    if (p && p !== "/"){
      const parent = p.replace(/\/[^\/]*\/?$/, "") || "/";
      navigateToPath(parent);
    }
  }
})();

/* --- 双指双击锁定/解锁触摸 --- */
(function installTwoFingerDoubleTapLock(){
  let _touchLocked = false;
  window.__touchLocked = false;
  let _lastTwoFingerTap = 0;
  let _twoFingerDown = 0;
  const DBL_TAP_MS = 400, MAX_HOLD_MS = 350;
  function setTouchLocked(on){
    _touchLocked = !!on;
    window.__touchLocked = _touchLocked;
    const pfs = document.getElementById("playerFS");
    if (pfs) pfs.classList.toggle("touch-locked", _touchLocked);
  }
  window.__setTouchLocked = setTouchLocked;

  document.addEventListener("touchstart", (e)=>{
    if (e.touches.length === 2){
      _twoFingerDown = Date.now();
    }
  }, {passive:true, capture:true});

  document.addEventListener("touchend", (e)=>{
    if (_twoFingerDown && e.touches.length === 0){
      const hold = Date.now() - _twoFingerDown;
      _twoFingerDown = 0;
      if (hold > MAX_HOLD_MS) return;
      const now = Date.now();
      if (now - _lastTwoFingerTap < DBL_TAP_MS){
        _lastTwoFingerTap = 0;
        setTouchLocked(!_touchLocked);
        return;
      }
      _lastTwoFingerTap = now;
    }
  }, {passive:true, capture:true});

  function blockAll(e){
    if (!_touchLocked) return;
    if (e.touches && e.touches.length === 2) return;
    e.preventDefault();
    e.stopPropagation();
  }
  for (const evt of ["touchstart","touchmove","touchend",
                      "pointerdown","pointermove","pointerup",
                      "click","contextmenu","mousedown","mouseup"]){
    document.addEventListener(evt, blockAll, {capture:true, passive:false});
  }
})();

/* --- 允许自定义控件接管 PiP/远程播放 --- */
function enforceNoPIP(v){
  if (!v) return;
  try{ v.disablePictureInPicture = false; v.removeAttribute("disablepictureinpicture"); }catch(_){}
  try{ v.disableRemotePlayback = true; }catch(_){}
}

/* --- play 封装 --- */
async function safePlay(el){
  try { await el.play(); return true; } catch(_) {
    try{
      el.muted = true;
      await el.play();
      // Unmute after a short delay — immediate unmute may be blocked on some browsers
      setTimeout(()=>{
        try{
          el.muted = false;
        }catch(_){}
      }, 80);
      return true;
    }catch(_2){ return false; }
  }
}

/* ---------- 源地址 ---------- */
function encodeMediaId(id){ return encodeURIComponent(String(id)); }
/** 是否为 Steam 创意工坊 10 位订阅 id（myprojects 等为 mp: 前缀或其它格式） */
function isSteamWorkshopVid(id){ return /^\d{10}$/.test(String(id)); }
function mediaVideoSrcOf(id, cacheBust=false){ return `/media/video/${encodeMediaId(id)}` + (cacheBust ? `?v=${Date.now()}` : ""); }
function audioSrcOf(id, cacheBust=false){ return `/media/audio/${encodeMediaId(id)}` + (cacheBust ? `?v=${Date.now()}` : ""); }

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

/* ========== 后台保活（针对 Android 14+/澎湃 OS 3 AudioHardening 调优） ==========
   关键背景：
     AS.AudioService: AudioHardening background playback would be muted ..., level: partial
   系统 AudioHardening 的判定依据是 **AudioManager/MediaSession 侧的状态**，而不是 WebAudio
   的 destination 输出。也就是说：AudioContext 常量源这条路走不通（历史验证：gain 再怎么
   调都没用）——因为 `<audio>` 元素和 AudioContext 在 Android 上是两条独立的 audio 流路径，
   系统看的是前者 + MediaSession。

   真正撑住后台静音播放的三件事：
     A) `<audio>` 元素持续在 play —— 浏览器据此认定 tab 有音频活动，不做 render throttle；
     B) MediaSession.playbackState = "playing" + 有效 metadata —— 系统 AudioHardening 据此
        判定为合法媒体会话，不触发 partial-mute；
     C) stallHB + playWatch 检测停滞、必要时做硬重启（doSilentRestart）。

   本函数只负责：Wake Lock 申请、周期性「强刷 MediaSession.playbackState」、以及轻量
   停滞探测（兜底，不抢 stallHB 的活）。AudioContext 常量源已移除。
   /api/keepalive 服务器心跳也已移除（对客户端播放稳定性无帮助）。
*/
const keepAlive = {
  active:false,
  wakeLock:null,
  playWatchTimer:null, lastMediaTime:0, lastCheckTime:0
};
async function startBgKeepAlive(){
  if (keepAlive.active) return;
  keepAlive.active = true;

  // 1. Wake Lock：一次性申请；hidden 状态下申请本就会失败，无需周期重试
  try{
    if ('wakeLock' in navigator && !keepAlive.wakeLock){
      keepAlive.wakeLock = await navigator.wakeLock.request('screen');
      keepAlive.wakeLock.addEventListener('release', ()=>{ keepAlive.wakeLock = null; });
    }
  }catch(_){ keepAlive.wakeLock = null; }

  // 2. 周期 tick（4s）：
  //    ① 强刷 MediaSession.playbackState = "playing"（对抗 AudioHardening partial-mute）
  //    ② 后台停滞轻量探测，仅在 stallHB 未介入时做 a.play() 兜底
  if (keepAlive.playWatchTimer) clearInterval(keepAlive.playWatchTimer);
  keepAlive.playWatchTimer = setInterval(()=>{
    if (_userPaused) return;
    if (!isPlayerActive() || playbackMode !== "audio") return;

    // ① 强刷 MediaSession：避免 Chrome 因瞬时 pause/buffering 把 state 刷成 paused，
    //    进而被 Android AudioHardening 判定为「非法后台音频」而静音。
    try{
      if ("mediaSession" in navigator){
        const el = getActiveEl();
        if (el && !el.paused){
          navigator.mediaSession.playbackState = "playing";
        }
      }
    }catch(_){}

    if (document.visibilityState !== "hidden") return;

    // ② 停滞兜底：仅在 stallHB 未介入时做 a.play()（stallHB 负责重度硬重启）
    const a = media.a || $("bgAudio");
    if (!a) return;
    const now = Date.now();
    const currentTime = a.currentTime || 0;
    const wasPlaying = !a.paused;
    const timeAdvanced = currentTime > (keepAlive.lastMediaTime || 0) + 0.05;

    if (wasPlaying && !timeAdvanced && keepAlive.lastCheckTime && (now - keepAlive.lastCheckTime) > 3000){
      if (!stallHB.active){
        console.warn("[KeepAlive] playback stalled, attempting lightweight a.play()");
        try{ a.play().catch(()=>{}); }catch(_){}
      }
    }
    if (wasPlaying && timeAdvanced){ keepAlive.lastMediaTime = currentTime; }
    keepAlive.lastCheckTime = now;
  }, 4000);
}
function stopBgKeepAlive(){
  keepAlive.active = false;

  if (keepAlive.playWatchTimer){ clearInterval(keepAlive.playWatchTimer); keepAlive.playWatchTimer = null; }

  try{
    if (keepAlive.wakeLock && !keepAlive.wakeLock.released){
      keepAlive.wakeLock.release();
    }
    keepAlive.wakeLock = null;
  }catch(_){}

  keepAlive.lastMediaTime = 0;
  keepAlive.lastCheckTime = 0;
}

/* === 附加/预热（带 seek 策略） === */

/* —— HLS 播放 ——
 *  后端用 ffmpeg -c copy 把 MP4 实时 remux 成 HLS（.m3u8 + .ts 段），
 *  前端用 HLS.js 加载播放列表，激进缓冲 + 任意 seek 都不卡。
 *
 *  fallback 顺序：
 *    1. HLS.js（Chrome/Firefox/Edge/Android），手动喂段，maxBufferLength=120s，aggressive
 *    2. 原生 HLS（Safari/iOS）：video.src = playlist.m3u8 即可
 *    3. 都不支持 → 退回原生 MP4 src（旧行为）
 */

// HLS 缓冲：MSE 预算只占 JS 堆的一小部分；bufferFullError 是正常满缓冲，勿 reload。
const HLS_MSE_BUDGET_KEY = "mse_budget_learned_v2";
const HLS_MSE_BUDGET_FLOOR_BYTES = 12 * 1024 * 1024;
const HLS_MSE_HEAP_FRACTION = 0.15;
const HLS_MSE_RAM_PER_GB_DESKTOP = 32 * 1024 * 1024;
const HLS_MSE_RAM_PER_GB_MOBILE = 24 * 1024 * 1024;
const HLS_MSE_BUDGET_CAP_DESKTOP = 192 * 1024 * 1024;
const HLS_MSE_BUDGET_CAP_MOBILE = 64 * 1024 * 1024;
const HLS_DEFAULT_BACK_BUFFER_SEC = 25;

function _collectPlaybackEnvironment(v){
  const mobile = _playbackIsMobile();
  let deviceMemoryGb = 0;
  try{ deviceMemoryGb = Number(navigator.deviceMemory) || 0; }catch(_){}
  let jsHeapLimit = 0, jsHeapUsed = 0;
  try{
    const pm = performance.memory;
    if (pm){
      jsHeapLimit = Number(pm.jsHeapSizeLimit) || 0;
      jsHeapUsed = Number(pm.usedJSHeapSize) || 0;
    }
  }catch(_){}
  const vw = Number(v?.videoWidth || v?.clientWidth || window.innerWidth) || 1920;
  const vh = Number(v?.videoHeight || v?.clientHeight || window.innerHeight) || 1080;
  const screenPixels = Math.max(1, Math.floor(vw * vh));
  return { is_mobile: mobile, device_memory_gb: deviceMemoryGb, js_heap_limit_bytes: jsHeapLimit,
    js_heap_used_bytes: jsHeapUsed, screen_pixels: screenPixels };
}

function _readLearnedMseBudget(){
  try{
    const raw = sessionStorage.getItem(HLS_MSE_BUDGET_KEY);
    if (!raw) return 0;
    const j = JSON.parse(raw);
    const b = Number(j?.bytes || 0);
    return Number.isFinite(b) && b >= HLS_MSE_BUDGET_FLOOR_BYTES ? b : 0;
  }catch(_){ return 0; }
}

function _writeLearnedMseBudget(bytes){
  try{
    sessionStorage.setItem(HLS_MSE_BUDGET_KEY, JSON.stringify({
      bytes: Math.max(HLS_MSE_BUDGET_FLOOR_BYTES, Math.floor(bytes)),
      ts: Date.now(),
    }));
  }catch(_){}
}

function _computeMseBudget(env, instanceCount){
  const learned = _readLearnedMseBudget();
  const mobile = !!env?.is_mobile;
  const devGb = Number(env?.device_memory_gb) || (mobile ? 4 : 8);
  const heapLimit = Number(env?.js_heap_limit_bytes) || 0;
  const heapUsed = Number(env?.js_heap_used_bytes) || 0;
  const pixels = Number(env?.screen_pixels) || (1920 * 1080);

  const decodeBytes = Math.floor(pixels * 1.5 * 12);
  const perGb = mobile ? HLS_MSE_RAM_PER_GB_MOBILE : HLS_MSE_RAM_PER_GB_DESKTOP;
  const ramBudget = Math.floor(devGb * perGb);

  let raw = ramBudget;
  if (heapLimit > 0){
    const heapAvail = Math.max(0, heapLimit - heapUsed - Math.floor(heapLimit * 0.25));
    // SourceBuffer 配额远小于 JS 堆总量，只取可用堆的一小部分
    raw = Math.min(Math.floor(heapAvail * HLS_MSE_HEAP_FRACTION), ramBudget);
  }
  raw = Math.max(HLS_MSE_BUDGET_FLOOR_BYTES, raw - decodeBytes);
  const cap = mobile ? HLS_MSE_BUDGET_CAP_MOBILE : HLS_MSE_BUDGET_CAP_DESKTOP;
  const instances = Math.max(1, Number(instanceCount) || _playbackInstanceCount());
  let budgetCap = cap;
  if (instances > 1 || POPOUT_MODE){
    budgetCap = Math.min(budgetCap, Math.floor((88 * 1024 * 1024) / instances));
  }
  let budget = Math.min(raw, budgetCap);
  if (learned > 0) budget = Math.min(budget, learned);
  return Math.max(HLS_MSE_BUDGET_FLOOR_BYTES, budget);
}

function _hlsJsConfigFromBudget(mseBudgetBytes, bps, isMobile){
  const budget = Math.max(HLS_MSE_BUDGET_FLOOR_BYTES, Number(mseBudgetBytes) || HLS_MSE_BUDGET_FLOOR_BYTES);
  const segHeadroom = Math.floor(32 * 1024 * 1024 * 0.35);
  const maxBufferSize = Math.max(8 * 1024 * 1024, budget - segHeadroom);
  let maxBufferLength = 600;
  const rate = Number(bps) || 0;
  if (rate > 0){
    maxBufferLength = Math.min(600, Math.max(15, Math.floor((maxBufferSize * 8 * 0.92) / rate)));
  }
  let backBufferLength = Math.min(120, Math.max(8, Math.floor(maxBufferLength * 0.22)));
  if (isMobile) backBufferLength = Math.min(backBufferLength, 20);
  return {
    maxBufferLength,
    maxMaxBufferLength: maxBufferLength,
    maxBufferSize,
    backBufferLength,
    startFragPrefetch: maxBufferSize >= 32 * 1024 * 1024,
    maxBufferHole: 1.5,
    maxSeekHole: 4,
    highBufferWatchdogPeriod: 2,
    nudgeOffset: 0.08,
    nudgeMaxRetries: 8,
    mseBudgetBytes: budget,
  };
}

function _installHlsBufferGuard(hls, v, seq, hlsInfo){
  if (!hls || v._hlsBufferGuard) return;
  v._hlsBufferGuard = true;
  const isFloat = v.classList?.contains("watch-float-video");
  let shrinkCount = 0;
  let lastShrinkAt = 0;
  const bps = Number(hlsInfo?.estimated_bitrate_bps || 0);

  const applyBudget = (nextBudget, reason)=>{
    const cfg = _hlsJsConfigFromBudget(nextBudget, bps, _playbackIsMobile());
    hls.config.maxBufferSize = cfg.maxBufferSize;
    hls.config.maxBufferLength = cfg.maxBufferLength;
    hls.config.maxMaxBufferLength = cfg.maxMaxBufferLength;
    hls.config.backBufferLength = cfg.backBufferLength;
    hls.config.startFragPrefetch = cfg.startFragPrefetch;
    if (!isFloat) _writeLearnedMseBudget(nextBudget);
    console.warn("[hls] MSE budget adjust:", reason, cfg);
  };

  hls.on(window.Hls.Events.ERROR, (_evt, data)=>{
    if (v._hlsSeq !== seq || !data) return;
    const d = String(data.details || "");
    // bufferFullError = 已达到 maxBufferSize，hls.js 会自行停拉，不是 OOM，绝不能 reload
    if (d === "bufferFullError"){
      hls.config.startFragPrefetch = false;
      return;
    }
    // 只有 append 失败（QuotaExceeded）才收缩预算
    if (d !== "bufferAppendError") return;
    const now = Date.now();
    if (shrinkCount >= 4 || (now - lastShrinkAt) < 3000) return;
    shrinkCount += 1;
    lastShrinkAt = now;
    const cur = Number(hls.config?.maxBufferSize) || HLS_MSE_BUDGET_FLOOR_BYTES;
    applyBudget(Math.max(HLS_MSE_BUDGET_FLOOR_BYTES, Math.floor(cur * 0.75)), d);
    if (!data.fatal && data.type === window.Hls.ErrorTypes.MEDIA_ERROR){
      if (!isFloat) try{ hls.recoverMediaError(); }catch(_){}
    }
  });
}

function _videoIdFromMp4Src(src){
  // /media/video/123?v=xxx → 123
  const m = /\/media\/video\/([^/?]+)/.exec(src || "");
  return m ? decodeURIComponent(m[1]) : null;
}

function _hlsPlaylistUrl(src, tier = "full"){
  const vid = _videoIdFromMp4Src(src);
  if (!vid) return null;
  if (tier === "preview") return `/media/hls/${encodeURIComponent(vid)}/preview/playlist.m3u8`;
  return `/media/hls/${encodeURIComponent(vid)}/playlist.m3u8`;
}

const hlsInfoCache = new Map();
function _hlsInfoForSrc(src){
  const vid = _videoIdFromMp4Src(src);
  return vid ? hlsInfoCache.get(String(vid)) : null;
}
function _serverDurationForSrc(src){
  const d = Number((_hlsInfoForSrc(src) || {}).duration || 0);
  return Number.isFinite(d) && d > 0 ? d : 0;
}
let hlsAttachSeq = 0;
function pinHlsDuration(hls, v, expectedDuration){
  const dur = Number(expectedDuration) || Number(v?._expectedDuration) || 0;
  if (!hls || !v || !Number.isFinite(dur) || dur <= 0) return false;
  const candidates = [];
  try{ if (hls.mediaSource) candidates.push(hls.mediaSource); }catch(_){}
  try{ if (hls.bufferController && hls.bufferController.mediaSource) candidates.push(hls.bufferController.mediaSource); }catch(_){}
  try{
    if (Array.isArray(hls.coreComponents)){
      hls.coreComponents.forEach(c=>{ if (c && c.mediaSource) candidates.push(c.mediaSource); });
    }
  }catch(_){}
  let ok = false;
  candidates.forEach(ms=>{
    try{
      if (ms && ms.readyState !== "closed" && Number.isFinite(ms.duration) && Math.abs(ms.duration - dur) > 0.25){
        ms.duration = dur;
        ok = true;
      }
    }catch(_){}
  });
  try{
    if (!ok && Number.isFinite(v.duration) && Math.abs(v.duration - dur) <= 0.25) ok = true;
  }catch(_){}
  return ok;
}
function _hlsInfoFromJson(j){
  return {
    use_hls: true,
    duration: Number(j.duration || 0),
    source_size: Number(j.source_size || 0),
    estimated_bitrate_bps: Number(j.estimated_bitrate_bps || 0),
    copy_risky: !!j.copy_risky,
    copy_blocked: !!j.copy_blocked,
    direct_play_ok: !!j.direct_play_ok,
    ts: Date.now(),
  };
}
function _cachePlaybackMeta(vid, meta){
  if (!vid || !meta) return;
  hlsInfoCache.set(String(vid), {
    use_hls: true,
    duration: Number(meta.duration || 0),
    source_size: Number(meta.source_size || 0),
    estimated_bitrate_bps: Number(meta.estimated_bitrate_bps || 0),
    copy_risky: !!meta.copy_risky,
    copy_blocked: !!meta.copy_blocked,
    direct_play_ok: !!meta.direct_play_ok,
    ts: Date.now(),
  });
}
function _collectSupportedCodecs(v){
  const el = v || document.createElement("video");
  const can = (t)=>{ try{ return el.canPlayType(t) !== ""; }catch(_){ return false; } };
  return {
    h264: can('video/mp4; codecs="avc1.42E01E"'),
    hevc: can('video/mp4; codecs="hvc1.1.6.L150.B0"'),
    aac: can('audio/mp4; codecs="mp4a.40.2"'),
  };
}
function _playbackIsMobile(){
  return /Android|webOS|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || "");
}
async function _negotiatePlayback(vid, v, position, opts = {}){
  if (!vid) return null;
  const tier = opts.isFloat ? "preview" : "full";
  const env = _collectPlaybackEnvironment(v);
  const mseBudget = opts.isFloat
    ? FLOAT_PLAYER_MSE_BYTES
    : _computeMseBudget(env, _playbackInstanceCount());
  try{
    const r = await fetch("/api/playback/negotiate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        video_id: String(vid),
        playback_tier: tier,
        is_mobile: env.is_mobile,
        supports_mse: !!(window.MediaSource || window.WebKitMediaSource),
        browser: (navigator.userAgent || "").slice(0, 120),
        supported_codecs: _collectSupportedCodecs(v),
        position: Number(position) || 0,
        device_memory_gb: env.device_memory_gb,
        js_heap_limit_bytes: env.js_heap_limit_bytes,
        js_heap_used_bytes: env.js_heap_used_bytes,
        screen_pixels: env.screen_pixels,
        mse_budget_bytes: mseBudget,
      }),
      cache: "no-store",
    });
    if (!r.ok) return null;
    return await r.json();
  }catch(_){
    return null;
  }
}
function _preferNativeMp4ForInfo(info){
  // 仅作 HLS 致命失败后的兜底；正常路径一律优先 HLS。
  return !!info?.direct_play_ok && !info?.copy_blocked;
}
function _hlsJsConfigForInfo(info){
  const bps = Number(info?.estimated_bitrate_bps || 0);
  const env = _collectPlaybackEnvironment(null);
  const budget = _computeMseBudget(env, _playbackInstanceCount());
  return _hlsJsConfigFromBudget(budget, bps, env.is_mobile);
}
async function _ensureHlsInfoForSrc(src){
  const vid = _videoIdFromMp4Src(src);
  if (!vid) return null;
  const key = String(vid);
  const cached = hlsInfoCache.get(key);
  if (cached && Date.now() - cached.ts < 10 * 60 * 1000) return cached;
  try{
    const r = await fetch(`/media/hls/${encodeURIComponent(vid)}/info`, { cache:"no-store" });
    if (!r.ok) return cached || null;
    const info = _hlsInfoFromJson(await r.json());
    hlsInfoCache.set(key, info);
    return info;
  }catch(_){
    return cached || null;
  }
}
async function _shouldUseHLSForSrc(src){
  const info = await _ensureHlsInfoForSrc(src);
  return !!info || !!_videoIdFromMp4Src(src);
}

function _hlsSupported(){
  return !!(window.Hls && window.Hls.isSupported && window.Hls.isSupported());
}
function _nativeHlsSupported(v){
  try { return !!(v && v.canPlayType("application/vnd.apple.mpegurl")); } catch(_){ return false; }
}

/* 销毁 video 元素上挂着的 HLS controller，避免泄漏。 */
function teardownMSE(v){
  if (!v) return;
  _releaseFloatHlsSlot(v);
  if (v._hls){
    try { v._hls.stopLoad(); } catch(_){}
    try { v._hls.detachMedia(); } catch(_){}
    try { v._hls.destroy(); } catch(_){}
    v._hls = null;
  }
  v._hlsSrc = null;
  v._hlsSeq = 0;
  v._hlsBufferGuard = false;
  v._hlsPlaybackTier = null;
}

/* 原生 src 路径（兜底）：可以是原 MP4，也可以是 HLS playlist（Safari 原生支持） */
function _configureDirectPlayElement(v){
  if (!v) return;
  try{
    v.preload = "auto";
    v.playsInline = true;
    v.setAttribute("playsinline", "");
    v.setAttribute("webkit-playsinline", "true");
    v.disableRemotePlayback = true;
  }catch(_){}
}
async function prewarmMediaConnection(url){
  const bare = _stripQuery(url || "");
  if (!bare) return;
  // 优先 HEAD 预热连接；若服务端未开 HEAD（405）则只用 Range GET
  let headOk = false;
  try{
    const hr = await fetch(bare, { method: "HEAD", cache: "no-store", credentials: "same-origin" });
    headOk = hr.ok;
  }catch(_){}
  if (headOk) return;
  try{
    await fetch(bare, {
      method: "GET",
      headers: { Range: "bytes=0-0" },
      cache: "no-store",
      credentials: "same-origin",
    });
  }catch(_){}
}
function _installDirectPlayStallNudge(v){
  if (!v || v._directPlayStallNudge) return;
  v._directPlayStallNudge = true;
  v.addEventListener("stalled", ()=>{
    if (v.paused || (v.readyState || 0) >= 3) return;
    try{
      const t = Number(v.currentTime) || 0;
      v.currentTime = t + 0.01;
    }catch(_){}
  });
}
async function _ensurePlaybackWakeLock(){
  try{
    if ("wakeLock" in navigator && !keepAlive.wakeLock){
      keepAlive.wakeLock = await navigator.wakeLock.request("screen");
      keepAlive.wakeLock.addEventListener("release", ()=>{ keepAlive.wakeLock = null; });
    }
  }catch(_){ keepAlive.wakeLock = null; }
}
async function _attachDirectPlayVideo(v, src, resumeAt){
  _configureDirectPlayElement(v);
  const curAttr = v.getAttribute("src") || "";
  const needReload = curAttr !== src;
  if (needReload){
    try{ v.pause(); }catch(_){}
    v.removeAttribute("src");
    try{ v.load(); }catch(_){}
  }
  await prewarmMediaConnection(src);
  if (needReload){
    v.src = src;
    try{ v.load(); }catch(_){}
  }
  _installDirectPlayStallNudge(v);
  await _ensurePlaybackWakeLock();
  setCurrentTimeWhenReady(v, resumeAt || 0);
  if (v.readyState >= 1) {
    setTimeout(fixPortraitVideoInFullscreen, 50);
  } else {
    v.addEventListener("loadedmetadata", ()=> setTimeout(fixPortraitVideoInFullscreen, 50), { once:true });
  }
}
function _attachVideoSrcNative(v, src, resumeAt){
  const curAttr = v.getAttribute("src") || "";
  const needReload = curAttr !== src;
  if (needReload){ v.src = src; try{ v.load(); }catch(_){} }
  setCurrentTimeWhenReady(v, resumeAt||0);
  if (v.readyState >= 1) {
    setTimeout(fixPortraitVideoInFullscreen, 50);
  } else {
    v.addEventListener("loadedmetadata", ()=> setTimeout(fixPortraitVideoInFullscreen, 50), {once:true});
  }
}

// 规范化用：去掉 cacheBust 的 ?v=xxx，只比较 path
function _stripQuery(u){
  const i = (u || "").indexOf("?");
  return i < 0 ? (u || "") : u.slice(0, i);
}

async function attachVideoSrc(src, resumeAt, opts = {}){
  const v = opts.target || media.v || $("fsVideo");
  if (!v) return;
  enforceNoPIP(v);
  const playbackTier = opts.isFloat ? "preview" : "full";
  const floatPanel = opts.floatPanel || null;
  const floatLoadToken = opts.isFloat ? (opts.floatLoadToken ?? v._floatLoadToken) : null;
  const floatStillValid = ()=>{
    if (!opts.isFloat) return true;
    return !v._floatClosed
      && v._floatLoadToken === floatLoadToken
      && _floatPanelActive(floatPanel, v);
  };
  const abortFloatAttach = ()=>{
    if (!opts.isFloat) return;
    try { teardownMSE(v); } catch(_){}
  };
  const vidForInfo = _videoIdFromMp4Src(src);
  if (vidForInfo) v._expectedDuration = _serverDurationForSrc(src);

  // 已经挂的是同一个视频 + 同一 tier → 只调进度就行
  if (v._hls && _stripQuery(v._hlsSrc) === _stripQuery(src) && (v._hlsPlaybackTier || "full") === playbackTier){
    setCurrentTimeWhenReady(v, resumeAt||0);
    pinHlsDuration(v._hls, v, v._expectedDuration);
    return;
  }
  const seq = ++hlsAttachSeq;
  teardownMSE(v);

  const decision = vidForInfo ? await _negotiatePlayback(vidForInfo, v, resumeAt||0, opts) : null;
  if (!floatStillValid()){ abortFloatAttach(); return; }

  // 浮窗：拉 playlist（=触发后端 ffmpeg 冷启）前先排队，错峰冷启动避免 NAS IO/GPU init 抢占
  if (opts.isFloat && decision?.method !== "direct_play"){
    await _acquireFloatWarmupSlot(floatPanel, v);
    if (!floatStillValid()){ _releaseFloatWarmupSlot(v); abortFloatAttach(); return; }
    v._floatWarmupStartedAt = Date.now();
    v._floatLastMoveAt = Date.now();   // warmup 看门狗从“真正开始预热”计时
    if (vidForInfo) apiHlsResume(vidForInfo, "preview");
  }

  const pl = decision?.url || _hlsPlaylistUrl(src, playbackTier);
  if (pl){
    if (opts.isFloat){
      // 浮窗：异步触发 playlist/转码，不阻塞 HLS.js attach（避免串行等 prime 拖慢起播）
      fetch(pl, { cache:"no-store", credentials:"same-origin" }).catch(()=>{});
    } else {
      await fetch(pl, { cache:"no-store", credentials:"same-origin" }).catch(()=>{});
    }
  } else {
    await prewarmMediaConnection(src).catch(()=>{});
  }
  if (!floatStillValid()){ _releaseFloatWarmupSlot(v); abortFloatAttach(); return; }

  if (decision?.meta){
    _cachePlaybackMeta(vidForInfo, decision.meta);
    if (decision.meta.duration > 0) v._expectedDuration = decision.meta.duration;
    if (opts.isFloat){
      console.info("[float] negotiate:", decision.method, vidForInfo,
        "v=", decision.meta.video_codec || "?", "a=", decision.meta.audio_codec || "?");
    }
  }

  const playlistUrl = decision?.url || _hlsPlaylistUrl(src, playbackTier);
  let hlsInfo = _hlsInfoForSrc(src);
  if (!hlsInfo){
    hlsInfo = await _ensureHlsInfoForSrc(src);
    if (hlsInfo?.duration > 0) v._expectedDuration = hlsInfo.duration;
  }
  if (!floatStillValid()){ abortFloatAttach(); return; }

  const useDirectPlay = decision?.method === "direct_play";

  if (useDirectPlay){
    if (opts.isFloat){
      v._floatDirectPlay = true;
      _releaseFloatWarmupSlot(v);
      console.info("[float] client direct play:", src);
    }
    console.info("[playback] direct play:", src, decision?.method || "fallback");
    v.dataset.playbackEngine = "native";
    await _attachDirectPlayVideo(v, src, resumeAt);
    return;
  }

  // 优先用 HLS.js（Chrome/Firefox/Edge/Android WebView）
  const useHlsJs = decision?.method === "hls_js"
    || (!decision && playlistUrl && _hlsSupported() && (hlsInfo || vidForInfo));
  if (useHlsJs){
    if (opts.isFloat){
      v._floatDirectPlay = false;
      await _acquireFloatHlsSlot();
      if (!floatStillValid()){
        _cancelFloatHlsSlotAcquire();
        abortFloatAttach();
        return;
      }
      v._floatHlsSlotHeld = true;
    }
    if (!floatStillValid()){
      if (opts.isFloat){
        if (v._floatHlsSlotHeld) _releaseFloatHlsSlot(v);
        else _cancelFloatHlsSlotAcquire();
      }
      abortFloatAttach();
      return;
    }
    v._expectedDuration = _serverDurationForSrc(src) || v._expectedDuration || 0;
    let bufCfg = decision?.config ? { ...decision.config } : _hlsJsConfigForInfo(hlsInfo);
    if (opts.isFloat){
      const bps = Number(hlsInfo?.estimated_bitrate_bps || decision?.meta?.estimated_bitrate_bps || 0);
      v._hlsBitrateBps = bps;
      const floatBudget = _floatPlaybackBudgetBytes();
      bufCfg = _hlsJsConfigFromBudget(floatBudget, bps, _playbackIsMobile());
      bufCfg.maxBufferLength = Math.max(18, Math.min(bufCfg.maxBufferLength || 50, 55));
      bufCfg.maxMaxBufferLength = bufCfg.maxBufferLength;
      bufCfg.mseBudgetBytes = floatBudget;
      const nf = Math.max(1, _floatPlayerCount());
      bufCfg.maxMaxConcurrentFragments = nf > 6 ? 1 : (nf > 3 ? 2 : 4);
    }
    const hls = new window.Hls({
      ...bufCfg,
      autoStartLoad: true,
      fragLoadPolicy: {
        default: {
          maxTimeToFirstByteMs: opts.isFloat ? 240000 : 120000,
          maxLoadTimeMs: opts.isFloat ? 300000 : 180000,
          timeoutRetry: { maxNumRetry: 8, retryDelayMs: 800, maxRetryDelayMs: 5000 },
          errorRetry:   { maxNumRetry: 8, retryDelayMs: 800, maxRetryDelayMs: 5000 },
        },
      },
      manifestLoadPolicy: {
        default: {
          maxTimeToFirstByteMs: 30000,   // ★ 首次播放后端要 ffmpeg 切片，可能等几十秒
          maxLoadTimeMs: 120000,
          timeoutRetry: { maxNumRetry: 2, retryDelayMs: 1000, maxRetryDelayMs: 5000 },
          errorRetry:   { maxNumRetry: 3, retryDelayMs: 1000, maxRetryDelayMs: 5000 },
        },
      },
      // 边播边缓冲（看到啥拉啥）
      lowLatencyMode: false,
      // 默认起播位置（HLS.js 会 attach 后再 seek）
      startPosition: Number.isFinite(resumeAt) ? Math.max(0, resumeAt) : 0,
    });
    v._hls = hls;
    v._hlsSrc = src;
    v._hlsSeq = seq;
    v._hlsPlaybackTier = playbackTier;
    v.dataset.playbackEngine = "hls";
    _installHlsBufferGuard(hls, v, seq, hlsInfo);
    let fatalNetworkRetries = 0;
    let fatalMediaRetries = 0;

    const fallbackToNative = (reason)=>{
      if (v._hlsSeq !== seq) return;
      console.warn("[hls] fallback to native mp4:", reason);
      showNotice("HLS 分段播放失败，已临时回退原生 MP4。请打开控制台查看 [hls] 错误。");
      try { hls.stopLoad(); } catch(_){}
      try { hls.detachMedia(); } catch(_){}
      try { hls.destroy(); } catch(_){}
      v._hls = null; v._hlsSrc = null;
      v.dataset.playbackEngine = "native";
      _attachVideoSrcNative(v, src, resumeAt);
    };

    hls.on(window.Hls.Events.MEDIA_ATTACHED, ()=>{
      if (v._hlsSeq !== seq) return;
      // attach 完成后让 HLS.js 接管
      pinHlsDuration(hls, v, v._expectedDuration);
    });
    hls.on(window.Hls.Events.MANIFEST_PARSED, ()=>{
      if (v._hlsSeq !== seq) return;
      console.info("[hls] attached:", playlistUrl, opts.isFloat ? "(float)" : "");
      v._expectedDuration = _serverDurationForSrc(src) || v._expectedDuration || 0;
      pinHlsDuration(hls, v, v._expectedDuration);
      if (opts.isFloat){
        v._floatSyncUi?.();
        if (!v._floatUserPaused && !v._floatClosed) v.play().catch(()=>{});
      } else setTimeout(fixPortraitVideoInFullscreen, 50);
    });
    if (window.Hls.Events.LEVEL_LOADED){
      hls.on(window.Hls.Events.LEVEL_LOADED, (_evt, data)=>{
        if (v._hlsSeq !== seq) return;
        try{
          const d = Number(data?.details?.totalduration || data?.details?.totalDuration || 0);
          const serverDuration = _serverDurationForSrc(src);
          // Keep the UI on the probed media runtime, not HLS.js' mutable MSE timeline.
          if (serverDuration > 0) v._expectedDuration = serverDuration;
          else if (d > 0) v._expectedDuration = d;
        }catch(_){}
        pinHlsDuration(hls, v, v._expectedDuration);
        if (opts.isFloat) v._floatSyncUi?.();
      });
    }
    if (window.Hls.Events.BUFFER_CREATED){
      hls.on(window.Hls.Events.BUFFER_CREATED, ()=>{
        if (v._hlsSeq !== seq) return;
        pinHlsDuration(hls, v, v._expectedDuration);
        if (opts.isFloat) v._floatSyncUi?.();
      });
    }
    hls.on(window.Hls.Events.ERROR, (_evt, data)=>{
      if (v._hlsSeq !== seq) return;
      if (!data) return;
      if (data.fatal){
        console.warn("[hls] fatal error:", data.type, data.details, data);
        // 致命错误才恢复；fragParsingError 通常说明后端 copy 出了浏览器不能解析的 TS，
        // 无限 recover 只会刷屏，直接回退原 MP4，同时后端新版本会重切为 H.264/AAC。
        switch (data.type) {
          case window.Hls.ErrorTypes.NETWORK_ERROR:
            if (++fatalNetworkRetries <= 2) {
              const resumeAt = v._floatSyncUi ? _floatSeekResumeAt(v) : (Number(v.currentTime) || 0);
              hls.startLoad(Math.max(0, resumeAt));
            } else {
              fallbackToNative(data.details || data.type);
            }
            break;
          case window.Hls.ErrorTypes.MEDIA_ERROR:
            if (data.details === "fragParsingError" || ++fatalMediaRetries > 2) {
              fallbackToNative(data.details || data.type);
            } else {
              hls.recoverMediaError();
            }
            break;
          default:
            fallbackToNative(data.details || data.type);
        }
      } else {
        // 非致命：log 一下就好（HLS.js 自己会重试）
        // console.debug("[hls] non-fatal:", data.details);
      }
    });

    if (!floatStillValid()){
      try { hls.stopLoad(); } catch(_){}
      try { hls.detachMedia(); } catch(_){}
      try { hls.destroy(); } catch(_){}
      v._hls = null;
      return;
    }
    hls.attachMedia(v);
    hls.loadSource(playlistUrl);
    return;
  }

  // 原生 HLS（Safari / iOS）
  const useNativeHls = decision?.method === "native_hls"
    || (!decision && playlistUrl && _nativeHlsSupported(v));
  if (useNativeHls){
    v._hlsSrc = src;
    v.dataset.playbackEngine = "native-hls";
    _attachVideoSrcNative(v, playlistUrl, resumeAt);
    return;
  }

  // 都不支持 → 用原 MP4 直接播
  v.dataset.playbackEngine = "native";
  _attachVideoSrcNative(v, src, resumeAt);
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
  teardownMSE(v);
  try{ v.removeAttribute("src"); v.load(); }catch(_){}
}

/* —— 前台对齐（视频前台、独立音轨跟随时用） —— */
let fgSyncTimer = null;
function startFgSync(){
  if (fgSyncTimer) return;
  fgSyncTimer = setInterval(()=>{
    if (document.visibilityState !== "visible") return;
    const v = media.v||$("fsVideo"), a = media.a||$("bgAudio");
    if (!v || !a) return;
    if (!Number.isFinite(v.currentTime)) return;
    const target = (v.currentTime||0) + (audioBias||0);
    const dv = Math.abs((a.currentTime||0) - target);
    // HLS 画面和独立音轨分离时，用视频时间轴校准音频。
    if (!a.paused && dv > 0.5){
      try{ a.currentTime = target; }catch(_){ }
    }
    // 兜底：若音频被暂停（异常），偏移过大时也对齐
    if (a.paused && dv > 5){
      try{ a.currentTime = target; }catch(_){ }
    }
  }, 2000);
}
function stopFgSync(){ if (fgSyncTimer){ clearInterval(fgSyncTimer); fgSyncTimer=null; } }

/* —— 后台 near-end 兜底 —— */
const bgAdvanceGuard = { timer:null };
function startBgAdvanceGuard(){
  if (bgAdvanceGuard.timer) return;
  bgAdvanceGuard.timer = setInterval(()=>{
    if (!isPlayerActive() || playbackMode !== "audio") return;
    const a = media.a || $("bgAudio");
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

  let dur = fixedMediaDuration();
  if (!Number.isFinite(dur) || dur <= 0) dur = Number.isFinite(el.duration) && el.duration>0 ? el.duration : undefined;
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

  // 用户已暂停：只切换模式，不自动播放
  if (_userPaused){
    try{ a.pause(); a.muted = true; a.volume = 0; }catch(_){}
    await attachVideoSrc(vSrc, resumeAt);
    try{ v.pause(); v.muted = false; }catch(_){}
    playbackMode = "video";
    stopBgKeepAlive();
    updateMediaSessionPlaybackState(); updatePositionState(); startPosTicker();
    stopBgAdvanceGuard();
    return;
  }

  await attachVideoSrc(vSrc, resumeAt);

  let ok = false;
  try{
    v.muted = true;
    const onPlaying = ()=>{
      try{ v.muted = false; }catch(_){}
      setTimeout(()=>{ try{ a.muted = true; a.volume = 0; }catch(_){} }, 60);
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
    try{ a.muted = true; a.volume = 0; }catch(_){}
    const ok2 = await safePlay(v);
    if (!ok2){ showNotice("前台播放被阻止，点一下屏幕继续"); installUserGestureUnlock(); }
  }
}

const switchToAudio = withSwitchLock(async function(){
  if (!isPlayerActive() || playbackMode==="audio") return;
  if (scrubGuard.active) return;
  // PiP 窗口仍存在时保持 video 模式；暂停 PiP 也不算进入后台音频。
  if (isPipActiveOrPending()) return;

  const v = media.v || $("fsVideo");
  const a = media.a || $("bgAudio");
  const id = player.ids[player.index];
  const autoPlay = !_userPaused;

  if (!autoPlay){
    // 用户已暂停：保持暂停状态，不启动后台播放
    try{ if (a){ a.pause(); a.muted = true; a.volume = 0; } }catch(_){}
    try{ if (v){ v.muted = true; v.pause(); } }catch(_){}
  } else if (a && !a.paused){
    // ★ 快速路径：音频已在前台静音播放且 fgSync 保持了位置同步
    // 交叉切换前做一次精确对齐（数据在缓冲区内，seek 瞬间完成）
    try{
      const target = (v.currentTime||0) + (audioBias||0);
      if (Math.abs((a.currentTime||0) - target) > 0.05){
        a.currentTime = target;
      }
    }catch(_){}
    try{ a.muted = false; a.volume = Math.max(0.6, a.volume || 0.6); }catch(_){}
    try{ if (v) v.muted = true; }catch(_){}
    try{ if (v) v.pause(); }catch(_){}
  } else {
    // 慢速兜底：音频未就绪（首次 / 元素被替换 / 异常），完整加载
    const aSrc = audioSrcOf(id);
    const resumeAt = Number.isFinite(v?.currentTime) ? v.currentTime : 0;
    try{ if (v) v.muted = true; }catch(_){}
    try{
      await attachAudioSrc(aSrc, resumeAt, {
        muted: false,
        ensurePlay: true,
        seek: 'force'
      });
    }catch(_){}
    try{ if (v) v.pause(); }catch(_){}
    // 兜底重试
    const aEl = media.a || $("bgAudio");
    if (aEl && aEl.paused){
      try{ await aEl.play(); }catch(_){
        try{
          await attachAudioSrc(audioSrcOf(id, true), resumeAt,
            { muted:false, ensurePlay:true, seek:'smart' });
        }catch(_){}
      }
    }
  }

  if (autoPlay) clearUserPaused();
  playbackMode = "audio";
  updateMediaSessionPlaybackState(); updatePositionState(); startPosTicker();
  if (autoPlay){
    // 对抗 Android 14+/澎湃 OS 3 AudioHardening：进入音频模式瞬间立即把 MediaSession 强刷为
    // 有效的 "playing"（含 metadata），避免系统因瞬时 paused/buffering 把 tab 判定为
    // 「非法后台音频」而 partial-mute。后续由 startBgKeepAlive 的周期 tick 持续维持。
    try{
      if (id) setMediaSessionMeta(id);
      if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "playing";
    }catch(_){}
    startBgAdvanceGuard();
    startBgKeepAlive();
    const aFinal = media.a || $("bgAudio");
    if (aFinal){
      resetStallHeartbeat(aFinal);
      startStallHeartbeat();
      if (!aFinal.paused){
        keepAlive.lastMediaTime = aFinal.currentTime || 0;
        keepAlive.lastCheckTime = Date.now();
      }
    }
  } else {
    stopBgAdvanceGuard();
    stopBgKeepAlive();
    stopStallHeartbeat();
  }
});

const switchToVideo = withSwitchLock(async function(){
  if (!isPlayerActive() || playbackMode==="video") return;
  if (scrubGuard.active) return;
  await promoteToVideoNow("visibility");
});

let wallpaperResumeToken = 0;
function scheduleWallpaperResumeRetries(){
  if (!WALLPAPER_PAUSE_AWAY) return;
  const token = ++wallpaperResumeToken;
  const delays = [0, 120, 500, 1200];
  delays.forEach(delay=>{
    setTimeout(async ()=>{
      if (token !== wallpaperResumeToken) return;
      if (!wallpaperDesktopVisible || !isPlayerActive()) return;
      const active = getActiveEl();
      if (!active || !active.paused) return;
      wallpaperApplyingVisibility = true;
      try{
        clearUserPaused();
        await safePlay(active);
        try{
          if ("mediaSession" in navigator && !active.paused){
            navigator.mediaSession.playbackState = "playing";
          }
        }catch(_){}
      }finally{
        setTimeout(()=>{ wallpaperApplyingVisibility = false; }, 0);
      }
    }, delay);
  });
}

async function applyWallpaperVisibility(visible, source="api"){
  if (!(WALLPAPER_MUTE_AWAY || WALLPAPER_PAUSE_AWAY)) return;
  wallpaperDesktopVisible = !!visible;
  if (!isPlayerActive()) return;

  const v = media.v || $("fsVideo");
  const a = media.a || $("bgAudio");
  const active = getActiveEl();

  wallpaperApplyingVisibility = true;
  try{
    if (wallpaperDesktopVisible){
      // 回到桌面：恢复上次由壁纸模式自动暂停的播放，并允许当前主播放源出声。
      if (playbackMode === "audio"){
        try{ if (a){ a.muted = false; a.volume = Math.max(0.6, a.volume || 0.6); } }catch(_){}
      } else {
        try{ if (v) v.muted = false; }catch(_){}
      }
      if (wallpaperAutoPaused && active){
        wallpaperAutoPaused = false;
        clearUserPaused();
        await safePlay(active);
        scheduleWallpaperResumeRetries();
      }
      try{
        if ("mediaSession" in navigator && active && !active.paused){
          navigator.mediaSession.playbackState = "playing";
        }
      }catch(_){}
      return;
    }

    if (WALLPAPER_MUTE_AWAY){
      // wallpaper=1：离开桌面只静音，保持画面时间轴推进；如果当前在 audio 模式，先晋升回 video 再静音。
      try{ if (a){ a.muted = true; a.volume = 0; } }catch(_){}
      try{ if (v) v.muted = true; }catch(_){}
      if (playbackMode === "audio") await switchToVideo();
      const vv = media.v || $("fsVideo");
      try{ if (vv){ vv.muted = true; await vv.play().catch(()=>{}); } }catch(_){}
      wallpaperAutoPaused = false;
    } else {
      // wallpaper=2：离开桌面只暂停，不写 muted。某些 WebView/ROM 会把 muted 残留到
      // 回桌面后的播放，导致需要其它 App 重新抢一次音频焦点才有声。
      if (active && !active.paused) wallpaperAutoPaused = true;
      try{ active?.pause?.(); }catch(_){}
      stopBgKeepAlive();
      stopStallHeartbeat();
      try{ if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "paused"; }catch(_){}
    }
  }finally{
    setTimeout(()=>{ wallpaperApplyingVisibility = false; }, 0);
  }
}

if (WALLPAPER_MUTE_AWAY || WALLPAPER_PAUSE_AWAY){
  window.wallpaperSetVisible = (visible)=>{ applyWallpaperVisibility(!!visible, "bridge"); };
  window.wallpaperPause = ()=>{ applyWallpaperVisibility(false, "bridge"); };
  window.wallpaperResume = ()=>{ applyWallpaperVisibility(true, "bridge"); };
}

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
      if (_userPaused){
        clearInterval(visWatchTimer); visWatchTimer=null; return;
      }
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
  if (WALLPAPER_MUTE_AWAY || WALLPAPER_PAUSE_AWAY){
    await applyWallpaperVisibility(document.visibilityState === "visible", "document");
    return;
  }
  if (scrubGuard.active) return;
  if (_repairInProgress) return;  // ★ 修复期间不自动切换到 audio
  if (document.visibilityState === "hidden"){
    if (!BACKGROUND_AUDIO_MODE) return;
    if (isPipActiveOrPending()) return;
    await switchToAudio();
    // 延迟兜底：检查播放是否被浏览器静默中断（仅在用户没有主动暂停时）
    setTimeout(()=>{
      if (_userPaused) return;
      if (!BACKGROUND_AUDIO_MODE) return;
      if (isPipActiveOrPending()) return;
      if (document.visibilityState !== "hidden" || !isPlayerActive() || playbackMode !== "audio") return;
      const a = media.a || $("bgAudio");
      if (a && a.paused){
        console.warn("[Visibility] 后台播放被暂停，尝试恢复...");
        a.play().catch(()=>{
          const id = player.ids[player.index];
          if (id){
            const resumeAt = Math.max(0, (a.currentTime || 0) - (audioBias || 0));
            attachAudioSrc(audioSrcOf(id, true), resumeAt, { muted:false, ensurePlay:true, seek:'smart' }).catch(()=>{});
          }
        });
      }
    }, 800);
  }else{
    if (playbackMode === "audio") await switchToVideo();
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
    if (_userPaused) return;
    if (e.persisted && isPlayerActive() && playbackMode === "audio"){
      const a = media.a || $("bgAudio");
      if (a && !a.paused){
        setTimeout(()=>{
          if (_userPaused) return;
          if (a.paused){
            console.warn("[PageLifecycle] 从 bfcache 恢复后播放被暂停，尝试恢复...");
            a.play().catch(()=>{});
          }
        }, 100);
      }
    }
  });
}

function flushProgressOnLeave(){
  try{
    if (!shouldPersistPlaybackState()) return;
    if (!isPlayerActive()) return;
    const curId = player?.ids?.[player.index];
    if (!curId) return;
    const { pos, dur } = getLogicalPosDur();
    if (!Number.isFinite(pos) || !Number.isFinite(dur) || dur < 1) return;

    if (maybeMarkPlaybackComplete(curId, pos, dur)) return;
    // 正常进度 → 保存
    if (pos >= PROGRESS_MIN_POSITION_SEC && pos / dur >= PROGRESS_START_RATIO){
      _beaconJson("/api/progress", { id: String(curId), position: pos, duration: dur });
      return;
    }
    // 进度过小：若本次会话/本地缓存中曾有更大进度 → 视为主动倒回 → 清
    const prevSavedPos = (progressSaveState.id === String(curId))
      ? (progressSaveState.lastSavedPos || 0) : 0;
    const local = progressLocalCache.get(String(curId));
    const hadProgress = prevSavedPos > PROGRESS_MIN_POSITION_SEC
      || (local && (local.position || 0) > PROGRESS_MIN_POSITION_SEC);
    if (hadProgress){
      _beaconJson("/api/progress/clear", { ids: [String(curId)] });
    }
  }catch(_){}
}

window.addEventListener("pagehide", (e)=> { 
  flushProgressOnLeave();
  if (BACKGROUND_AUDIO_MODE && !WALLPAPER_MODE && isPlayerActive() && !scrubGuard.active && !_repairInProgress && !isPipActiveOrPending()) switchToAudio();
  if (!e.persisted) stopBgKeepAlive();
});
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
  if (_userPaused) return;
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
  if (_switchingAdvanceLock) return;
  const curId = player.ids[player.index];
  if (lastAdvanceId === curId) return;
  lastAdvanceId = curId;
  if (shouldPersistPlaybackState()){
    const { pos, dur } = getLogicalPosDur();
    if (!maybeMarkPlaybackComplete(curId, pos, dur)){
      markWatched(curId);
      apiClearProgress(curId);
    }
  }
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
  const enc = encodeMediaId(id);
  const artwork = [
    // 固定 fmt=webp，避免 Accept/Vary 导致的多份缓存
    { src: `${origin}/media/preview/${enc}?s=512&fmt=webp&q=80`, sizes:"512x512", type:"image/webp" },
    { src: `${origin}/media/preview/${enc}?s=128&fmt=webp&q=80`, sizes:"128x128", type:"image/webp" },
  ];
  try { navigator.mediaSession.metadata = new MediaMetadata({ title, artist:"Wallpaper Engine", album: state.path, artwork }); } catch(_){}
  if (!setMediaSessionMeta._installed){
    const both = ()=>({ v: (media.v||$("fsVideo")), a: (media.a||$("bgAudio")) });

    navigator.mediaSession.setActionHandler("play", async ()=>{
      clearUserPaused();
      const {v,a} = both();
      if (isPipActiveOrPending()){
        if (playbackMode === "audio") await promoteToVideoNow("media-session-pip-play");
        else { try{ await (v?.play?.()); }catch(_){} }
        try{ if (a){ a.pause(); a.muted = true; a.volume = 0; } }catch(_){}
        stopBgAdvanceGuard();
        stopBgKeepAlive();
        stopStallHeartbeat();
      } else if (BACKGROUND_AUDIO_MODE && document.visibilityState==="hidden"){
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
        if (playbackMode === "audio") await promoteToVideoNow("media-session-play");
        else { try{ await (v?.play?.()); }catch(_){} }
      }
      updateMediaSessionPlaybackState(); startPosTicker(); updatePositionState();
    });

    navigator.mediaSession.setActionHandler("pause", async ()=>{
      markUserPaused();
      const {v,a} = both();
      try{ v.pause(); }catch(_){}
      try{ a.pause(); }catch(_){}
      stopBgKeepAlive();
      stopBgAdvanceGuard();
      try{ stopMinuteResync(); }catch(_){}
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
const stallRepair = {
  inFlight:false,
  tried:new Set(),
  timer:null,
  detach:null,
  startedAt:0,
  lastSeekAt:0,
  lastSeekPos:0,
  lastVideoTime:0,
  startedOnce:false
};
function installStallListeners(v, a){
  if (!v._stallBound){
    const vh = async ()=> await maybeRepairFromEl('video', v);
    v.addEventListener('stalled', vh); v.addEventListener('waiting', vh); v.addEventListener('error',   vh);
    v.addEventListener('seeking', ()=>{ beginScrubGuard(); stallRepair.startedAt = Date.now(); stallRepair.lastSeekAt = Date.now(); stallRepair.lastSeekPos = Number.isFinite(v.currentTime)? v.currentTime : stallRepair.lastSeekPos; disarmFirstPlayWatch(); updatePositionState(); });
    v.addEventListener('seeked',  ()=>{ endScrubGuardSoon(); updatePositionState(); });
    v.addEventListener('timeupdate', ()=>{ if (Number.isFinite(v.currentTime)) stallRepair.lastVideoTime = v.currentTime; });
    v.addEventListener('playing', ()=>{ stallRepair.startedOnce = true; clearUserPaused(); });
    v.addEventListener('pause',   ()=>{ if (document.visibilityState==='visible') markUserPaused(); updatePositionState(); });
    v._stallBound = true;
  }
  if (!a._stallBound){
    const ah = async ()=> await maybeRepairFromEl('audio', a);
    a.addEventListener('stalled', ah); a.addEventListener('waiting', ah); a.addEventListener('error',   ah);
    a._stallBound = true;
  }
}
async function maybeRepairFromEl(which, el){
  if (!isPlayerActive()) return;
  if (scrubGuard.active) return;
  if (stallRepair.lastSeekAt && (Date.now() - stallRepair.lastSeekAt) < 3000) return;
  if (playbackMode === "audio" && which === "video") return;

  const id = player.ids[player.index];
  if (!id || stallRepair.inFlight || stallRepair.tried.has(String(id))) return;
  if (stallRepair.startedOnce) return;
  const early = (el.currentTime || 0) < 1.0;
  const starving = (el.readyState || 0) < 3;
  if (!(early && starving)) return;

  if (!stallRepair.startedAt) stallRepair.startedAt = Date.now();
  if (Date.now() - stallRepair.startedAt < STALL_REPAIR_GRACE_MS) return;

  const resumeAt = Number.isFinite(el.currentTime) ? el.currentTime : (stallRepair.lastSeekPos || stallRepair.lastVideoTime || 0);
  await triggerRepair(id, resumeAt);
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
      if (!wasSkipped) notifySWMediaInvalidate();
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
  const target = Math.max(0, t||0);
  const shouldSeek = ()=>{
    try{
      if (!Number.isFinite(target)) return false;
      if (target <= 0.05) return false;
      const cur = Number(el.currentTime) || 0;
      return Math.abs(cur - target) > 0.35;
    }catch(_){ return false; }
  };
  let done = false;
  const apply = ()=>{
    if (done) return;
    done = true;
    try{ if (shouldSeek()) el.currentTime = target; }catch(_){ }
    updatePositionState();
    cleanup();
  };
  try{
    if (isFinite(el.duration) && el.readyState >= 1) { apply(); return; }
  }catch(_){}
  const cleanup = ()=>{
    try{ el.removeEventListener("loadedmetadata", apply); }catch(_){}
    try{ el.removeEventListener("durationchange", apply); }catch(_){}
    try{ el.removeEventListener("canplay", apply); }catch(_){}
  };
  el.addEventListener("loadedmetadata", apply, {once:true});
  el.addEventListener("durationchange", apply, {once:true});
  el.addEventListener("canplay", apply, {once:true});
}

/* —— 预加载提升 —— */
function injectVideoPreload(src){
  // HLS 优先：预热 playlist，避免大 MP4 HEAD 抢带宽
  try {
    const pl = _hlsPlaylistUrl(src);
    if (pl) {
      fetch(pl, { cache: "no-store", credentials: "same-origin" }).catch(()=>{});
      return;
    }
  } catch(_){}
  prewarmMediaConnection(src).catch(()=>{});
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
function fsViewportMetrics(){
  const wrap = $("playerFS");
  const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
  const vv = window.visualViewport;
  let w = window.innerWidth;
  let h = window.innerHeight;
  let top = 0;
  let left = 0;
  if (vv){
    w = Math.ceil(vv.width || w);
    h = Math.ceil(vv.height || h);
    top = Math.ceil(vv.offsetTop || 0);
    left = Math.ceil(vv.offsetLeft || 0);
  }
  if (wrap && fsEl === wrap){
    const cw = Math.ceil(wrap.clientWidth || 0);
    const ch = Math.ceil(wrap.clientHeight || 0);
    if (cw > 0) w = cw;
    if (ch > 0) h = ch;
    top = 0;
    left = 0;
  }
  return { w: Math.max(1, w), h: Math.max(1, h), top, left };
}

function adjustFSViewport(){
  const wrap = $("playerFS");
  if (!wrap || wrap.style.display === "none") return;
  const { w, h, top, left } = fsViewportMetrics();
  wrap.style.width = w + "px";
  wrap.style.height = h + "px";
  wrap.style.top = top + "px";
  wrap.style.left = left + "px";
  const v = $("fsVideo");
  const ov = $("overlay");
  if (v){
    v.style.width = "100%";
    v.style.height = "100%";
  }
  if (ov){
    ov.style.width = "100%";
    ov.style.height = "100%";
  }
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

  const fixPortraitOnFullscreenChange = ()=>{
    adjustFSViewport();
    setTimeout(()=>{
      adjustFSViewport();
      fixPortraitVideoInFullscreen();
    }, 50);
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
  if (!_fsGuards.installed) return;
  const wrap = $("playerFS");
  if (wrap){
    if (_fsGuards.wheel) wrap.removeEventListener("wheel", _fsGuards.wheel, { passive:false });
    if (_fsGuards.touch) wrap.removeEventListener("touchmove", _fsGuards.touch, { passive:false });
    wrap.style.height = "";
    wrap.style.width = "";
    wrap.style.top = "";
    wrap.style.left = "";
  }
  const v = $("fsVideo");
  const ov = $("overlay");
  if (v){ v.style.height = ""; v.style.width = ""; }
  if (ov){ ov.style.height = ""; ov.style.width = ""; }
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
async function startPlaylist(items, startIndex=0, returnPath=null, options={}){
  cancelProgressive();

  const popout = POPOUT_MODE || !!options.popout;
  showBusy("正在准备播放器…");

  // 记录进入播放器前的滚动位置，便于退出时恢复
  try{
    if (!popout && typeof window !== "undefined"){
      player.returnScrollY = window.scrollY || document.documentElement.scrollTop || 0;
    }
  }catch(_){}

  player.ids = items.map(x=>x.id);
  player.titles = {}; items.forEach(x=> player.titles[x.id] = x.title || `视频 ${x.id}`);
  player.index = Math.max(0, Math.min(startIndex, player.ids.length-1));
  player.returnPath = returnPath || state.path;
  player.loop = !!options.loop;

  if (popout){
    const curId = player.ids[player.index];
    const curTitle = player.titles[curId] || `视频 ${curId}`;
    try { document.title = `${curTitle} · Wallpaper WebUI`; } catch(_){}
  }

  const wrap = $("playerFS");
  const v = $("fsVideo");
  const a = $("bgAudio");
  media.v = v; media.a = a;
  playbackMode = "video";

  wrap.style.display = "flex";
  if (!WALLPAPER_MODE && !popout) {
    requestPlayerFullscreen({ requireActivation:true });
  }
  if (WALLPAPER_MODE && typeof window.__setTouchLocked === "function"){
    window.__setTouchLocked(true);
  }

  /* ★ 变更：确保存在左上角返回按钮（仅桌面 UA 会显示；样式由 CSS 控制） */
  let backBtn = $("btnBack");
  if (!backBtn) {
    backBtn = document.createElement("button");
    backBtn.id = "btnBack";
    backBtn.className = "icon-btn back";
    backBtn.title = "返回";
    backBtn.setAttribute("aria-label", "返回");
    wrap.appendChild(backBtn);
  }
  setCpcIcon(backBtn, "back");
  backBtn.title = popout ? "关闭窗口" : "返回";
  backBtn.setAttribute("aria-label", popout ? "关闭窗口" : "返回");
  backBtn.onclick = ()=>{
    if (popout){
      exitPlayerOrClosePopout();
      return;
    }
    exitPlayer();
    // 如果仍在同一路径，仅退出播放器并恢复滚动，不重新刷新列表
    let curPath = "/";
    try{ curPath = (typeof state !== "undefined") ? state.path : pathFromHash(); }catch(_){}
    if (player.returnPath && player.returnPath !== curPath){
      navigateToPath(player.returnPath);
    }
    if (fsOverlayInHistory){
      fsOverlayInHistory = false;
      try { history.back(); } catch(_) {}
    }
  };

  document.documentElement.classList.add("noscroll");
  document.body.classList.add("noscroll");
  installFsGuards();

  enforceNoPIP(v);

  installPopoutPlayheadReporter(v);

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
      el.addEventListener("timeupdate", ()=>{
        updatePositionState();
        renderCustomControls(false);
        if (shouldPersistPlaybackState()){
          const curId = player?.ids?.[player.index];
          if (curId){
            const { pos, dur } = getLogicalPosDur();
            maybeMarkPlaybackComplete(curId, pos, dur);
          }
        }
      });
      el.addEventListener("loadedmetadata", ()=>{ updatePositionState(); renderCustomControls(true); });
      el.addEventListener("durationchange", ()=>{ updatePositionState(); renderCustomControls(true); });
      el.addEventListener("progress", ()=> renderCustomControls(false));
      el.addEventListener("volumechange", ()=> renderCustomControls(true));
      el.addEventListener("ratechange", ()=> renderCustomControls(true));
      el.addEventListener("playing", ()=>{
        if (isVideo) clearUserPaused();
        updatePositionState(); startPosTicker(); renderCustomControls(true);
        if (isVideo && playbackMode==="video" && !_userPaused) _ensurePlaybackWakeLock();
        if (!isVideo && playbackMode==="audio" && !_userPaused) startBgKeepAlive();
      });
      el.addEventListener("pause",   ()=>{
        // 仅当该元素是主播放源时才标记用户暂停（音频在前台静音跟随时 pause 不算用户意图）
        if (!wallpaperApplyingVisibility && document.visibilityState==='visible' && (isVideo || playbackMode==='audio')) markUserPaused();
        updatePositionState(); renderCustomControls(true);
        if (!isVideo) stopBgKeepAlive();                             
      });
      if (isVideo){
        el.addEventListener("seeking", ()=>{ beginScrubGuard(); stallRepair.startedAt = Date.now(); stallRepair.lastSeekAt = Date.now(); stallRepair.lastSeekPos = Number.isFinite(el.currentTime)? el.currentTime : stallRepair.lastSeekPos; disarmFirstPlayWatch(); updatePositionState(); renderCustomControls(true); });
        el.addEventListener("seeked",  ()=>{ endScrubGuardSoon(); updatePositionState(); renderCustomControls(true); });
        el.addEventListener("timeupdate", ()=>{ if (Number.isFinite(el.currentTime)) stallRepair.lastVideoTime = el.currentTime; });
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
    v.controls = false;
    v.removeAttribute("controls");
  }catch(_){}

  const btnMenu = $("btnMenu");
  if (btnMenu) {
    setCpcIcon(btnMenu, "menu");
    btnMenu.onclick = ()=>{ if ($("playlistPanel").classList.contains("hidden")) showPlaylistPanel(); else hidePlaylistPanel(); };
  }

  const waitReady = new Promise(res=>{
    let done=false;
    const finish=()=>{ if(done) return; done=true; res(); };
    const killTimer = setTimeout(finish, 2000);
    const cleanup = ()=>{
      clearTimeout(killTimer);
      try{ v.removeEventListener("playing", cleanup); }catch(_){}
      try{ a.removeEventListener("playing", cleanup); }catch(_){}
    };
    v.addEventListener("playing", ()=>{ cleanup(); finish(); }, {once:true});
    a.addEventListener("playing", ()=>{ cleanup(); finish(); }, {once:true});
  });

  wrap.addEventListener("mousemove", wakeOverlay);
  wrap.addEventListener("touchstart", wakeOverlay);
  wakeOverlay();
  startCustomControlsTicker();
  installCustomControlKeys();
  suspendGridImageLoads();

  await playIndex(player.index, options.ignoreProgress ? { resumeAt: 0 } : {});
  if (WALLPAPER_MUTE_AWAY || WALLPAPER_PAUSE_AWAY) {
    await applyWallpaperVisibility(wallpaperDesktopVisible, "playlist-start");
  }

  if (!WALLPAPER_MODE && !popout){
    try { history.pushState({ fsOverlay:true }, ""); fsOverlayInHistory = true; } catch(_) {}
  }

  if (!WALLPAPER_MODE && !popout) await waitReady;
  hideBusy();
}

/* ★ 切集 / 首次播放 */
let _switchingAdvanceLock = false;
async function playIndex(i, opts = {}){
  const { cacheBust=false, forceVideo=false } = opts;
  // 若调用方没显式传 resumeAt，则尝试从服务器拉取断点；显式传了（包括 0）则直接用。
  const hasExplicitResume = Object.prototype.hasOwnProperty.call(opts, "resumeAt");
  let resumeAt = Number.isFinite(opts.resumeAt) ? opts.resumeAt : 0;

  _switchingAdvanceLock = true;
  _lastPlayIndexTS = Date.now();
  player.index = i;
  stallRepair.startedOnce = false;
  lastAdvanceId = null;
  disarmFirstPlayWatch();
  stallRepair.startedAt = Date.now();
  resetProgressSaveState();

  // 断点续播：
  //   1) 本地缓存命中（刚退出几秒内）→ 立即用本地值开始播放
  //   2) 未命中 → 等服务器（最多 800ms，避免阻塞太久）
  //   3) 无论走哪条，都后台再去服务器核对一次：若服务器上有更新的值（来自其他设备），平滑 seek 过去
  let _progressBgCheck = null;
  const candId = player.ids[i];
  const replayingWatched = candId && shouldPersistPlaybackState() && isWatched(candId);
  if (replayingWatched){
    // 重新播放已观看视频时立即取消已观看，避免勾选状态和当前播放意图冲突。
    await setWatchedOptimistic(candId, false);
    resumeAt = 0;
  }
  rememberRandomPlayed(candId);
  if (shouldPersistPlaybackState() && !replayingWatched && !hasExplicitResume && resumeAt <= 0 && candId){
    const local = getLocalProgress(candId);
    const usable = (p) => p && p.duration > 0
      && p.position >= PROGRESS_MIN_POSITION_SEC
      && p.position / p.duration < PROGRESS_COMPLETE_RATIO;

    if (usable(local)){
      resumeAt = local.position;
      // 后台核对服务器，有更新值就 seek（可能别的设备已经播到更后面了）
      _progressBgCheck = apiGetProgress(candId);
    } else {
      let p = null;
      try{
        p = await Promise.race([
          apiGetProgress(candId),
          new Promise(res => setTimeout(()=>res(null), 800)),
        ]);
      }catch(_){}
      if (usable(p)) resumeAt = p.position;
    }
  }

  const wrap = $("playerFS");
  const v = media.v || $("fsVideo");
  const a = media.a || $("bgAudio");
  const cover = $("switchCover");

  // Capture last frame onto canvas overlay so video element stays hidden during src switch
  if (document.visibilityState !== "hidden" && cover){
    try{
      if (v.videoWidth > 0 && v.readyState >= 2){
        cover.width = v.videoWidth; cover.height = v.videoHeight;
        cover.getContext("2d").drawImage(v, 0, 0);
      }
    }catch(_){}
  }
  wrap.classList.add("switching");

  const a0 = media.a || $("bgAudio");
  if (a0){ try{ a0.muted = true; a0.volume = 0; }catch(_){ } }

  const id = player.ids[i];
  if (POPOUT_MODE){
    const t = player.titles[id] || `视频 ${id}`;
    try { document.title = `${t} · Wallpaper WebUI`; } catch(_){}
  }
  if (_repairedVideos.has(String(id))){
    cacheBust = true;
    forceVideo = true;
    _repairedVideos.delete(String(id));
  }
  const vSrc = mediaVideoSrcOf(id, cacheBust);
  const aSrc = audioSrcOf(id, cacheBust);
  injectVideoPreload(vSrc);

  // Single-video loop: let browser handle it natively
  v.loop = (player.loop && player.ids.length === 1);

  if (BACKGROUND_AUDIO_MODE && !WALLPAPER_MODE && document.visibilityState === "hidden" && !forceVideo) {
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
    playbackMode = "video";
    try{ if (a){ a.pause(); a.muted = true; a.volume = 0; } }catch(_){}
    await attachVideoSrc(vSrc, resumeAt||0);
    const ok = await safePlay(v);
    // Audio preload AFTER video play: v.play() must consume the user gesture first,
    // otherwise a.play() (even muted) may consume it on some Chrome builds.
    attachAudioSrc(aSrc, resumeAt||0, { muted:true, ensurePlay:false, seek:'smart' }).catch(()=>{});
    if (!ok){ showNotice("播放被阻止：请点击屏幕以继续播放。"); installUserGestureUnlock(); }
    setMediaSessionMeta(id);
    updatePositionState(); startPosTicker();
    stopBgAdvanceGuard();
    stopBgKeepAlive();
    armFirstPlayWatch(id, v);
  }
  startFgSync();
  renderPlaylistPanel();
  renderCustomControls(true);

  wrap.classList.remove("switching");

  _switchingAdvanceLock = false;
  resetStallHeartbeat(a);
  startProgressTicker();

  // 本地缓存命中时的后台核对：若服务器上的进度（可能来自其他设备）与本地差异较大，平滑 seek
  if (_progressBgCheck){
    _progressBgCheck.then(p => {
      try{
        if (!p || !Number.isFinite(p.position) || !Number.isFinite(p.duration)) return;
        if (p.duration < 1) return;
        if (p.position / p.duration >= PROGRESS_COMPLETE_RATIO) return;
        if (player.ids[player.index] !== candId) return; // 已切集，放弃
        // 用逻辑时间做比较（audio 模式扣除 bias）
        const { pos: curLogical } = getLogicalPosDur();
        if (p.position - curLogical < PROGRESS_SERVER_OVERRIDE_DELTA_SEC) return;

        // seek：video 模式直接用逻辑时间；audio 模式需要加上 audioBias
        if (playbackMode === "audio"){
          const aEl = media.a || $("bgAudio");
          if (aEl) { try{ aEl.currentTime = Math.max(0, p.position + (audioBias||0)); }catch(_){} }
          // 同步 video 的逻辑时间（供下次切 video 模式用）
          const vEl = media.v || $("fsVideo");
          if (vEl) { try{ vEl.currentTime = p.position; }catch(_){} }
        } else {
          const vEl = media.v || $("fsVideo");
          if (vEl) { try{ vEl.currentTime = p.position; }catch(_){} }
          const aEl = media.a || $("bgAudio");
          if (aEl) { try{ aEl.currentTime = Math.max(0, p.position + (audioBias||0)); }catch(_){} }
        }
        showNotice("已同步到最新进度（来自其他设备）");
        setTimeout(clearNotice, 1600);
      }catch(_){}
    }).catch(()=>{});
  }
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
async function nextInPlaylist(){
  if (player.index < player.ids.length - 1){ await playIndex(player.index + 1, { resumeAt: 0 }); return; }
  if (player.loop && player.ids.length > 0){ await playIndex(0, { resumeAt: 0 }); }
}

async function exitPlayer(){
  cancelProgressive();
  hidePlaylistPanel();
  disarmFirstPlayWatch();
  // 退出前先抢存一次进度（在 src 释放之前才能拿到 currentTime）
  if (shouldPersistPlaybackState()) try{
    const curId = player?.ids?.[player.index];
    const { pos, dur } = getLogicalPosDur();
    if (curId && Number.isFinite(pos) && Number.isFinite(dur) && dur >= 1){
      if (maybeMarkPlaybackComplete(curId, pos, dur)){
        /* done */
      } else if (pos >= PROGRESS_MIN_POSITION_SEC && pos / dur >= PROGRESS_START_RATIO){
        apiSaveProgress(curId, pos, dur);
      } else {
        // 退出时进度过小：区分"误点退出"vs"主动拖回开头"
        // 判据：本次会话曾经保存过更大的进度，或本地缓存中该视频原本就有记录
        // → 属于主动倒回，清除进度；否则（纯误点）保留旧记录
        const prevSavedPos = (progressSaveState.id === String(curId))
          ? (progressSaveState.lastSavedPos || 0) : 0;
        const local = progressLocalCache.get(String(curId));
        const hadProgress = prevSavedPos > PROGRESS_MIN_POSITION_SEC
          || (local && (local.position || 0) > PROGRESS_MIN_POSITION_SEC);
        if (hadProgress) apiClearProgress(curId);
      }
    }
  }catch(_){}
  try {
    if (customControls.orientationLocked && screen.orientation && typeof screen.orientation.unlock === "function") {
      screen.orientation.unlock();
    }
    customControls.orientationLocked = false;
  } catch(_){}
  try { if (document.fullscreenElement) await document.exitFullscreen(); } catch(_){}
  const wrap = $("playerFS"); const v = $("fsVideo"); const a = $("bgAudio");
  const shouldFlushScanRefresh = !!scanWatch.pending;
  stopCustomControlsTicker();
  try { v.pause(); } catch(_){}
  try { a.pause(); } catch(_){}
  // ★ 必须先 teardownMSE（设 destroyed=true）再动 v.src
  // 否则 v.src 变更会触发 MS 的 sourceclose，被 mse-player 误判为异常关闭 → fail → 回落原生 → 再 attach 一次
  try { teardownMSE(v); } catch(_){}
  try { v.removeAttribute("src"); v.load(); } catch(_){}
  try { a.removeAttribute("src"); a.load(); } catch(_){}
  wrap.style.display = "none";
  wrap.classList.remove("touch-locked", "switching");
  if (typeof window.__setTouchLocked === "function") window.__setTouchLocked(false);
  else window.__touchLocked = false;
  $("playlistPanel").classList.add("hidden");
  stopBgAdvanceGuard(); stopPosTicker(); stopFgSync(); stopBgKeepAlive();
  stopProgressTicker();
  resetProgressSaveState();
  resumeGridImageLoads();

  document.documentElement.classList.remove("noscroll");
  document.body.classList.remove("noscroll");
  removeFsGuards();

  // 恢复进入播放器前的滚动位置
  try{
    if (typeof window !== "undefined"){
      const y = player.returnScrollY || 0;
      window.scrollTo(0, y);
    }
  }catch(_){}
  if (shouldFlushScanRefresh){
    setTimeout(()=>{ flushPendingScanRefresh(); }, 0);
  }
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
  await startPlaylist(initial, 0, state.path, { ignoreProgress: true });
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
async function getFolderItems(path, {withOrientation=false}={}){
  const params = new URLSearchParams({ path, sort_idx: state.sort_idx, mature_only: state.mature_only, with_meta: "1" });
  if (withOrientation) params.set("with_orientation", "1");
  const r = await fetch(`/api/folder_videos?${params.toString()}`);
  const j = await r.json();
  return (j.items || []).map(it => ({
    id: String(it.id),
    title: it.title || `视频 ${it.id}`,
    orientation: it.orientation || "unknown",
    width: Number(it.width || 0),
    height: Number(it.height || 0),
  }));
}
function getCurrentlyLoadedVideoItems(){
  const out = []; for (const t of state.tiles){ if (t.type === "video") out.push({ id:String(t.vid), title:t.title || `视频 ${t.vid}` }); }
  return out;
}

/* ============== 事件委托 & 菜单 ============== */

function getTile(target){ const el = target.closest(".tile"); if(!el) return null; const idx = parseInt(el.dataset.idx,10); return state.tiles[idx] || null; }

function hideWallpaperTileMenus(exceptEl=null){
  try{
    document.querySelectorAll(".wallpaper-tile-menu").forEach(el=>{
      if (exceptEl && el === exceptEl) return;
      el.remove();
    });
  }catch(_){}
}
function openWallpaperTileMenu(t){
  if (!WALLPAPER_MODE || !t || (t.type !== "video" && t.type !== "folder")) return;
  hideMenu();
  hideWallpaperTileMenus();

  const menu = document.createElement("div");
  menu.className = "wallpaper-tile-menu";
  menu.addEventListener("click", e=>{ e.stopPropagation(); });
  menu.addEventListener("pointerdown", e=>{ e.stopPropagation(); }, {passive:true});

  const add = (text, fn, {close=true}={})=>{
    const item = document.createElement("button");
    item.type = "button";
    item.className = "wallpaper-tile-menu-item";
    item.textContent = text;
    item.onclick = async (e)=>{
      e.preventDefault();
      e.stopPropagation();
      if (close) hideWallpaperTileMenus();
      try{ await (fn && fn()); }catch(err){ console.error(err); }
    };
    menu.appendChild(item);
  };
  const filterByOrientation = (items, orientation)=>{
    if (orientation === "all") return items;
    return (items || []).filter(it => it.orientation === orientation);
  };
  const openFolderOrientationMenu = (path, mode)=>{
    menu.innerHTML = "";
    const run = async (orientation)=>{
      const all = await getFolderItems(path, {withOrientation:true});
      const items = filterByOrientation(all, orientation);
      const label = orientation === "portrait" ? "竖屏" : (orientation === "landscape" ? "横屏" : "全部");
      if (!items.length){ alert(`该文件夹没有可播放的${label}视频`); return; }
      primeBusy("正在启动播放器…");
      if (mode === "loop") await startPlaylist(items, 0, path, {loop:true});
      else if (mode === "random") await startPlaylist(weightedRandomOrder(items), 0, path);
      else await startPlaylist(items, 0, path);
    };
    add("竖屏", ()=>run("portrait"));
    add("横屏", ()=>run("landscape"));
    add("全部", ()=>run("all"));
  };

  if (t.type === "video"){
    const vid = String(t.vid);
    const title = t.title || `视频 ${vid}`;
    add("播放此视频", async ()=>{
      primeBusy("正在启动播放器…");
      await startPlaylist([{id:vid, title}], 0, state.path);
    });
    add("循环播放", async ()=>{
      primeBusy("正在启动播放器…");
      await startPlaylist([{id:vid, title}], 0, state.path, {loop:true});
    });
    add("从该处开始播放（忽略已完成）", async ()=>{
      await handlePlayFromHereProgressive(vid, title);
    });
  } else {
    const path = t.path;
    add("打开此文件夹", async ()=>{
      navigateToPath(path);
    });
    add("播放此文件夹", async ()=>{
      openFolderOrientationMenu(path, "play");
    }, {close:false});
    add("循环播放此文件夹", async ()=>{
      openFolderOrientationMenu(path, "loop");
    }, {close:false});
    add("随机播放此文件夹", async ()=>{
      openFolderOrientationMenu(path, "random");
    }, {close:false});
  }

  t.el.appendChild(menu);
  setTimeout(()=>{
    const close = (ev)=>{
      if (menu.contains(ev.target)) return;
      hideWallpaperTileMenus();
      document.removeEventListener("click", close, true);
    };
    document.addEventListener("click", close, true);
  }, 0);
}

/* ★★★ 修改：取消订阅/批量取消订阅：统一复用 Steam「已订阅物品主页」并 postMessage 投递 IDs（不再打开详情页） ★★★ */
// 缓存 Steam 订阅页窗口句柄：避免每次 window.open("", name) 都可能把焦点切过去
let STEAM_BULK_UNSUB_WIN = null;
async function openBulkUnsub(ids, batch=1){
  try{
    const uniq = Array.from(new Set((ids||[]).map(String).filter(Boolean)));
    if (!uniq.length){ alert("没有可处理的条目"); return; }

    const steamIds = uniq.filter(isSteamWorkshopVid);
    const localIds = uniq.filter(id => !isSteamWorkshopVid(id));

    let msg;
    if (steamIds.length && localIds.length){
      msg = `将对 ${steamIds.length} 个创意工坊条目通过 Steam 取消订阅并删除本地；另有 ${localIds.length} 个本地非订阅项目将直接删除（不经过 Steam）。是否继续？`;
    } else if (steamIds.length){
      msg = `是否取消订阅${steamIds.length}个项目？会同时删除本地文件！`;
    } else {
      msg = `所选 ${localIds.length} 项为非 Steam 创意工坊订阅，将只从本机删除项目文件，不会打开 Steam。是否继续？`;
    }
    const okGo = confirm(msg);
    if (!okGo) return;

    // ★★ UI立即响应：秒删这些项目，然后在后台异步执行取消订阅和删除本地文件 ★★
    removeTilesByVideoIds(uniq);
    clearSel();
    showNotice(steamIds.length ? `正在处理 ${uniq.length} 项…` : `正在删除 ${localIds.length} 项本地项目…`);

    // ★★ 后续流程全部在后台异步执行，不阻塞UI ★★
    (async () => {
      try {
        // 非创意工坊：直接走删除 API，不投递 Steam
        if (localIds.length){
          const okL = await deleteByIds(localIds);
          if (!okL){
            showNotice("部分本地非订阅项目删除失败，请稍后重试");
            setTimeout(clearNotice, 3500);
          }
        }

        if (!steamIds.length){
          showNotice(localIds.length ? `已完成 ${localIds.length} 项本地删除` : "已完成");
          setTimeout(clearNotice, 2000);
          return;
        }

    // 统一：打开/复用订阅主页（不携带 workshop 详情页 id；不固化账号）
    // 使用 /my/ 指向当前登录账号，适合提交到 GitHub 的通用版本
    const steamSubUrl =
      "https://steamcommunity.com/my/myworkshopfiles?browsesort=mysubscriptions&browsefilter=mysubscriptions&appid=431960&p=1#bulk_unsub=1";

    // 用固定 window.name 复用同一个标签页；如果已开，不会新开
    const winName = "steam-bulk-unsub";
    // 注意：不要用 noopener，否则部分浏览器会让 window 引用变成 null，导致无法 postMessage 投递任务
        // 关键：不要每次都 window.open("", name) "查找窗口"，很多浏览器会因此把标签页置前（抢焦点）。
    // 改为缓存句柄，后续直接复用句柄发 postMessage；仅在缺失/已关闭时才真正 window.open(url,name)。
    let w = STEAM_BULK_UNSUB_WIN;
    let openedOrNavigated = false;
        
        // ★ 改进的窗口可用性检查：不仅检查 closed，还要测试窗口是否真的可用
        let needNewWindow = false;
        if (!w){
          needNewWindow = true;
        } else {
          try{
            // 尝试访问 closed 属性，如果窗口已失效会抛异常
            if (w.closed){
              needNewWindow = true;
            }
          }catch(_){
            // 窗口句柄已失效（可能被浏览器回收）
            needNewWindow = true;
          }
        }
        
        if (needNewWindow){
      w = window.open(steamSubUrl, winName);
      STEAM_BULK_UNSUB_WIN = w;
      openedOrNavigated = !!w;
    } else {
          // 窗口存在且未关闭，检查是否需要导航
      try{
        const href = (w.location && w.location.href) ? String(w.location.href) : "";
        if (href === "about:blank" || href === "") {
          try{ w.location.replace(steamSubUrl); }catch(_){ try{ w.location.href = steamSubUrl; }catch(__){} }
          openedOrNavigated = true;
        }
            // 如果已经在Steam页面，不做任何操作，直接复用
      }catch(_){
        // 跨域时无法读取 location：说明已经在 Steam 页面，无需刷新/导航
            // 这是正常情况，窗口已经在Steam页面了
      }
    }
    if (!w){
          showNotice("无法打开 Steam 页面（可能被浏览器拦截了弹窗）");
          setTimeout(clearNotice, 3000);
      return;
        }

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
      const payload = { type: "bulk_unsub_add", ids: steamIds, reqId };
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
            showNotice("已打开订阅页，但未收到脚本确认（可能脚本未启用/未加载）");
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
        showNotice(`任务已投递：${steamIds.length} 项（等待 Steam 侧完成）`);
      setTimeout(clearNotice, 2500);

        // 等待 DONE（给足时间：最多 1 小时，避免大批量时误删本地）
      const doneDeadline = Date.now() + 60*60*1000;
      while (!donePayload && Date.now() < doneDeadline) await new Promise(r=>setTimeout(r, 250));
        try{ window.removeEventListener("message", onMsg); }catch(_){}
      if (!donePayload){
          showNotice("未收到完成回执，本地不会删除");
        setTimeout(clearNotice, 4500);
        return;
      }

        // 收到完成回执后再静默删除本地文件
        showNotice(`Steam 取消订阅完成（成功:${donePayload.ok||0}），正在后台删除创意工坊本地文件…`);
        setTimeout(clearNotice, 2000);

        // ★★ 后台静默删除创意工坊本地目录（myprojects 等已在流程前删除） ★★
    const ok = await deleteByIds(steamIds);

    if (!ok){
          showNotice("创意工坊本地文件删除失败，请稍后重试");
          setTimeout(clearNotice, 3000);
    } else {
          const tail = localIds.length ? `（另已删 ${localIds.length} 项本地项目）` : "";
          showNotice(`已完成 ${steamIds.length} 项的取消订阅和本地删除${tail}`);
          setTimeout(clearNotice, 2000);
    }
      } catch(err) {
        console.error("[openBulkUnsub] 后台处理出错:", err);
        showNotice("取消订阅处理过程中出现错误");
        setTimeout(clearNotice, 3000);
      }
    })(); // 立即执行异步函数，不等待结果

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
  // 视频被删除/取消订阅后，自动关闭其对应的浮窗播放器
  set.forEach(id=>{ try{ closeWatchFloatPanel(id); }catch(_){} });
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
  installTileTextPickGuard(el);

  //---------------------------------------------------------
  // 左键点击处理 (保持不变)
  //---------------------------------------------------------
  el.addEventListener("click", async (ev)=>{
    if (folderDropShouldSuppressClick()){
      ev.preventDefault();
      ev.stopPropagation();
      return;
    }
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

    if (t.type === "video" && shouldIgnoreTileClick(t)) {
      ev.preventDefault();
      ev.stopPropagation();
      clearTileTextPickSuppress();
      return;
    }

    if (t.type === "parent") {
      ev.preventDefault();
      navigateToPath(t.path || "/");
      return;
    }

    // Alt+点击：打开浮动播放窗（可连续多个，各自独立加载，始终浮在主页上方）
    if (ev.altKey && t.type === "video") {
      ev.preventDefault();
      ev.stopPropagation();
      openPopoutWatch(t.vid, t.title);
      return;
    }

    if (WALLPAPER_MODE && (t.type === "video" || t.type === "folder")){
      ev.preventDefault();
      ev.stopPropagation();
      openWallpaperTileMenu(t);
      return;
    }

    // CTRL 多选
    if (ev.ctrlKey) {
      setSel(t, !isSel(t));
      state.lastIdx=t.idx;
      ev.preventDefault();
      return;
    }

    // SHIFT 连选
    if (shouldRangeSelect(ev)) {
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
    if (t.type === "video") {
      const textEl = ev.target.closest(".tile .title, .tile .author");
      if (textEl) {
        t.el.classList.add("pulse");
        setTimeout(()=> t.el.classList.remove("pulse"), 200);
        clearSel();
        setSel(t, true);
        state.lastIdx = t.idx;
        ev.preventDefault();
        return;
      }
    }

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

      if (t.type === "parent"){
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

function positionMenuEl(menu, x, y){
  const vw = window.innerWidth, vh = window.innerHeight;
  menu.style.left = x + "px";
  menu.style.top = y + "px";
  // 读出实际尺寸后再微调，保证完全落在可视区域内
  const rect = menu.getBoundingClientRect();
  let nx = rect.left, ny = rect.top;
  if (rect.right > vw) nx = Math.max(4, vw - rect.width - 4);
  if (rect.bottom > vh) ny = Math.max(4, vh - rect.height - 4);
  if (rect.left < 0) nx = 4;
  if (rect.top < 0) ny = 4;
  menu.style.left = nx + "px";
  menu.style.top  = ny + "px";
}

function openContextMenu(x,y){
  const menu = $("ctxmenu");
  const submenu = $("ctxsubmenu");
  menu.innerHTML=""; menu.style.display="block";
  if (submenu){ submenu.style.display="none"; }
  try{ menu.classList.remove("move-submenu"); }catch(_){}
  const selCount = state.selV.size + state.selF.size;
  const onlyOne = selCount === 1;
  const oneVideo = onlyOne && state.selV.size === 1;
  const oneFolder = onlyOne && state.selF.size === 1;
  // 点击菜单内部不要冒泡到 document（否则会触发 click-away 立刻关闭，二级菜单也打不开）
  if (!menu._stopPropBound){
    menu._stopPropBound = true;
    menu.addEventListener("click", (e)=>{ try{ e.stopPropagation(); }catch(_){} });
    menu.addEventListener("pointerdown", (e)=>{ try{ e.stopPropagation(); }catch(_){} }, {passive:true});
  }

  function hideSubmenu(){
    const sm = $("ctxsubmenu");
    if (sm) sm.style.display = "none";
  }

  function openInlineSubMenu(anchorEl, entries, opts={}){
    const sm = $("ctxsubmenu");
    if (!sm) return;
    const paged = !!opts.paged;
    const all = entries || [];
    const vh = window.innerHeight || 800;
    const vw = window.innerWidth || 1200;
    const ar = anchorEl.getBoundingClientRect();

    function renderItems(list){
      list.forEach(ent=>{
        const d = document.createElement("div");
        d.className = "item";
        d.textContent = ent.text;
        d.onclick = ()=>{ hideMenu(); ent.fn && ent.fn(); };
        sm.appendChild(d);
      });
    }

    function positionSm(){
      const r = sm.getBoundingClientRect();
      let left = ar.right;
      if (left + r.width > vw) left = ar.left - r.width - 2;
      let top = ar.top;
      if (top + r.height > vh) top = Math.max(4, vh - r.height - 4);
      if (top < 0) top = 4;
      sm.style.left = left + "px";
      sm.style.top  = top + "px";
    }

    if (!paged){
      sm.innerHTML = "";
      renderItems(all);
      sm.style.display = "block";
      positionSm();
      return;
    }

    // 先尝试全部渲染，测量实际高度
    sm.innerHTML = "";
    renderItems(all);
    sm.style.display = "block";
    sm.style.left = "-9999px"; sm.style.top = "0";
    const actualH = sm.getBoundingClientRect().height;
    const maxH = vh - 20;

    if (actualH <= maxH){
      // 实际高度可以放下：不分页，只调整位置
      anchorEl._submenuOffset = 0;
      positionSm();
      return;
    }

    // 实际高度放不下：需要分页
    const itemCount = sm.querySelectorAll(".item").length;
    const lineH = itemCount > 0 ? actualH / itemCount : 36;
    const MAX_VISIBLE = Math.max(4, Math.floor(maxH / lineH));
    let start = anchorEl._submenuOffset || 0;
    start = Math.max(0, Math.min(start, all.length - MAX_VISIBLE));
    const end = Math.min(all.length, start + MAX_VISIBLE);

    sm.innerHTML = "";
    if (start > 0){
      const up = document.createElement("div");
      up.className = "item";
      up.textContent = "▲";
      up.onclick = (e)=>{
        e.stopPropagation();
        anchorEl._submenuOffset = Math.max(0, start - MAX_VISIBLE);
        openInlineSubMenu(anchorEl, all, {paged:true});
      };
      sm.appendChild(up);
    }
    for (let i=start;i<end;i++){
      const ent = all[i];
      const d = document.createElement("div");
      d.className = "item";
      d.textContent = ent.text;
      d.onclick = ()=>{ hideMenu(); ent.fn && ent.fn(); };
      sm.appendChild(d);
    }
    if (end < all.length){
      const down = document.createElement("div");
      down.className = "item";
      down.textContent = "▼";
      down.onclick = (e)=>{
        e.stopPropagation();
        anchorEl._submenuOffset = Math.min(all.length - MAX_VISIBLE, start + MAX_VISIBLE);
        openInlineSubMenu(anchorEl, all, {paged:true});
      };
      sm.appendChild(down);
    }
    positionSm();
  }

  function add(text, fn, {keepOpen=false, submenuEntries=null, submenuAsyncLoader=null}={}){
    const d=document.createElement("div");
    d.className="item";
    d.textContent=text;
    d.onclick=()=>{
      if (!keepOpen) hideMenu();
      fn && fn();
    };
    // 鼠标移入时自动弹出二级菜单
    if (submenuEntries){
      d.classList.add("has-submenu");
      d.addEventListener("mouseenter", ()=> openInlineSubMenu(d, submenuEntries, {paged:false}));
    } else if (submenuAsyncLoader){
      d.classList.add("has-submenu");
      let loaded = false;
      let cached = [];
      d.addEventListener("mouseenter", async ()=>{
        if (!loaded){
          try{
            cached = await submenuAsyncLoader();
            loaded = true;
            d._submenuOffset = 0;
          }catch(_){
            cached = [{ text:"加载失败", fn: ()=>{} }];
            loaded = true;
          }
        }
        openInlineSubMenu(d, cached, {paged:true});
      });
    }
    menu.appendChild(d);
  }
  // ★ 二级菜单：复用同一个 ctxmenu，提供“返回”
  function openSubMenu(title, entries){
    try{ menu.classList.remove("move-submenu"); }catch(_){}
    // entries: [{text, fn}]
    menu.innerHTML = "";
    const back = document.createElement("div");
    back.className = "item";
    back.textContent = "← 返回";
    back.onclick = ()=>{ openContextMenu(x,y); };
    menu.appendChild(back);
    const hdr = document.createElement("div");
    hdr.className = "sep";
    menu.appendChild(hdr);
    (entries||[]).forEach(ent=>{
      const d = document.createElement("div");
      d.className = "item";
      d.textContent = ent.text;
      d.onclick = ()=>{ hideMenu(); ent.fn && ent.fn(); };
      menu.appendChild(d);
    });
  }
  // ★ 二级菜单（异步填充）：用于“移动到…”这种需要拉取文件夹树的场景
  function openSubMenuAsync(title, loader, {moveStyle=false}={}){
    try{ menu.classList.toggle("move-submenu", !!moveStyle); }catch(_){}
    menu.innerHTML = "";
    const back = document.createElement("div");
    back.className = "item";
    back.textContent = "← 返回";
    back.onclick = ()=>{ openContextMenu(x,y); };
    menu.appendChild(back);
    const hdr = document.createElement("div");
    hdr.className = "sep";
    menu.appendChild(hdr);
    const loading = document.createElement("div");
    loading.className = "item";
    loading.textContent = `${title}：加载中…`;
    loading.onclick = ()=>{};
    menu.appendChild(loading);

    (async ()=>{
      try{
        const entries = await loader();
        // 如果用户已返回上一级/关闭菜单，则不再覆盖
        if (menu.style.display === "none") return;
        try{ menu.classList.toggle("move-submenu", !!moveStyle); }catch(_){}
        // 重新渲染同一个子菜单
        menu.innerHTML = "";
        const back2 = document.createElement("div");
        back2.className = "item";
        back2.textContent = "← 返回";
        back2.onclick = ()=>{ openContextMenu(x,y); };
        menu.appendChild(back2);
        const hdr2 = document.createElement("div");
        hdr2.className = "sep";
        menu.appendChild(hdr2);
        (entries||[]).forEach(ent=>{
          const d = document.createElement("div");
          d.className = "item";
          d.textContent = ent.text;
          d.onclick = ()=>{ hideMenu(); ent.fn && ent.fn(); };
          menu.appendChild(d);
        });
      }catch(_){
        try{
          loading.textContent = `${title}：加载失败`;
        }catch(__){}
      }
    })();
  }
  function openMoveSubMenu(getPayload){
    openSubMenuAsync("移动到…", async ()=>{
      const payload = typeof getPayload === "function" ? getPayload() : getPayload;
      return buildMoveSubmenuEntries(payload);
    }, {moveStyle:true});
  }
  function addMoveToMenu(){
    add("移动到…", ()=>{}, {
      keepOpen:true,
      submenuAsyncLoader: moveSubmenuLoader(()=> collectMovePayload()),
    });
  }
  function sep(){ const s=document.createElement("div"); s.className="sep"; menu.appendChild(s); }

  if (oneVideo) {
    const vid = [...state.selV][0];
    const title = (state.tiles.find(t=>t.vid===vid)?.title) || `视频 ${vid}`;
    add("播放", ()=>{}, {
      keepOpen:true,
      submenuEntries:[
        { text:"播放此视频", fn: ()=> { primeBusy("正在启动播放器…"); startPlaylist([{id:vid, title}], 0, state.path); } },
        { text:"循环播放", fn: ()=> { primeBusy("正在启动播放器…"); startPlaylist([{id:vid, title}], 0, state.path, {loop:true}); } },
        { text:"从该处开始播放（忽略已完成）", fn: async ()=>{ await handlePlayFromHereProgressive(vid, title); } },
      ]
    });
    if (isSteamWorkshopVid(vid)){
      add("打开创意工坊链接", ()=> window.open(`https://steamcommunity.com/sharedfiles/filedetails/?id=${vid}`, "_blank"));
    }
    add("修复…", ()=> openSubMenu("修复", [
      { text:"强制转码修复（推荐）", fn: async ()=>{ await repairVideoAndReload(vid, "reencode"); } },
      { text:"无损重封装（可能无效）", fn: async ()=>{ await repairVideoAndReload(vid, "copy"); } },
    ]), {keepOpen:true});
    if (isSteamWorkshopVid(vid)){
      add("取消订阅", ()=> openBulkUnsub([vid], 0));  // batch=0 表示单项模式
    }
    sep();
    addMoveToMenu();
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
    add("播放", ()=>{}, {
      keepOpen:true,
      submenuEntries:[
        { text:"播放此文件夹", fn: async ()=>{ await progressivePlayFolder(path); } },
        { text:"循环播放此文件夹", fn: async ()=>{
            const all = await getFolderItems(path);
            if (!all.length){ alert("该文件夹没有可播放视频"); return; }
            primeBusy("正在启动播放器…");
            await startPlaylist(all, 0, path, {loop:true});
          } },
        { text:"随机播放此文件夹", fn: async ()=>{
            const all = await getFolderItems(path);
            if (!all.length){ alert("该文件夹没有可播放视频"); return; }
            const shuffled = weightedRandomOrder(all);
            primeBusy("正在启动播放器…");
            await startPlaylist(shuffled, 0, path);
          } },
      ]
    });
    sep();
    add("在该文件夹下新建子文件夹…", ()=> promptCreateFolder(path));
    sep();
    addMoveToMenu();
    sep();
    add("删除", ()=>{}, {
      keepOpen:true,
      submenuEntries:[
        {
          text:"删除所有视频",
          fn: async ()=>{
            const items = await getFolderItems(path);
            if (!items.length){ alert("该文件夹下没有可删除的视频"); return; }
            if (!confirm(`确认永久删除该文件夹下的 ${items.length} 个视频？此操作不可恢复。`)) return;
            const ids = items.map(x=>String(x.id));
            const ok = await deleteByIds(ids);
            if (!ok){ alert("删除失败，请稍后重试"); return; }
            removeTilesByVideoIds(ids);
            clearSel();
          }
        },
        {
          text:"删除文件夹及所有视频",
          fn: async ()=>{
            const items = await getFolderItems(path);
            const ids = items.map(x=>String(x.id));
            if (!ids.length){
              if (!confirm("确认从分类中删除此文件夹？此操作不可恢复。")) return;
            }else{
              if (!confirm(`确认永久删除该文件夹及其中 ${ids.length} 个视频？此操作不可恢复。`)) return;
            }
            if (ids.length){
              const ok = await deleteByIds(ids);
              if (!ok){ alert("删除视频失败，请稍后重试"); return; }
              removeTilesByVideoIds(ids);
            }
            await fetch("/api/folder/delete", {
              method:"POST",
              headers:{"Content-Type":"application/json"},
              body: JSON.stringify({ paths:[path] })
            });
            clearSel();
            changeContext({});
          }
        },
      ]
    });
    sep();
    add("在当前路径新建文件夹…", ()=> promptCreateFolder(state.path));
  } else {
    add("播放", ()=>{}, {
      keepOpen:true,
      submenuEntries:[
        { text:"批量播放", fn: async ()=>{ await progressivePlaySelection(); } },
        { text:"批量循环播放", fn: async ()=>{
            const selVideos = [...state.selV].map(String), selFolders = [...state.selF];
            let items = selVideos.map(id => ({ id, title: (state.tiles.find(t=>t.vid===id)?.title) || `视频 ${id}` }));
            for (const folderPath of selFolders){
              const folderItems = await getFolderItems(folderPath);
              items = items.concat(folderItems);
            }
            if (!items.length){ alert("所选没有可播放视频"); return; }
            primeBusy("正在启动播放器…");
            await startPlaylist(items, 0, state.path, {loop:true});
          } },
        { text:"随机播放", fn: async ()=>{
            const selVideos = [...state.selV].map(String), selFolders = [...state.selF];
            let items = selVideos.map(id => ({ id, title: (state.tiles.find(t=>t.vid===id)?.title) || `视频 ${id}` }));
            for (const folderPath of selFolders){
              const folderItems = await getFolderItems(folderPath);
              items = items.concat(folderItems);
            }
            if (!items.length){ alert("所选没有可播放视频"); return; }
            const shuffled = weightedRandomOrder(items);
            primeBusy("正在启动播放器…");
            await startPlaylist(shuffled, 0, state.path);
          } },
      ]
    });
    add("批量取消订阅", async ()=>{
      const items = await expandSelectionToItems();
      const ids = items.map(x=>String(x.id));
      if (!ids.length){ alert("所选没有可取消订阅的条目"); return; }
      await openBulkUnsub(ids, 2);  // batch=2 表示批量模式
    });
    sep();
    addMoveToMenu();
    sep();
    add("删除", ()=>{}, {
      keepOpen:true,
      submenuEntries:[
        {
          text:"删除所有视频",
          fn: async ()=>{
            const items = await expandSelectionToItems();
            if (!items.length) return alert("所选没有可删除的项目");
            if (!confirm(`确认永久删除所选 ${items.length} 个视频？此操作不可恢复。`)) return;
            const ids = items.map(x=>x.id);
            const ok = await deleteByIds(ids);
            if (!ok){ alert("删除失败，请稍后重试"); return; }
            removeTilesByVideoIds(ids);
            clearSel();
          }
        },
        {
          text:"删除文件夹及所有视频",
          fn: async ()=>{
            const items = await expandSelectionToItems();
            const ids = items.map(x=>x.id);
            const folderPaths = [...state.selF];
            if (!ids.length && !folderPaths.length){
              alert("所选没有可删除的项目"); return;
            }
            const total = ids.length;
            if (!confirm(`确认永久删除所选文件夹及其中 ${total} 个视频？此操作不可恢复。`)) return;
            if (ids.length){
              const ok = await deleteByIds(ids);
              if (!ok){ alert("删除视频失败，请稍后重试"); return; }
              removeTilesByVideoIds(ids);
            }
            if (folderPaths.length){
              await fetch("/api/folder/delete", {
                method:"POST",
                headers:{"Content-Type":"application/json"},
                body: JSON.stringify({ paths: folderPaths })
              });
            }
            clearSel();
            changeContext({});
          }
        },
      ]
    });
    sep();
    add("在当前路径新建文件夹…", ()=> promptCreateFolder(state.path));
  }

  positionMenuEl(menu, x, y);
  setTimeout(()=> document.addEventListener("click", hideMenu, {once:true}), 0);
}
function hideMenu(){
  const m = $("ctxmenu");
  const sm = $("ctxsubmenu");
  if (m) m.style.display = "none";
  if (sm) sm.style.display = "none";
  hideWallpaperTileMenus();
}

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

function initCustomSortSelect(){
  const native = $("sort");
  if (!native || native._customSortReady) return;
  native._customSortReady = true;
  native.classList.add("native-hidden-select");

  const wrap = document.createElement("div");
  wrap.className = "glass-select";
  wrap.innerHTML = `
    <button type="button" class="glass-select-btn" aria-haspopup="listbox" aria-expanded="false">
      <span class="glass-select-text"></span>
      ${cpcIcon("chevronDown")}
    </button>
    <div class="glass-select-menu" role="listbox"></div>
  `;
  native.insertAdjacentElement("afterend", wrap);

  const btn = wrap.querySelector(".glass-select-btn");
  const text = wrap.querySelector(".glass-select-text");
  const menu = wrap.querySelector(".glass-select-menu");

  const syncLabel = ()=>{
    const opt = native.options[native.selectedIndex];
    text.textContent = opt ? opt.textContent : "";
  };
  const close = ()=>{
    wrap.classList.remove("open");
    btn.setAttribute("aria-expanded", "false");
  };
  const open = ()=>{
    wrap.classList.add("open");
    btn.setAttribute("aria-expanded", "true");
  };
  const rebuild = ()=>{
    menu.innerHTML = "";
    Array.from(native.options).forEach((opt)=>{
      const item = document.createElement("button");
      item.type = "button";
      item.className = "glass-select-item";
      item.setAttribute("role", "option");
      item.dataset.value = opt.value;
      item.textContent = opt.textContent;
      if (opt.selected) item.classList.add("selected");
      item.onclick = (ev)=>{
        ev.preventDefault();
        ev.stopPropagation();
        native.value = opt.value;
        syncLabel();
        rebuild();
        close();
        changeContext({sort_idx: parseInt(native.value,10)});
      };
      menu.appendChild(item);
    });
  };

  btn.onclick = (ev)=>{
    ev.preventDefault();
    ev.stopPropagation();
    if (wrap.classList.contains("open")) close();
    else { rebuild(); open(); }
  };
  document.addEventListener("pointerdown", (ev)=>{
    if (!wrap.contains(ev.target)) close();
  });
  document.addEventListener("keydown", (ev)=>{
    if (ev.key === "Escape") close();
  });
  syncLabel();
  rebuild();
}

$("sort") && ($("sort").onchange = ()=> changeContext({sort_idx: parseInt($("sort").value,10)}));
initCustomSortSelect();
$("mature") && ($("mature").onchange = ()=> changeContext({mature_only: $("mature").checked}));
$("refresh") && ($("refresh").onclick = ()=> refreshCurrentScanContext("manual"));
let qTimer=null;
$("q") && ($("q").oninput = ()=>{ clearTimeout(qTimer); qTimer=setTimeout(()=> changeContext({q:$("q").value.trim()}), 250); });
$("playUnwatched") && ($("playUnwatched").onclick = handlePlayUnwatched);

window.addEventListener("load", ()=>{
  if (POPOUT_MODE){
    installTitleTooltip();
    const title = URL_PARAMS.get("title") || `视频 ${POPOUT_VID}`;
    startPlaylist([{ id: POPOUT_VID, title }], 0, null);
    return;
  }
  installTitleTooltip();
  installFolderDrop();
  installMoveUndoHotkey();
  const initPath = pathFromHash();
  renderSkeleton(buildCrumbHtml(initPath));
  changeContext({path: initPath});
  startScanWatch();
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
  intervalMs:3000,     // 3s fast-tier heartbeat
  eps:0.2,             // 认为“几乎不动”的阈值（秒）
  needCount:6,         // 连续 6 次（≈18s）
  cooldownMs:45000,    // 掐断间隔 45s
  lastPos:0,
  stallCount:0,
  cooldownUntil:0,
  lastGoodLogical:0,
  lastWall: 0,
  slowPos:0, slowWall:0  // slow-tier: 60s-scale stall detection (replaces minuteResync)
};
/* gateHB 已整体移除：旧实现会在每次 `playing` 事件时打断 stallHB，造成每次 doSilentRestart
   之后约 5s 的监控盲区。功能已合并进 stallHB 的 slow-tier（60s 尺度）。 */
function _logicalAudioTime(aEl){
  const t = Number.isFinite(aEl?.currentTime) ? aEl.currentTime : 0;
  return Math.max(0, t - (audioBias||0));
}
function resetStallHeartbeat(aEl){
  stallHB.stallCount = 0;
  stallHB.lastPos = Number.isFinite(aEl?.currentTime) ? aEl.currentTime : 0;
  stallHB.cooldownUntil = 0; 
  stallHB.lastGoodLogical = _logicalAudioTime(aEl);
  stallHB.lastWall = performance.now();
  stallHB.slowPos = stallHB.lastPos;
  stallHB.slowWall = stallHB.lastWall;
}

/* ★ 抽出：心跳模块音频事件（可在替换音频后重复绑定） */
function bindAudioEventsForStallHBOn(a){
  if (!a || a._stallHBBound) return;
  a._stallHBBound = true;

  a.addEventListener("playing", ()=>{
    if (document.visibilityState === "hidden" && isPlayerActive() && playbackMode==="audio"){
      resetStallHeartbeat(a);
      startStallHeartbeat();
    }
  });
  a.addEventListener("pause", ()=>{
    resetStallHeartbeat(a);
    stopStallHeartbeat();
  });
  a.addEventListener("ended", ()=>{
    resetStallHeartbeat(a);
    stopStallHeartbeat();
  });
  a.addEventListener("seeking", ()=>{
    resetStallHeartbeat(a);
  });
  a.addEventListener("loadedmetadata", ()=>{
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
    updatePositionState(); startPosTicker();
    if (playbackMode==="audio" && !_userPaused) startBgKeepAlive();
    try{ if (!_userPaused) startMinuteResync(); }catch(_){}
  });
  a.addEventListener("pause",   ()=>{
    if (document.visibilityState==='visible' && playbackMode==='audio') markUserPaused();
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
  const predictedLogical = Math.max(0, (stallHB.lastGoodLogical || 0) + elapsed);
  const resumeAtLogical = predictedLogical;

  console.log(`[StallHB] ${phase} restart → resume at ${resumeAtLogical.toFixed(3)}s (logical, +${elapsed.toFixed(2)}s)`);

  try{
    // 1) 只创建新元素与 src，不立即播放
    const newSrc = audioSrcOf(id, /*cacheBust*/ true);
    const newAudio = new Audio();
    newAudio.src = newSrc;
    newAudio.preload = "auto";
    newAudio.muted = wasMuted;
    newAudio.volume = wasMuted ? 0 : Math.max(0.6, oldAudio?.volume || 0.6);

    // 2) 等待元数据（可安全 seek），带 8s 超时防止后台网络节流导致永久挂起
    await Promise.race([
      new Promise((resolve, reject)=>{
        newAudio.addEventListener("loadedmetadata", resolve, { once:true });
        newAudio.addEventListener("error", reject, { once:true });
        newAudio.load();
      }),
      new Promise((_, reject)=> setTimeout(()=> reject(new Error("metadata timeout")), 8000))
    ]);

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

    // 4) 显式清理旧元素（停止缓冲/网络），然后替换
    const old = $("bgAudio");
    if (old){
      try{ old.pause(); }catch(_){}
      try{ old.removeAttribute("src"); old.load(); }catch(_){}
      if (old.parentNode) old.parentNode.replaceChild(newAudio, old);
    }
    newAudio.id = "bgAudio";
    media.a = newAudio;

    // 5) 重新绑定项目依赖的所有音频事件
    bindAudioCoreEventsAfterReplace(newAudio);

    // 6) 播放（如原先在播放，且用户没有主动暂停）
    if (!wasPaused && !_userPaused){
      try { await newAudio.play(); } catch (err) {
        console.warn("[StallHB] play() failed:", err);
      }
    }

    // 7) 刷新心跳基线与锚点 & 记下墙钟
    stallHB.lastPos = Number.isFinite(newAudio.currentTime) ? newAudio.currentTime : 0;
    stallHB.lastGoodLogical = resumeAtLogical;
    stallHB.lastWall = performance.now();

    // 8) 刷新 MediaSession（Chrome 在进度停滞后可能移除通知，需要主动恢复）
    try{ setMediaSessionMeta(id); }catch(_){}
    updateMediaSessionPlaybackState();
    updatePositionState();
    startPosTicker();

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

  resetStallHeartbeat(a);
  stallHB.active = true;

  if (stallHB.timer) clearInterval(stallHB.timer);
  stallHB.timer = setInterval(async ()=>{
    const aEl = media.a || $("bgAudio");
    if (!isPlayerActive() || playbackMode!=="audio" || !aEl){ stopStallHeartbeat(); return; }
    if (document.visibilityState!=="hidden") return;
    if (_userPaused) return;

    // browser-paused: Chrome may pause the audio element without user intent
    if (aEl.paused){
      stallHB.lastWall = performance.now();
      stallHB.stallCount++;
      if (stallHB.stallCount >= stallHB.needCount){
        if (performance.now() >= stallHB.cooldownUntil){
          console.warn("[StallHB] audio paused by browser, restarting");
          await doSilentRestart(aEl, "browser-paused");
          const aa = media.a || $("bgAudio");
          stallHB.cooldownUntil = performance.now() + stallHB.cooldownMs;
          stallHB.stallCount = 0;
          stallHB.lastPos = Number.isFinite(aa?.currentTime) ? aa.currentTime : 0;
          stallHB.lastGoodLogical = _logicalAudioTime(aa);
          stallHB.lastWall = performance.now();
          stallHB.slowPos = stallHB.lastPos;
          stallHB.slowWall = stallHB.lastWall;
        } else { stallHB.stallCount = 0; }
      }
      return;
    }

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
    } else {
      stallHB.stallCount++;
    }

    // fast-tier: 6 consecutive stalls (~18s) -> restart
    if (stallHB.stallCount >= stallHB.needCount){
      if (performance.now() < stallHB.cooldownUntil){
        stallHB.stallCount = 0;
        return;
      }
      // ★ 改为“硬重启”以保证后台 seek 生效
      await doSilentRestart(aEl, "stallHB");
      const aa = media.a || $("bgAudio");
      stallHB.cooldownUntil = performance.now() + stallHB.cooldownMs;
      stallHB.stallCount = 0;
      stallHB.lastPos = Number.isFinite(aa?.currentTime) ? aa.currentTime : 0;
      stallHB.lastGoodLogical = _logicalAudioTime(aa);
      stallHB.lastWall = performance.now();
      stallHB.slowPos = stallHB.lastPos;
      stallHB.slowWall = stallHB.lastWall;
      return;
    }

    // slow-tier (~60s check, replaces standalone minuteResync)
    const _slowElapsed = stallHB.lastWall - stallHB.slowWall;
    if (_slowElapsed >= 60000){
      const _slowAdv = pos - stallHB.slowPos;
      stallHB.slowPos = pos;
      stallHB.slowWall = stallHB.lastWall;
      if (_slowAdv < 1 && performance.now() >= stallHB.cooldownUntil){
        console.warn("[StallHB] slow-tier: <1s progress in 60s, restarting");
        await doSilentRestart(aEl, "slow-tier");
        const ab = media.a || $("bgAudio");
        stallHB.cooldownUntil = performance.now() + stallHB.cooldownMs;
        stallHB.stallCount = 0;
        stallHB.lastPos = Number.isFinite(ab?.currentTime) ? ab.currentTime : 0;
        stallHB.lastGoodLogical = _logicalAudioTime(ab);
        stallHB.lastWall = performance.now();
        stallHB.slowPos = stallHB.lastPos;
        stallHB.slowWall = stallHB.lastWall;
      }
    }
  }, stallHB.intervalMs);
}

/* Minute Resync 已并入 stallHB 的 slow-tier（见上方 stallHB.slowPos/slowWall）。
   保留空 stub 以兼容遗留调用点（switchToAudio 等）。 */
function startMinuteResync(){}
function stopMinuteResync(){}

/* —— stallHB lifecycle: start/stop on visibility change —— */
document.addEventListener("visibilitychange", ()=>{
  if (_repairInProgress) return;  // ★ 修复期间不触发心跳切换
  const a = media.a || $("bgAudio");
  if (!a) return;
  if (document.visibilityState === "hidden" && isPlayerActive() && playbackMode==="audio"){
    resetStallHeartbeat(a);
    startStallHeartbeat();
  } else {
    stopStallHeartbeat();
  }
});

/* —— 兜底：极少设备不发 visibilitychange，这里每 5s 尝试一次 —— */
setInterval(()=>{
  if (document.visibilityState === "hidden" && isPlayerActive() && playbackMode==="audio"){
    startStallHeartbeat();
  }
}, 5000);

/* ========================= 纯进度心跳检测 + 稳定重启（完） ========================= */