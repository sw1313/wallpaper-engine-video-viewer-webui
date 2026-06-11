# app/main.py (fs-35 audio-direct: add /media/audio/{vid_id} + inplace faststart + keepalive)
import os, math, mimetypes, re, sqlite3, threading, io, hashlib, subprocess, glob, shutil, json, signal
import time, logging, asyncio  # ★ 新增：用于 /api/keepalive 时间与日志过滤
import secrets  # ★ 新增
from urllib.parse import quote
from pathlib import Path
from typing import List, Tuple, NamedTuple
from datetime import datetime
from email.utils import parsedate_to_datetime

APP_DIR = os.path.dirname(os.path.abspath(__file__))
_RUNTIME_ENV_LOADED: list[str] = []


def _load_runtime_env_files() -> None:
  """从挂载目录 runtime.env 读取配置（群晖改文件 + docker restart 即可，不必重建容器）。"""
  global _RUNTIME_ENV_LOADED
  _RUNTIME_ENV_LOADED = []
  for name in ("runtime.env", "docker.local.env"):
    path = os.path.join(APP_DIR, name)
    if not os.path.isfile(path):
      continue
    try:
      with open(path, "r", encoding="utf-8") as f:
        for raw in f:
          line = raw.strip()
          if not line or line.startswith("#"):
            continue
          if line.lower().startswith("export "):
            line = line[7:].strip()
          if "=" not in line:
            continue
          key, _, val = line.partition("=")
          key = key.strip()
          if not key:
            continue
          val = val.strip()
          if len(val) >= 2 and val[0] == val[-1] and val[0] in "\"'":
            val = val[1:-1]
          os.environ[key] = val
      _RUNTIME_ENV_LOADED.append(name)
    except Exception as e:
      print(f"[config] load {path} failed: {e}", flush=True)


_load_runtime_env_files()

from fastapi import FastAPI, Query, Request, HTTPException, Body  # ★ 添加 Body
from fastapi.responses import (
    FileResponse,
    PlainTextResponse,
    HTMLResponse,
    RedirectResponse,
    Response,
    JSONResponse,   # ★ 新增：用于 /api/faststart 返回标准 JSON
)
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel


class FastFileResponse(FileResponse):
  """大文件/HLS 段：较大 chunk，减少 HTTPS 下循环与加密开销。"""
  chunk_size = 8 * 1024 * 1024


class DirectPlayFileResponse(FileResponse):
  """Direct Play 原生 MP4：小 chunk 配合浏览器 Range 流控，避免一次塞满触发 Chrome 限速。

  浏览器直放几乎总是走 206 Range；128KB 量级的高频小块比 4–8MB 大块更容易
  维持 TCP 接收窗口稳定，缓冲条会刷得更顺。可通过 DIRECT_PLAY_CHUNK_BYTES 调整。
  """
  chunk_size = int(os.getenv("DIRECT_PLAY_CHUNK_BYTES", str(128 * 1024)))

  async def __call__(self, scope, receive, send):
    if scope["type"] != "http":
      await super().__call__(scope, receive, send)
      return
    async def paced_send(message):
      await send(message)
      if message.get("type") == "http.response.body" and message.get("more_body", False):
        await asyncio.sleep(0)
    await super().__call__(scope, receive, paced_send)

from .steam_authors import schedule_steam_author_enrich
from .we_scan import (
    load_we_config, extract_folders_list, build_folder_tree, scan_workshop_items,
    scan_single_workshop_item, scan_single_myproject_item,
    scan_myprojects_items, scan_config_linked_project_videos,
    collect_unassigned_items, find_node_by_path, all_ids_recursive, delete_id_dir,
    delete_myprojects_local_dir, delete_we_projects_path_video,
    create_folder as ws_create_folder, move_items as ws_move_items, move_folders as ws_move_folders, delete_folders as ws_delete_folders,
)
from .models import ScanResponse, FolderOut, VideoOut, DeleteRequest, PlaylistRequest, FolderDeleteRequest

# === 可配置路径 ===
WORKSHOP_PATH = os.getenv("WORKSHOP_PATH", "/data/workshop/content/431960")
WE_PATH       = os.getenv("WE_PATH", "/data/wallpaper_engine")
DATA_DIR      = os.path.join(APP_DIR, "data")
os.makedirs(DATA_DIR, exist_ok=True)

# === 新增：纯音频缓存目录 ===
AUDIO_CACHE_DIR = os.getenv("AUDIO_CACHE_DIR", os.path.join(DATA_DIR, "audio_cache"))
os.makedirs(AUDIO_CACHE_DIR, exist_ok=True)

# === 新增：视频转码缓存目录（用于“强制转码修复”不覆盖原文件，避免触发 Steam 校验） ===
VIDEO_CACHE_DIR = os.getenv("VIDEO_CACHE_DIR", os.path.join(DATA_DIR, "video_cache"))
os.makedirs(VIDEO_CACHE_DIR, exist_ok=True)

# === HLS 切片缓存：ffmpeg 把原视频转换成 HLS 播放列表 + ts 段 ===
# 不再前端用 mp4box+MSE 拼，直接让浏览器/HLS.js 按段拉。
# 配置项：
# - HLS_CACHE_DIR：缓存目录
# - HLS_SEGMENT_SEC：每段时长（秒），ffmpeg 会就近往 GOP 边界对齐
# - HLS_CACHE_MAX_TOTAL_GB：超过总大小 LRU 删
# - HLS_CACHE_MAX_AGE_DAYS：超过天数直接删
# - HLS_TRANSCODE_FALLBACK：当 -c copy 失败（如 HEVC/VP9 没法塞 mpegts）时的兜底模式
#       auto    → 试 nvenc → qsv → libx264（推荐，有显卡走显卡）
#       nvenc   → 只用 NVIDIA NVENC
#       qsv     → 只用 Intel iGPU QSV
#       libx264 → 纯 CPU
#       none    → 不兜底，直接报错
HLS_CACHE_DIR = os.getenv("HLS_CACHE_DIR", os.path.join(DATA_DIR, "hls_cache"))
os.makedirs(HLS_CACHE_DIR, exist_ok=True)
# HLS 分片越长，ffmpeg 使用 temp_file 时首段越晚出现；2 秒是启动速度和请求数量的折中。
HLS_SEGMENT_SEC = int(os.getenv("HLS_SEGMENT_SEC", "2"))
HLS_CACHE_MAX_TOTAL_GB = float(os.getenv("HLS_CACHE_MAX_TOTAL_GB", "20"))
HLS_CACHE_MAX_AGE_DAYS = int(os.getenv("HLS_CACHE_MAX_AGE_DAYS", "30"))
HLS_TRANSCODE_FALLBACK = os.getenv("HLS_TRANSCODE_FALLBACK", "auto").lower()
HLS_PIPELINE_VERSION = "hls-av-job-v17"
HLS_START_WAIT_SEC = float(os.getenv("HLS_START_WAIT_SEC", "90"))
HLS_PLAYLIST_PRIME_SEGMENTS = int(os.getenv("HLS_PLAYLIST_PRIME_SEGMENTS", "3"))
HLS_PLAYLIST_PRIME_WAIT_SEC = float(os.getenv("HLS_PLAYLIST_PRIME_WAIT_SEC", "6"))
HLS_DISCONTINUITY_AFTER_GAP_SEGMENTS = int(os.getenv("HLS_DISCONTINUITY_AFTER_GAP_SEGMENTS", "2"))
# 局域网优先原文件/原码率：默认允许 stream copy；若产出异常大分片，会运行时熔断并回退转码。
HLS_ALLOW_COPY = os.getenv("HLS_ALLOW_COPY", "1").lower() in {"1", "true", "yes", "on"}
HLS_QSV_DEVICE = os.getenv("HLS_QSV_DEVICE", "/dev/dri/renderD128")
_hls_nvenc_probe_cuda = False
HLS_HW_PROBE_RESET = os.getenv("HLS_HW_PROBE_RESET", "").lower() in {"1", "true", "yes", "on"}
HLS_COPY_MAX_SOURCE_BYTES = int(os.getenv("HLS_COPY_MAX_SOURCE_BYTES", str(2 * 1024 * 1024 * 1024)))
HLS_COPY_MAX_BITRATE_BPS = int(os.getenv("HLS_COPY_MAX_BITRATE_BPS", str(30 * 1000 * 1000)))
HLS_HUGE_FILE_BYTES = int(os.getenv("HLS_HUGE_FILE_BYTES", str(8 * 1024 * 1024 * 1024)))
HLS_MAX_REASONABLE_SEGMENT_BYTES = int(os.getenv("HLS_MAX_REASONABLE_SEGMENT_BYTES", str(128 * 1024 * 1024)))
HLS_ENCODE_AHEAD_SEC = int(os.getenv("HLS_ENCODE_AHEAD_SEC", "60"))

# Alt+浮动预览：独立低码率 HLS 缓存（与全屏 full 分开，多窗并发更快）
HLS_PREVIEW_CACHE_DIR = os.getenv("HLS_PREVIEW_CACHE_DIR", os.path.join(DATA_DIR, "hls_cache_preview"))
os.makedirs(HLS_PREVIEW_CACHE_DIR, exist_ok=True)
HLS_PREVIEW_PIPELINE_VERSION = "hls-preview-v1"
HLS_PREVIEW_MAX_WIDTH = int(os.getenv("HLS_PREVIEW_MAX_WIDTH", "960"))
HLS_PREVIEW_MAX_HEIGHT = int(os.getenv("HLS_PREVIEW_MAX_HEIGHT", "540"))
HLS_PREVIEW_AUDIO_BITRATE = os.getenv("HLS_PREVIEW_AUDIO_BITRATE", "96k")
HLS_PREVIEW_PLAYLIST_PRIME_SEGMENTS = int(os.getenv("HLS_PREVIEW_PLAYLIST_PRIME_SEGMENTS", "1"))
HLS_PREVIEW_PLAYLIST_PRIME_WAIT_SEC = float(os.getenv("HLS_PREVIEW_PLAYLIST_PRIME_WAIT_SEC", "4"))
# NVENC/QSV 探测分辨率（128x128 低于 NVENC 最小尺寸会误报失败）
HLS_HW_PROBE_SIZE = os.getenv("HLS_HW_PROBE_SIZE", "256x256")
# 并发硬编：独显 NVENC / 集显 QSV·VAAPI 分开限流，双卡可同时干活。
# 4060 Ti 消费级驱动 NVENC 官方上限 8 路；12 代 QSV 无驱动路数锁（实际吞吐约 10~14 路 1080p）。
# preview 540p 负载更低，Intel 侧可单独抬高；NVENC 仍受会话数限制。
_hls_nvenc_max_full = max(1, int(os.getenv("HLS_NVENC_MAX", os.getenv("HLS_HW_ENCODE_MAX", "8"))))
_hls_intel_max_full = max(1, int(os.getenv("HLS_INTEL_MAX", os.getenv("HLS_HW_ENCODE_MAX", "12"))))
HLS_NVENC_MAX = _hls_nvenc_max_full
HLS_INTEL_MAX = _hls_intel_max_full
HLS_NVENC_MAX_PREVIEW = max(1, int(os.getenv("HLS_NVENC_MAX_PREVIEW", str(_hls_nvenc_max_full))))
HLS_INTEL_MAX_PREVIEW = max(1, int(os.getenv("HLS_INTEL_MAX_PREVIEW", str(max(_hls_intel_max_full, 14)))))
HLS_HW_SLOTS_DYNAMIC = os.getenv("HLS_HW_SLOTS_DYNAMIC", "1").lower() in {"1", "true", "yes", "on"}
HLS_HW_ENCODE_SLOT_WAIT_SEC = float(os.getenv("HLS_HW_ENCODE_SLOT_WAIT_SEC", "300"))
HLS_PREFER_GPU = os.getenv("HLS_PREFER_GPU", "1").lower() in {"1", "true", "yes", "on"}
HLS_DUAL_GPU = os.getenv("HLS_DUAL_GPU", "auto").lower()  # auto | 1 | 0
# 浮动 preview 首段就绪后是否继续整片编码（默认关，避免关窗后 ffmpeg 常驻吃 CPU/GPU）
HLS_PREVIEW_KEEP_ENCODING = os.getenv("HLS_PREVIEW_KEEP_ENCODING", "0").lower() in {"1", "true", "yes", "on"}
HLS_PREVIEW_IDLE_KILL_SEC = float(os.getenv("HLS_PREVIEW_IDLE_KILL_SEC", "20"))
# 浮动窗直出 MP4（默认关：大文件直连 NAS 慢，preview HLS 540p 转码起播更快）
HLS_PREVIEW_DIRECT_PLAY = os.getenv("HLS_PREVIEW_DIRECT_PLAY", "0").lower() in {"1", "true", "yes", "on"}
HLS_PREVIEW_DIRECT_MAX_BYTES = int(os.getenv("HLS_PREVIEW_DIRECT_MAX_BYTES", str(4 * 1024 * 1024 * 1024)))
HLS_PREVIEW_DIRECT_MAX_BITRATE_BPS = int(os.getenv("HLS_PREVIEW_DIRECT_MAX_BITRATE_BPS", str(35 * 1000 * 1000)))

_hls_nvenc_env_cuda = os.getenv("HLS_NVENC_CUDA", "1").lower() in {"1", "true", "yes", "on"}

def _hls_nvenc_has_nvidia() -> bool:
  try:
    if os.path.exists("/dev/nvidia0"):
      return True
    return any(str(n).startswith("nvidia") for n in os.listdir("/dev"))
  except Exception:
    return False

def _hls_use_nvenc_cuda() -> bool:
  """转码是否走 CUDA 硬解/硬缩放 + NVENC（需 NVIDIA 设备；与探测用 plain 通过不冲突）。"""
  if not _hls_nvenc_env_cuda or not _hls_nvenc_has_nvidia():
    return False
  if _hls_mode_disabled("nvenc"):
    return False
  cached = _hls_encoder_probe_cache.get("nvenc")
  return cached is not False

def _hls_norm_tier(tier: str = "full") -> str:
  return "preview" if str(tier or "full").lower() == "preview" else "full"

def _hls_pipeline_version(tier: str = "full") -> str:
  return HLS_PREVIEW_PIPELINE_VERSION if _hls_norm_tier(tier) == "preview" else HLS_PIPELINE_VERSION

def _hls_playhead_key(vid_id: str, tier: str = "full") -> str:
  return f"{vid_id}@preview" if _hls_norm_tier(tier) == "preview" else str(vid_id)

def _hls_is_preview_tier(tier: str = "full") -> bool:
  return _hls_norm_tier(tier) == "preview"

# === 音频缓存定时清理（避免 audio_cache 无限膨胀） ===
# - AUDIO_CACHE_MAX_AGE_DAYS：超过多少天的缓存直接删除
# - AUDIO_CACHE_MAX_TOTAL_MB：目录总大小超过多少 MB 时，从最旧开始删到低于阈值
# - AUDIO_CACHE_CLEAN_INTERVAL_MIN：清理周期（分钟）
_AUDIO_CACHE_MAX_AGE_DAYS = int(os.getenv("AUDIO_CACHE_MAX_AGE_DAYS", "14"))
_AUDIO_CACHE_MAX_TOTAL_MB = int(os.getenv("AUDIO_CACHE_MAX_TOTAL_MB", "4096"))  # 4GB
_AUDIO_CACHE_CLEAN_INTERVAL_MIN = int(os.getenv("AUDIO_CACHE_CLEAN_INTERVAL_MIN", "60"))

# ========= watched（服务器端“已播放”持久化） =========
DB_PATH = os.getenv("WATCHED_DB", os.path.join(DATA_DIR, "watched.db"))
os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
_db_lock = threading.Lock()

def _get_conn():
    """
    统一在同一个 SQLite 里维护：
    - watched(id, watched)
    - faststart(workshop_id, done)
    - progress(id, position, duration)    —— 播放进度（断点续播）
    """
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    # watched 表（原有）
    conn.execute("""
    CREATE TABLE IF NOT EXISTS watched (
        id TEXT PRIMARY KEY,
        watched INTEGER NOT NULL DEFAULT 1,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
    """)
    # ★ faststart 表：记录某个创意工坊 ID 是否已 faststart 过
    conn.execute("""
    CREATE TABLE IF NOT EXISTS faststart (
        workshop_id TEXT PRIMARY KEY,
        done        INTEGER NOT NULL DEFAULT 0,
        updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
    )
    """)
    # ★ progress 表：播放进度（断点续播）
    conn.execute("""
    CREATE TABLE IF NOT EXISTS progress (
        id         TEXT PRIMARY KEY,
        position   REAL NOT NULL DEFAULT 0,
        duration   REAL NOT NULL DEFAULT 0,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
    """)
    return conn

# ========= 播放进度相关阈值 =========
# 播放完成阈值：超过总时长 90% 视为已看完，清除进度并自动标记为 watched
PROGRESS_COMPLETE_RATIO = float(os.getenv("PROGRESS_COMPLETE_RATIO", "0.90"))
# 起始忽略阈值：进度小于 5% 不保存（防止误点）
PROGRESS_START_RATIO = float(os.getenv("PROGRESS_START_RATIO", "0.05"))
# 绝对最低进度（秒）：即使 5% 对应 < 此值，也需达到才保存
PROGRESS_MIN_POSITION_SEC = float(os.getenv("PROGRESS_MIN_POSITION_SEC", "5"))

def _faststart_is_done(vid_id: str) -> bool:
    with _db_lock:
        conn = _get_conn()
        row = conn.execute("SELECT done FROM faststart WHERE workshop_id=? LIMIT 1", (str(vid_id),)).fetchone()
        conn.close()
    return bool(row and row[0])

def _faststart_mark_done(vid_id: str):
    with _db_lock:
        conn = _get_conn()
        conn.execute("""
        INSERT INTO faststart(workshop_id, done, updated_at)
        VALUES(?, 1, CURRENT_TIMESTAMP)
        ON CONFLICT(workshop_id) DO UPDATE SET done=1, updated_at=CURRENT_TIMESTAMP
        """, (str(vid_id),))
        conn.commit()
        conn.close()

class WatchedSet(BaseModel):
    ids: List[str]
    watched: bool = True

class ProgressSet(BaseModel):
    id: str
    position: float
    duration: float = 0

class HlsPlayheadSet(BaseModel):
    id: str
    position: float = 0
    tier: str = "full"

class HlsStopRequest(BaseModel):
    id: str
    tier: str = "preview"

class HlsStopAllRequest(BaseModel):
    tier: str = "preview"

class HlsResumeRequest(BaseModel):
    id: str
    tier: str = "preview"

class HlsPriorityRequest(BaseModel):
    id: str
    priority: float = 0
    tier: str = "preview"

class ProgressClear(BaseModel):
    ids: List[str]

# ★ 新增：文件夹相关的请求模型
class CreateFolderRequest(BaseModel):  # ★ 新增
    parent: str = "/"
    title: str

class MoveRequest(BaseModel):  # ★ 新增
    ids: List[str] = []
    folder_paths: List[str] = []
    dest_path: str = "/"

class PlaybackNegotiateRequest(BaseModel):
    video_id: str
    is_mobile: bool = False
    supports_mse: bool = True
    browser: str = ""
    supported_codecs: dict = {}
    position: float = 0
    device_memory_gb: float = 0
    js_heap_limit_bytes: int = 0
    js_heap_used_bytes: int = 0
    screen_pixels: int = 0
    mse_budget_bytes: int = 0
    playback_tier: str = "full"  # full | preview（Alt+浮动窗）

# ========= 预览图缓存 =========
PREVIEW_CACHE_DIR = os.getenv("PREVIEW_CACHE_DIR", os.path.join(DATA_DIR, "preview_cache"))
os.makedirs(PREVIEW_CACHE_DIR, exist_ok=True)
_cache_locks = {}
_cache_global_lock = threading.Lock()

def _get_cache_lock(path: str) -> threading.Lock:
    with _cache_global_lock:
        if path not in _cache_locks:
            _cache_locks[path] = threading.Lock()
        return _cache_locks[path]

# ========= FastAPI 应用 =========
app = FastAPI(title="Wallpaper WebUI")
app.mount("/static", StaticFiles(directory=os.path.join(os.path.dirname(__file__), "static")), name="static")
templates = Jinja2Templates(directory=os.path.join(os.path.dirname(__file__), "templates"))

# ==== keepalive（极简心跳） ====
# 可选：静音 keepalive 的 access log（避免 log 被心跳刷屏）
if os.getenv("SILENCE_KEEPALIVE_LOGS", "1") == "1":
    class _KAFilter(logging.Filter):
        def filter(self, record):
            msg = getattr(record, "msg", "")
            return "/api/keepalive" not in str(msg)
    logging.getLogger("uvicorn.access").addFilter(_KAFilter())

_last_keepalive = {}  # 仅用于观察（内存），非必要

@app.post("/api/keepalive")
@app.get("/api/keepalive")
def api_keepalive(request: Request):
    # 记录一下来源（可观测）
    try:
        ip = request.client.host if request.client else "?"
        _last_keepalive[ip] = int(time.time())
    except Exception:
        pass
    # 204 + 明确告诉客户端“不要缓存；关闭连接”
    return Response(status_code=204, headers={
        "Cache-Control": "no-store, max-age=0",
        "Connection": "close"
    })

def _sort_key(idx: int):
  if idx == 0: return (lambda v: v.mtime, True)
  if idx == 1: return (lambda v: v.mtime, False)
  if idx == 2: return (lambda v: v.size, True)
  if idx == 3: return (lambda v: v.size, False)
  if idx == 4: return (lambda v: v.title.casefold(), True)
  return (lambda v: v.title.casefold(), False)

# ======== 扫描结果内存缓存（按需扫描：三源独立指纹检测）========
# 将数据拆为三个独立源，各自有独立的 mtime 指纹 + 防抖，互不干扰：
#   cfg  — config.json（文件夹结构 + config 内链接的 projects 视频）
#   ws   — WORKSHOP_PATH（创意工坊下载目录）
#   mp   — WE_PATH/projects/myprojects（本地项目目录）
#
# 好处：WE 订阅壁纸时 config.json 和 workshop 目录同时变化，
#       但 config 变化只重读 config，workshop 变化只重扫 workshop，不会交叉触发。
SCAN_DEBOUNCE_SEC = float(os.getenv("SCAN_DEBOUNCE_SEC", "5"))
SCAN_FINGERPRINT_INTERVAL = float(os.getenv("SCAN_FINGERPRINT_INTERVAL", "10"))
# Steam 下载壁纸时目录可能先创建但文件尚未就位，pending 机制定期重试这些未完成项
SCAN_PENDING_RECHECK_SEC = float(os.getenv("SCAN_PENDING_RECHECK_SEC", "30"))

_SCAN_LOCK = threading.RLock()

def _make_source():
    return {
        "dirty": True,
        "fp": None,
        "change_at": 0.0,
        "last_fp_time": 0.0,
        "pending": set(),
        "pending_checked_at": 0.0,
    }

_SRC_CFG = _make_source()        # config.json 源
_SRC_CFG_DATA = {                 # config 源的扫描结果
    "we_cfg": {},
    "folder_roots": [],
    "items": {},                  # config-linked project videos
}

_SRC_WS = _make_source()         # workshop 源
_SRC_WS_DATA = {"items": {}}

_SRC_MP = _make_source()         # myprojects 源
_SRC_MP_DATA = {"items": {}}

_MERGED = {                       # 合并后的最终缓存
    "valid": False,
    "folder_roots": None,
    "id_map": None,
    "root_unassigned": None,
    "path_map": None,
}

# ---- 指纹采集（每个源只 stat 自己关心的路径）----

def _fp_config():
    p = os.path.join(WE_PATH, "config.json")
    try:
        st = os.stat(p)
        return (st.st_mtime_ns, st.st_size)
    except OSError:
        return (0, 0)

def _fp_workshop():
    try:
        st = os.stat(WORKSHOP_PATH)
        # st_nlink 在 Windows/SMB 上始终为 1，无法感知子目录增删；
        # 改用实际子目录计数，保证外部删除（如 Steam 取消订阅）能被检测到
        try:
            n = sum(1 for e in os.scandir(WORKSHOP_PATH)
                    if e.is_dir(follow_symlinks=False) and e.name.isdigit())
        except Exception:
            n = -1
        return (st.st_mtime_ns, n)
    except OSError:
        return (0, 0)

def _fp_myprojects():
    p = os.path.join(WE_PATH, "projects", "myprojects")
    try:
        st = os.stat(p)
        try:
            n = sum(1 for e in os.scandir(p)
                    if e.is_dir(follow_symlinks=False)
                    and not e.name.startswith(".") and ".." not in e.name)
        except Exception:
            n = -1
        return (st.st_mtime_ns, n)
    except OSError:
        return (0, 0)

# ---- 单源变化检测 + 防抖 ----

def _check_source(src: dict, fp_fn) -> bool:
    """检测单个源是否需要重新扫描。返回 True 表示该源现在是 dirty 的。"""
    if src["dirty"]:
        return True
    now = time.time()
    # 有未完成项（如 Steam 下载中的目录）→ 定期重试
    if src["pending"] and (now - src["pending_checked_at"]) >= SCAN_PENDING_RECHECK_SEC:
        src["dirty"] = True
        return True
    if now - src["last_fp_time"] < SCAN_FINGERPRINT_INTERVAL:
        return False
    fp = fp_fn()
    src["last_fp_time"] = now
    if fp == src["fp"]:
        src["change_at"] = 0.0
        return False
    # 指纹变了 → 启动防抖
    if src["change_at"] == 0.0:
        src["change_at"] = now
    if now - src["change_at"] >= SCAN_DEBOUNCE_SEC:
        src["dirty"] = True
        src["change_at"] = 0.0
        return True
    return False

def _finish_source(src: dict, fp_fn):
    """扫描完成后，更新源状态。"""
    src["dirty"] = False
    src["fp"] = fp_fn()
    src["last_fp_time"] = time.time()
    src["change_at"] = 0.0

# ---- 主扫描入口 ----

def _scan_state():
    with _SCAN_LOCK:
        cfg_dirty = _check_source(_SRC_CFG, _fp_config)
        ws_dirty = _check_source(_SRC_WS, _fp_workshop)
        mp_dirty = _check_source(_SRC_MP, _fp_myprojects)
        any_dirty = cfg_dirty or ws_dirty or mp_dirty

        if not any_dirty and _MERGED["valid"]:
            return _MERGED["folder_roots"], _MERGED["id_map"], _MERGED["root_unassigned"]

        # --- 按需扫描各源（只扫描变化的部分）---
        if cfg_dirty:
            print("[scan] config.json 变化，重新读取配置与 linked-projects ...")
            try:
                we_cfg = load_we_config(WE_PATH)
                folders_list = extract_folders_list(we_cfg)
                folder_roots = build_folder_tree(folders_list)
            except Exception as e:
                print(f"[scan] ⚠ 读取 config.json 失败: {e}")
                print(f"[scan]   WE_PATH={WE_PATH!r}, config.json 路径={os.path.join(WE_PATH, 'config.json')!r}")
                print(f"[scan]   WE_PATH 是否存在: {os.path.isdir(WE_PATH)}")
                we_cfg = {}
                folder_roots = []
            linked = {}
            try:
                linked = dict(scan_config_linked_project_videos(
                    WE_PATH, we_cfg if isinstance(we_cfg, dict) else {}))
            except Exception:
                pass
            _SRC_CFG_DATA.update(we_cfg=we_cfg, folder_roots=folder_roots, items=linked)
            _finish_source(_SRC_CFG, _fp_config)

        if ws_dirty:
            old_items = _SRC_WS_DATA["items"]
            if not old_items:
                print("[scan] workshop 首次全量扫描 ...")
                if not os.path.isdir(WORKSHOP_PATH):
                    print(f"[scan] ⚠ WORKSHOP_PATH 不存在或不是目录: {WORKSHOP_PATH!r}")
                _SRC_WS_DATA["items"] = dict(scan_workshop_items(WORKSHOP_PATH))
            else:
                # 增量：只列根目录取目录名，diff 出新增/删除
                current_dirs = set()
                try:
                    with os.scandir(WORKSHOP_PATH) as entries:
                        for e in entries:
                            if e.is_dir(follow_symlinks=False) and e.name.isdigit():
                                current_dirs.add(e.name)
                except Exception:
                    pass
                old_ids = set(old_items.keys())
                added = current_dirs - old_ids
                removed = old_ids - current_dirs
                to_scan = added | _SRC_WS["pending"]

                for rid in removed:
                    old_items.pop(rid, None)

                scanned, pending = 0, set()
                for nid in to_scan:
                    if nid not in current_dirs:
                        continue
                    item = scan_single_workshop_item(WORKSHOP_PATH, nid)
                    if item:
                        old_items[nid] = item
                        scanned += 1
                    else:
                        pending.add(nid)

                _SRC_WS["pending"] = pending
                _SRC_WS["pending_checked_at"] = time.time()
                parts = []
                if scanned: parts.append(f"+{scanned}")
                if removed: parts.append(f"-{len(removed)}")
                if pending: parts.append(f"待完成:{len(pending)}")
                print(f"[scan] workshop 增量扫描: {' '.join(parts) or '无变化'}")

            _finish_source(_SRC_WS, _fp_workshop)

        if mp_dirty:
            we_cfg = _SRC_CFG_DATA.get("we_cfg", {})
            old_items = _SRC_MP_DATA["items"]
            if not old_items:
                print("[scan] myprojects 首次全量扫描 ...")
                mp_root = os.path.join(WE_PATH, "projects", "myprojects")
                if not os.path.isdir(mp_root):
                    print(f"[scan] ⚠ myprojects 目录不存在: {mp_root!r}")
                try:
                    _SRC_MP_DATA["items"] = dict(
                        scan_myprojects_items(WE_PATH, we_cfg if isinstance(we_cfg, dict) else {}))
                except Exception:
                    _SRC_MP_DATA["items"] = {}
            else:
                mp_root = os.path.join(WE_PATH, "projects", "myprojects")
                current_dirs = set()
                try:
                    with os.scandir(mp_root) as entries:
                        for e in entries:
                            if e.is_dir(follow_symlinks=False) and not e.name.startswith(".") and ".." not in e.name:
                                current_dirs.add(e.name)
                except Exception:
                    pass
                old_ids = {k[3:] for k in old_items.keys()}  # "mp:xxx" → "xxx"
                added = current_dirs - old_ids
                removed = old_ids - current_dirs
                pending_dirs = {p[3:] if p.startswith("mp:") else p for p in _SRC_MP["pending"]}
                to_scan = added | pending_dirs

                for rdir in removed:
                    old_items.pop(f"mp:{rdir}", None)

                scanned, pending = 0, set()
                for ndir in to_scan:
                    if ndir not in current_dirs:
                        continue
                    item = scan_single_myproject_item(WE_PATH, we_cfg if isinstance(we_cfg, dict) else {}, ndir)
                    if item:
                        old_items[item.id] = item
                        scanned += 1
                    else:
                        pending.add(f"mp:{ndir}")

                _SRC_MP["pending"] = pending
                _SRC_MP["pending_checked_at"] = time.time()
                parts = []
                if scanned: parts.append(f"+{scanned}")
                if removed: parts.append(f"-{len(removed)}")
                if pending: parts.append(f"待完成:{len(pending)}")
                print(f"[scan] myprojects 增量扫描: {' '.join(parts) or '无变化'}")

            _finish_source(_SRC_MP, _fp_myprojects)

        # --- 合并三源结果 ---
        folder_roots = _SRC_CFG_DATA["folder_roots"]
        id_map = {}
        id_map.update(_SRC_WS_DATA["items"])
        id_map.update(_SRC_MP_DATA["items"])
        id_map.update(_SRC_CFG_DATA["items"])

        root_unassigned = collect_unassigned_items(id_map, folder_roots)

        def _build_path_map():
            path_map = {}
            def rec(parts: List[str], subfolders, vids):
                path_str = "/" + "/".join(parts) if parts else "/"
                all_vids = list(vids)
                for sf in (subfolders or []):
                    child_parts = parts + [sf.title]
                    child_subfolders, child_vids = find_node_by_path(folder_roots, child_parts)
                    _, _, child_all = rec(child_parts, child_subfolders, child_vids)
                    all_vids.extend(child_all)
                path_map[path_str] = {"subfolders": subfolders, "vids": list(vids), "all_vids": all_vids}
                return subfolders, vids, all_vids
            rec([], folder_roots, root_unassigned[:])
            return path_map

        path_map = _build_path_map()
        _MERGED.update(valid=True, folder_roots=folder_roots, id_map=id_map,
                       root_unassigned=root_unassigned, path_map=path_map)

        schedule_steam_author_enrich(id_map)

        changed = []
        if cfg_dirty: changed.append("config")
        if ws_dirty: changed.append("workshop")
        if mp_dirty: changed.append("myprojects")
        print(f"[scan] 扫描完成 [{'+'.join(changed)}]，共 {len(id_map)} 个视频项")

        return _MERGED["folder_roots"], _MERGED["id_map"], _MERGED["root_unassigned"]


def _invalidate_scan_cache():
    """使所有扫描源失效并清空数据（供前端「刷新」按钮调用，下次走全量扫描）。"""
    with _SCAN_LOCK:
        for src in (_SRC_CFG, _SRC_WS, _SRC_MP):
            src["dirty"] = True
            src["change_at"] = 0.0
            src["pending"] = set()
        _SRC_WS_DATA["items"] = {}
        _SRC_MP_DATA["items"] = {}
        _MERGED["valid"] = False
        _MERGED["path_map"] = None

def _invalidate_config_cache():
    """仅使 config.json 源失效（供 UI 端文件夹增删移动后调用，不触发 workshop/myprojects 重扫描）。"""
    with _SCAN_LOCK:
        _SRC_CFG["dirty"] = True
        _SRC_CFG["change_at"] = 0.0
        _MERGED["valid"] = False
        _MERGED["path_map"] = None

@app.post("/api/scan/refresh")
def api_scan_refresh():
    """使扫描缓存失效，下次 /api/scan 将重新扫描文件列表。供前端「刷新」按钮调用。"""
    _invalidate_scan_cache()
    return {"ok": True}

@app.get("/api/scan/watch")
def api_scan_watch():
    """轻量检测扫描源是否变化；只做指纹判断，不主动执行全量扫描。"""
    with _SCAN_LOCK:
        cfg_dirty = _check_source(_SRC_CFG, _fp_config)
        ws_dirty = _check_source(_SRC_WS, _fp_workshop)
        mp_dirty = _check_source(_SRC_MP, _fp_myprojects)
        changed = bool(cfg_dirty or ws_dirty or mp_dirty or not _MERGED.get("valid"))
        return {
            "changed": changed,
            "sources": {
                "config": bool(cfg_dirty),
                "workshop": bool(ws_dirty),
                "myprojects": bool(mp_dirty),
            },
            "merged_valid": bool(_MERGED.get("valid")),
            "ts": int(time.time()),
        }

@app.get("/api/diag")
def api_diag():
    """诊断端点：返回路径存在性、扫描状态、视频计数等，帮助排查扫描不出结果的问题。"""
    config_path = os.path.join(WE_PATH, "config.json")
    mp_root = os.path.join(WE_PATH, "projects", "myprojects")
    ws_count = len(_SRC_WS_DATA.get("items", {}))
    mp_count = len(_SRC_MP_DATA.get("items", {}))
    cfg_count = len(_SRC_CFG_DATA.get("items", {}))
    id_map = _MERGED.get("id_map") or {}

    ws_subdirs = 0
    if os.path.isdir(WORKSHOP_PATH):
        try:
            with os.scandir(WORKSHOP_PATH) as it:
                ws_subdirs = sum(1 for e in it if e.is_dir(follow_symlinks=False) and e.name.isdigit())
        except Exception:
            pass

    checks = []
    if not os.path.isdir(WE_PATH):
        checks.append(f"WE_PATH 不存在或不是目录: {WE_PATH}")
    if not os.path.isfile(config_path):
        checks.append(f"config.json 不存在: {config_path}")
    if not os.path.isdir(WORKSHOP_PATH):
        checks.append(f"WORKSHOP_PATH 不存在或不是目录: {WORKSHOP_PATH}")
    elif ws_subdirs == 0:
        checks.append(f"WORKSHOP_PATH 下没有数字子目录（创意工坊项目）: {WORKSHOP_PATH}")
    if not os.path.isdir(mp_root):
        checks.append(f"myprojects 目录不存在: {mp_root}")

    return JSONResponse(content={
        "workshop_path": WORKSHOP_PATH,
        "we_path": WE_PATH,
        "config_json": config_path,
        "myprojects_path": mp_root,
        "exists": {
            "workshop_path": os.path.isdir(WORKSHOP_PATH),
            "we_path": os.path.isdir(WE_PATH),
            "config_json": os.path.isfile(config_path),
            "myprojects": os.path.isdir(mp_root),
        },
        "counts": {
            "workshop_items": ws_count,
            "myprojects_items": mp_count,
            "config_linked_items": cfg_count,
            "total_merged": len(id_map),
            "workshop_subdirs": ws_subdirs,
        },
        "scan_merged_valid": _MERGED.get("valid", False),
        "issues": checks,
        "gpu": _hls_gpu_diag(),
        "runtime_env_files": list(_RUNTIME_ENV_LOADED),
        "runtime_env_dir": APP_DIR,
    })

def _fs_safe_vid_token(vid_id: str) -> str:
  """用于缓存文件名等本地路径片段（避免 Windows 非法字符）。"""
  return re.sub(r'[<>:"/\\|?*]', "_", str(vid_id))

def _build_video_out(id_map, vid_id) -> VideoOut:
  v = id_map[vid_id]
  is_ws = bool(re.fullmatch(r"\d{10}", str(vid_id)))
  qid = quote(str(vid_id), safe="")
  return VideoOut(
    id=str(vid_id),
    title=v.title,
    author=getattr(v, "author", "") or "",
    mtime=v.mtime,
    size=v.size,
    rating=v.rating or "",
    preview_url=f"/media/preview/{qid}",
    video_url=f"/media/video/{qid}",
    workshop_url=f"https://steamcommunity.com/sharedfiles/filedetails/?id={vid_id}" if is_ws else "",
    is_workshop=is_ws,
  )

_video_orientation_cache = {}
def _video_orientation_meta(v):
  """
  返回用于前端壁纸模式筛选竖屏/横屏的轻量元数据。
  只在用户打开文件夹播放菜单时按需 ffprobe，并按 path+mtime+size 缓存。
  """
  path = getattr(v, "video_path", "") or ""
  if not path or not os.path.isfile(path):
    return {"width": 0, "height": 0, "orientation": "unknown"}
  key = (path, float(getattr(v, "mtime", 0) or 0), int(getattr(v, "size", 0) or 0))
  cached = _video_orientation_cache.get(key)
  if cached:
    return cached
  meta = {"width": 0, "height": 0, "orientation": "unknown"}
  try:
    p = subprocess.run(
      [
        "ffprobe", "-v", "error",
        "-select_streams", "v:0",
        "-show_entries", "stream=width,height:stream_tags=rotate:stream_side_data=rotation",
        "-of", "json",
        path,
      ],
      stdout=subprocess.PIPE,
      stderr=subprocess.PIPE,
      text=True,
      timeout=5,
    )
    info = json.loads(p.stdout or "{}")
    streams = info.get("streams") or []
    st = streams[0] if streams else {}
    w = int(st.get("width") or 0)
    h = int(st.get("height") or 0)
    rot = 0
    try:
      rot = int((st.get("tags") or {}).get("rotate") or 0)
    except Exception:
      rot = 0
    for sd in (st.get("side_data_list") or []):
      if "rotation" in sd:
        try:
          rot = int(float(sd.get("rotation") or 0))
        except Exception:
          pass
        break
    if abs(rot) % 180 == 90:
      w, h = h, w
    if w > 0 and h > 0:
      meta = {"width": w, "height": h, "orientation": "portrait" if h > w else "landscape"}
  except Exception:
    pass
  _video_orientation_cache[key] = meta
  return meta

def _template_ts(request: Request):
  try:
    request.scope["ts"] = str(int(time.time()))
  except Exception:
    request.scope["ts"] = "0"

@app.get("/", response_class=HTMLResponse)
def index(request: Request):
  # 给模板一个 cache-bust 参数，避免前端 app.js 被浏览器长期缓存导致功能不更新
  _template_ts(request)
  return templates.TemplateResponse(request, "index.html", {"request": request})

@app.get("/watch/{vid_id}", response_class=HTMLResponse)
def watch_page(request: Request, vid_id: str):
  """独立窗口播放页：主页 Alt+点击 通过 window.open 打开，每个视频各自加载。"""
  _template_ts(request)
  return templates.TemplateResponse(request, "watch.html", {"request": request, "vid_id": vid_id})

# ★ 启动异步预扫描（预热缓存）
@app.on_event("startup")
def prewarm_scan():
  if _RUNTIME_ENV_LOADED:
    logging.info("[config] loaded runtime env: %s", ", ".join(_RUNTIME_ENV_LOADED))
  _hls_bootstrap_hw_state()
  threading.Thread(target=_hls_log_startup_gpu_probe, daemon=True, name="gpu-probe").start()
  threading.Thread(target=_hls_preview_idle_reaper, daemon=True, name="hls-preview-reaper").start()
  threading.Thread(target=_hls_hw_slot_recovery, daemon=True, name="hls-slot-recovery").start()
  threading.Thread(target=_scan_state, daemon=True).start()

# ==========（新）已播放 API ==========
@app.get("/api/watched")
def api_get_watched(ids: str = ""):
  ids_list = [x.strip() for x in ids.split(",") if x.strip()]
  if not ids_list:
    return {"watched": []}
  q = ",".join("?" for _ in ids_list)
  with _db_lock:
    conn = _get_conn()
    rows = conn.execute(f"SELECT id FROM watched WHERE watched=1 AND id IN ({q})", ids_list).fetchall()
    conn.close()
  return {"watched": [r[0] for r in rows]}

@app.post("/api/watched")
def api_set_watched(payload: WatchedSet):
  ids = [str(i) for i in payload.ids if str(i)]
  if not ids:
    return {"ok": True, "count": 0}
  sql = """
  INSERT INTO watched(id, watched, updated_at)
  VALUES(?, ?, CURRENT_TIMESTAMP)
  ON CONFLICT(id) DO UPDATE SET watched=excluded.watched, updated_at=CURRENT_TIMESTAMP
  """
  data = [(i, 1 if payload.watched else 0) for i in ids]
  with _db_lock:
    conn = _get_conn()
    conn.executemany(sql, data)
    # 用户切换观看状态 → 同步清除该视频的播放进度
    # - 标记已看：避免留着旧进度，下次恢复到半截位置
    # - 标记未看：常见用法"已看→未看"表达"想重新看一次"，清零以从头播放
    q = ",".join("?" for _ in ids)
    conn.execute(f"DELETE FROM progress WHERE id IN ({q})", ids)
    conn.commit()
    conn.close()
  return {"ok": True, "count": len(ids)}

# ========== 播放进度 API ==========
@app.get("/api/progress")
def api_get_progress(ids: str = ""):
  """批量获取播放进度：ids 为逗号分隔的视频 id。"""
  ids_list = [x.strip() for x in ids.split(",") if x.strip()]
  if not ids_list:
    return {"progress": {}}
  q = ",".join("?" for _ in ids_list)
  with _db_lock:
    conn = _get_conn()
    rows = conn.execute(
      f"SELECT id, position, duration FROM progress WHERE id IN ({q})",
      ids_list,
    ).fetchall()
    conn.close()
  return {
    "progress": {
      r[0]: {"position": float(r[1] or 0), "duration": float(r[2] or 0)}
      for r in rows
    }
  }

@app.post("/api/progress")
def api_set_progress(payload: ProgressSet):
  """
  上报播放进度。
  - 若 position/duration 达到完成阈值（>=90%）：删除进度并自动标记 watched=1
  - 若过短（<5% 且 < PROGRESS_MIN_POSITION_SEC）：丢弃
  - 否则：插入/更新
  """
  vid = str(payload.id or "").strip()
  if not vid:
    return {"ok": False, "error": "missing-id"}
  pos = max(0.0, float(payload.position or 0))
  dur = max(0.0, float(payload.duration or 0))
  try:
    _hls_set_playhead(vid, pos, "full")
    src_path = _hls_source_for_vid(vid)
    out_dir = _hls_dir_for(vid, "full")
    key = _hls_job_key(vid, src_path, "full")
    _hls_maybe_throttle_job(vid, out_dir, _hls_job_for(key), "full")
  except Exception:
    pass

  # 完成 → 清进度 + 标记 watched
  if dur > 0 and pos / dur >= PROGRESS_COMPLETE_RATIO:
    with _db_lock:
      conn = _get_conn()
      conn.execute("DELETE FROM progress WHERE id=?", (vid,))
      conn.execute(
        """INSERT INTO watched(id, watched, updated_at)
           VALUES(?, 1, CURRENT_TIMESTAMP)
           ON CONFLICT(id) DO UPDATE SET watched=1, updated_at=CURRENT_TIMESTAMP""",
        (vid,),
      )
      conn.commit()
      conn.close()
    return {"ok": True, "completed": True}

  # 进度过短 → 忽略（但不删除已有记录，避免抖动覆盖）
  ratio_ok = (dur <= 0) or (pos / dur >= PROGRESS_START_RATIO)
  if pos < PROGRESS_MIN_POSITION_SEC or not ratio_ok:
    return {"ok": True, "skipped": True}

  with _db_lock:
    conn = _get_conn()
    conn.execute(
      """INSERT INTO progress(id, position, duration, updated_at)
         VALUES(?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(id) DO UPDATE SET
           position=excluded.position,
           duration=excluded.duration,
           updated_at=CURRENT_TIMESTAMP""",
      (vid, pos, dur),
    )
    conn.commit()
    conn.close()
  return {"ok": True}

@app.post("/api/progress/clear")
def api_clear_progress(payload: ProgressClear):
  """清除若干视频的播放进度。"""
  ids = [str(i) for i in (payload.ids or []) if str(i)]
  if not ids:
    return {"ok": True, "count": 0}
  q = ",".join("?" for _ in ids)
  with _db_lock:
    conn = _get_conn()
    conn.execute(f"DELETE FROM progress WHERE id IN ({q})", ids)
    conn.commit()
    conn.close()
  return {"ok": True, "count": len(ids)}

@app.post("/api/hls/playhead")
def api_hls_playhead(payload: HlsPlayheadSet):
  """轻量播放头上报：仅驱动 HLS encode-ahead 节流，不写 DB。"""
  vid = str(payload.id or "").strip()
  if not vid:
    return {"ok": False, "error": "missing-id"}
  pos = max(0.0, float(payload.position or 0))
  tier = _hls_norm_tier(getattr(payload, "tier", "full") or "full")
  try:
    _hls_set_playhead(vid, pos, tier)
    src_path = _hls_source_for_vid(vid)
    out_dir = _hls_dir_for(vid, tier)
    key = _hls_job_key(vid, src_path, tier)
    _hls_maybe_throttle_job(vid, out_dir, _hls_job_for(key), tier)
  except Exception:
    pass
  return {"ok": True}

@app.post("/api/hls/stop")
def api_hls_stop(payload: HlsStopRequest):
  """客户端关闭播放窗口：立即停止该视频的 HLS 转码 job。"""
  vid = str(payload.id or "").strip()
  if not vid:
    return {"ok": False, "error": "missing-id"}
  tier = _hls_norm_tier(getattr(payload, "tier", "preview") or "preview")
  try:
    return _hls_stop_transcode(vid, tier)
  except HTTPException:
    raise
  except Exception as e:
    logging.warning("[hls] stop failed vid=%s tier=%s: %s", vid, tier, e)
    return {"ok": False, "error": str(e)}

@app.post("/api/hls/stop-all")
def api_hls_stop_all(payload: HlsStopAllRequest):
  """关闭全部浮动窗等场景：批量停止某 tier 的全部转码 job。"""
  tier = _hls_norm_tier(getattr(payload, "tier", "preview") or "preview")
  try:
    return _hls_stop_all_transcode(tier)
  except Exception as e:
    logging.warning("[hls] stop-all failed tier=%s: %s", tier, e)
    return {"ok": False, "error": str(e)}

@app.post("/api/hls/resume")
def api_hls_resume(payload: HlsResumeRequest):
  """重新打开播放窗口：允许该视频再次启动转码。"""
  vid = str(payload.id or "").strip()
  if not vid:
    return {"ok": False, "error": "missing-id"}
  tier = _hls_norm_tier(getattr(payload, "tier", "preview") or "preview")
  _hls_clear_abandoned(vid, tier)
  return {"ok": True, "vid": vid, "tier": tier}

@app.post("/api/hls/priority")
def api_hls_priority(payload: HlsPriorityRequest):
  """浮动窗打开/聚焦时上报优先级（数值越大越优先占用 GPU 转码槽位）。"""
  vid = str(payload.id or "").strip()
  if not vid:
    return {"ok": False, "error": "missing-id"}
  tier = _hls_norm_tier(getattr(payload, "tier", "preview") or "preview")
  pri = float(payload.priority or 0)
  _hls_set_preview_priority(vid, pri)
  _hls_clear_abandoned(vid, tier)
  return {"ok": True, "vid": vid, "tier": tier, "priority": pri}

@app.get("/api/hls/capacity")
def api_hls_capacity(tier: str = Query("preview")):
  """返回当前 tier 的 GPU 转码并发上限（供前端浮动窗调度）。"""
  try:
    return _hls_hw_capacity(tier)
  except Exception as e:
    return {"ok": False, "error": str(e)}

@app.post("/api/playback/negotiate")
def api_playback_negotiate(payload: PlaybackNegotiateRequest):
  """根据浏览器能力与源文件元数据，选择 direct_play / native_hls / hls_js。"""
  vid = str(payload.video_id or "").strip()
  if not vid:
    raise HTTPException(400, "missing video_id")
  path = _hls_source_for_vid(vid)
  tier = _hls_norm_tier(getattr(payload, "playback_tier", "full") or "full")
  pos = max(0.0, float(payload.position or 0))
  if pos > 0:
    _hls_set_playhead(vid, pos, tier)
  return _negotiate_playback(path, vid, payload)

class ScanFilterTerm(NamedTuple):
  text: str
  field: str   # any | title | author
  exact: bool  # True = 全字/整词匹配

def _parse_scan_filter(q: str) -> List[ScanFilterTerm]:
  """
  解析筛选串：
  - a:关键词  仅上传者；t:关键词  仅标题
  - =关键词  全字/整词匹配（可写 a:=词 t:=词）
  无前缀词同时在标题+上传者中子串匹配。
  """
  terms: List[ScanFilterTerm] = []
  for raw in (q or "").split():
    tok = raw.strip()
    if not tok:
      continue
    field = "any"
    m = re.match(r"^(a|t):(.*)$", tok, re.I)
    if m:
      field = "author" if m.group(1).lower() == "a" else "title"
      tok = (m.group(2) or "").strip()
    exact = False
    if tok.startswith("="):
      exact = True
      tok = tok[1:].strip()
    if not tok:
      continue
    terms.append(ScanFilterTerm(tok.casefold(), field, exact))
  return terms

def _contains_exact_word(text_cf: str, word_cf: str) -> bool:
  if not word_cf:
    return True
  if not text_cf:
    return False
  if text_cf == word_cf:
    return True
  if re.search(r"(?<!\w)" + re.escape(word_cf) + r"(?!\w)", text_cf, re.UNICODE):
    return True
  sep = r"[\s\-_·|/\\，。！？、：；（）【】《》「」『』\"'\[\]{}<>]"
  return bool(re.search(r"(?:^|" + sep + r")" + re.escape(word_cf) + r"(?:$|" + sep + r")", text_cf))

def _text_matches_term(text_cf: str, term: ScanFilterTerm) -> bool:
  if not term.text:
    return True
  if term.exact:
    return _contains_exact_word(text_cf, term.text)
  return term.text in text_cf

def _video_passes_scan_filter(v, mature_only: bool, terms: List[ScanFilterTerm]) -> bool:
  if not v:
    return False
  if mature_only and (v.rating or "").lower() != "mature":
    return False
  if not terms:
    return True
  title_cf = (v.title or "").casefold()
  author_cf = (getattr(v, "author", "") or "").casefold()
  haystack = f"{title_cf} {author_cf}".strip()
  for term in terms:
    if term.field == "title":
      target = title_cf
    elif term.field == "author":
      target = author_cf
    else:
      target = haystack
    if not _text_matches_term(target, term):
      return False
  return True

# ========== 扫描 / 列表 ==========
@app.get("/api/scan")
def api_scan(
  path: str = Query("/", description="形如 /A/B"),
  page: int = Query(1, ge=1),
  per_page: int = Query(45, ge=1, le=500),  # 放宽到 500
  sort_idx: int = Query(0, ge=0, le=5),
  mature_only: bool = Query(False),
  q: str = Query("", description="筛选：a:上传者 t:标题 =全字匹配，空格分词且全部包含")
):
  folder_roots, id_map, root_unassigned = _scan_state()

  # 规范化路径 & 直接命中子路径缓存
  parts = [p for p in path.split("/") if p]
  norm_path = ("/" + "/".join(parts)) if parts else "/"
  with _SCAN_LOCK:
    pm = _MERGED.get("path_map") or {}
    entry = pm.get(norm_path)

  if entry:
    current_subfolders = entry["subfolders"] or []
    current_item_ids = list(entry["vids"] or [])
    breadcrumb = parts
  else:
    # 兜底（理论上不会走到）
    if not parts:
      current_subfolders = folder_roots
      current_item_ids = root_unassigned[:]
      breadcrumb = []
    else:
      current_subfolders, current_item_ids = find_node_by_path(folder_roots, parts)
      breadcrumb = parts

  filter_terms = _parse_scan_filter(q)
  has_filter = bool(filter_terms)

  def _passes(vid: str) -> bool:
    return _video_passes_scan_filter(id_map.get(vid), mature_only, filter_terms)

  # 当前目录「直属」视频按过滤条件保留；搜索时也只平铺当前层，不把子文件夹里
  # 的命中项拉上来，避免用户反馈的「搜索后全部被拍平」。
  vids: List[str] = [vid for vid in current_item_ids if _passes(vid)]

  key, rev = _sort_key(sort_idx)
  vids.sort(key=lambda _id: key(id_map[_id]), reverse=rev)

  # 文件夹渲染：
  #   - 无搜索词：展示所有子文件夹（原行为）
  #   - 有搜索词：仅展示「其下（递归）存在匹配视频」的子文件夹；点进去后因为
  #     前端仍会携带 q 参数请求，内部照样按关键词过滤。这样就保留了目录结构。
  folders_out: List[FolderOut] = []
  for sf in current_subfolders:
    if has_filter:
      sub_ids = all_ids_recursive([sf])
      if not any(_passes(i) for i in sub_ids):
        continue
    # ★ 激进加速：不再递归统计数量（前端已不显示），统一返回 0
    folders_out.append(FolderOut(title=sf.title, count=0))

  total_tiles = len(folders_out) + len(vids)
  total_pages = max(1, math.ceil(total_tiles / per_page))
  page = min(page, total_pages)

  start = (page - 1) * per_page
  end = min(start + per_page, total_tiles)

  tiles = []
  tiles.extend(("folder", f) for f in folders_out)
  tiles.extend(("video", v) for v in vids)
  show_tiles = tiles[start:end]

  out_folders: List[FolderOut] = []
  out_videos: List[VideoOut] = []
  for typ, obj in show_tiles:
    if typ == "folder":
      out_folders.append(obj)
    else:
      out_videos.append(_build_video_out(id_map, obj))

  # ★ 提前序列化 JSON（绕过 Pydantic 实例化/校验）
  return JSONResponse(content={
    "breadcrumb": breadcrumb,
    "folders": [f.dict() for f in out_folders],
    "videos": [v.dict() for v in out_videos],
    "page": page,
    "total_pages": total_pages,
    "total_items": total_tiles
  })

# 递归取文件夹视频；with_meta=1 时返回 [{id,title}]，否则 ids
@app.get("/api/folder_videos")
def api_folder_videos(
  path: str = Query("/", description="形如 /A/B"),
  sort_idx: int = Query(0, ge=0, le=5),
  mature_only: bool = Query(False),
  with_meta: bool = Query(False),
  with_orientation: bool = Query(False)
):
  folder_roots, id_map, root_unassigned = _scan_state()
  parts = [p for p in path.split("/") if p]
  if not parts:
    current_subfolders = folder_roots
    current_item_ids = root_unassigned[:]
  else:
    current_subfolders, current_item_ids = find_node_by_path(folder_roots, parts)

  candidates = set(current_item_ids)
  candidates.update(all_ids_recursive(current_subfolders))

  vids: List[str] = []
  for vid in candidates:
    v = id_map.get(vid)
    if not v:
      continue
    if mature_only and (v.rating or "").lower() != "mature":
      continue
    vids.append(vid)

  key, rev = _sort_key(sort_idx)
  vids.sort(key=lambda _id: key(id_map[_id]), reverse=rev)
  if with_meta:
    items = []
    for i in vids:
      v = id_map[i]
      item = {
        "id": i,
        "title": v.title,
      }
      if with_orientation:
        meta = _video_orientation_meta(v)
        item.update({
          "width": meta.get("width", 0),
          "height": meta.get("height", 0),
          "orientation": meta.get("orientation", "unknown"),
        })
      items.append(item)
    return {"items": items}
  return {"ids": vids}

# === 右键/菜单用：列出“移动到 …”二级菜单（包含已有文件夹与子文件夹） ===
@app.get("/api/folders_menu")  # ★ 新增
def api_folders_menu():
  try:
    we_cfg = load_we_config(WE_PATH)
    lst = extract_folders_list(we_cfg)
  except Exception:
    lst = []

  def rec(nodes, prefix):
    out = []
    for n in (nodes or []):
      title = n.get("title", "未命名文件夹")
      path = (prefix + "/" + title) if prefix != "/" else ("/" + title)
      out.append({"title": title, "path": path, "children": rec(n.get("subfolders") or [], path)})
    return out

  return {"tree": rec(lst, "/")}

# === 在当前路径下新建文件夹（写 config.json，先 .bak 再写入） ===
@app.post("/api/folder/create")  # ★ 新增
def api_folder_create(req: CreateFolderRequest):
  ws_create_folder(WE_PATH, req.parent or "/", req.title)
  _invalidate_config_cache()
  return {"ok": True}

# === 移动所选项目（支持多选）到目标路径；"/" 表示移动到主页 ===
@app.post("/api/move")  # ★ 新增
def api_move(req: MoveRequest):
  _, id_map, _ = _scan_state()
  dest = req.dest_path or "/"
  moved_ids = 0
  moved_folders = 0
  if req.ids:
    ws_move_items(WE_PATH, req.ids or [], dest, id_map)
    moved_ids = len(req.ids or [])
  if req.folder_paths:
    moved_folders = ws_move_folders(WE_PATH, req.folder_paths or [], dest)
  _invalidate_config_cache()
  return {"ok": True, "moved": moved_ids, "moved_folders": moved_folders}

# === 直接删除（危险操作，已在前端加确认框） ===
@app.post("/api/delete")
def api_delete(req: DeleteRequest):
  _, id_map, _ = _scan_state()
  deleted = []
  skipped = []
  for vid in req.ids:
    s = str(vid)
    if s.startswith("mp:"):
      ok = delete_myprojects_local_dir(WE_PATH, s)
      if ok:
        deleted.append(s)
      else:
        skipped.append(s)
      continue
    if s.startswith("p:"):
      v = id_map.get(s)
      if not v:
        skipped.append(s); continue
      ok = delete_we_projects_path_video(WE_PATH, s, v.video_path)
      if ok:
        deleted.append(s)
      else:
        skipped.append(s)
      continue
    if s not in id_map:
      skipped.append(s); continue
    ok = delete_id_dir(WORKSHOP_PATH, s)
    if ok: deleted.append(s)
    else: skipped.append(s)
  return {"deleted": deleted, "skipped": skipped}

# === 从 config.json 的 folders 结构中删除若干文件夹（不碰物理文件）===
@app.post("/api/folder/delete")
def api_folder_delete(req: FolderDeleteRequest):
  removed = ws_delete_folders(WE_PATH, req.paths or [])
  _invalidate_config_cache()
  return {"removed": removed}

# （保留 m3u 接口）
@app.post("/api/playlist")
def api_playlist(req: PlaylistRequest):
  _, id_map, _ = _scan_state()
  lines = ["#EXTM3U"]
  for vid in req.ids:
    v = id_map.get(vid)
    if v:
      lines.append(v.video_path)
  content = "\n".join(lines) + "\n"
  return PlainTextResponse(content, media_type="audio/x-mpegurl", headers={
    "Content-Disposition": "attachment; filename=we_playlist.m3u"
  })

# =======================
# 无检测：按需就地 faststart 重封装并覆盖原文件
# =======================
_repair_locks = {}
_repair_global_lock = threading.Lock()

def _get_repair_lock(path: str) -> threading.Lock:
  with _repair_global_lock:
    if path not in _repair_locks:
      _repair_locks[path] = threading.Lock()
    return _repair_locks[path]

def _choose_mux_and_ext(src: Path) -> Tuple[str | None, str]:
  """
  根据源文件后缀选择目标复用器与扩展名。
  仅在 MP4/M4V/MOV 上启用 faststart；其他容器保持原容器的无损 copy。
  """
  ext = (src.suffix or "").lower()
  if ext in (".mp4", ".m4v", ".mov"):
    return "mp4", ".mp4"
  if ext == ".mkv":
    return "matroska", ".mkv"
  if ext == ".webm":
    return "webm", ".webm"
  if ext == ".avi":
    return "avi", ".avi"
  # 默认回落到 mp4（可容纳大多数音视频流）
  return "mp4", ".mp4"

def _faststart_inplace(src_path: str) -> dict:
  """
  无损重封装（安全版）：
  - 以有效容器后缀生成同目录临时文件（不以 .tmp 结尾避免 FFmpeg 选复用器失败）；
  - 先写临时文件，校验后将源文件改名为 .bak，再原子替换；
  - 任一步失败自动回滚，保证源文件不丢失。
  返回 {ok, before, after, out} 或 {ok:False, error,...}
  """
  src_path = os.path.abspath(src_path)
  if not os.path.isfile(src_path):
    return {"ok": False, "error": "source-not-found", "path": src_path}

  before = os.path.getsize(src_path)
  src = Path(src_path)

  # 记录原始时间戳（纳秒）以便恢复
  try:
    st_old = os.stat(src_path)
    at_ns, mt_ns = st_old.st_atime_ns, st_old.st_mtime_ns
  except Exception:
    st_old = None
    at_ns = mt_ns = None

  mux, out_ext = _choose_mux_and_ext(src)
  # 生成“可识别扩展名”的临时产物（避免 .xxx.tmp 导致 FFmpeg 无法判断复用器）
  tmp_path = str(src.with_name(src.stem + ".fs" + out_ext))
  bak_path = str(src.with_name(src.name + ".bak"))

  # 构建命令
  cmd = [
      "ffmpeg", "-nostdin", "-y", "-hide_banner", "-loglevel", "error",
      "-i", src_path,
      "-map", "0", "-dn",
      "-c", "copy",
      "-map_metadata", "0",
  ]
  if mux == "mp4":
      cmd += ["-movflags", "+faststart", "-f", "mp4"]
  elif mux:
      cmd += ["-f", mux]
  cmd += [tmp_path]

  lock = _get_repair_lock(src_path)
  with lock:
    # 开始前清理同名残留
    try:
      if os.path.exists(tmp_path):
        os.remove(tmp_path)
    except Exception:
      pass

    ok = False
    try:
      # 1) 重封装到临时文件
      subprocess.run(cmd, check=True)
      if not os.path.isfile(tmp_path):
        return {"ok": False, "error": "tmp-not-produced", "path": src_path}
      after_tmp = os.path.getsize(tmp_path)
      if after_tmp <= 0:
        try: os.remove(tmp_path)
        except Exception: pass
        return {"ok": False, "error": "tmp-empty", "path": src_path}

      # 2) 原子替换（带回滚）
      #  2.1 先把源文件改名为 .bak
      if os.path.exists(bak_path):
        try: os.remove(bak_path)
        except Exception: pass
      os.replace(src_path, bak_path)
      try:
        #  2.2 再把临时文件替换为新的源
        os.replace(tmp_path, src_path)
      except Exception as e:
        #  2.3 失败 → 回滚
        try:
          if os.path.exists(bak_path) and not os.path.exists(src_path):
            os.replace(bak_path, src_path)
        finally:
          try:
            if os.path.exists(tmp_path):
              os.remove(tmp_path)
          except Exception:
            pass
        return {"ok": False, "error": f"replace-failed:{e}", "path": src_path}

      # 2.4 成功 → 删除备份
      try:
        if os.path.exists(bak_path):
          os.remove(bak_path)
      except Exception:
        pass

      # 3) 恢复时间戳（若可用）
      try:
        if at_ns is not None and mt_ns is not None:
          os.utime(src_path, ns=(at_ns, mt_ns))
      except Exception:
        try:
          if st_old is not None:
            os.utime(src_path, (st_old.st_atime, st_old.st_mtime))
        except Exception:
          pass

      after = os.path.getsize(src_path)
      ok = True
      return {"ok": True, "before": before, "after": after, "out": src_path}
    except subprocess.CalledProcessError as e:
      # FFmpeg 失败：清理临时产物
      try:
        if os.path.exists(tmp_path):
          os.remove(tmp_path)
      except Exception:
        pass
      return {"ok": False, "error": f"ffmpeg-failed:{e}", "path": src_path}
    except Exception as e:
      # 其他异常：尽力回滚
      try:
        if os.path.exists(bak_path) and not os.path.exists(src_path):
          os.replace(bak_path, src_path)
      except Exception:
        pass
      try:
        if os.path.exists(tmp_path):
          os.remove(tmp_path)
      except Exception:
        pass
      return {"ok": False, "error": f"exception:{e}", "path": src_path}

def _repair_inplace(src_path: str, mode: str = "auto") -> dict:
  """
  更强的“卡死点修复”（针对中途某秒必卡/解码错误）：
  - 先尝试“带 genpts/ignore_err 的无损重封装”，尽量修复时间戳/断裂问题；
  - 如仍失败，再回退到“转码修复”（重建编码流，代价更大但最稳）。
  返回 {ok, mode, before, after, out} 或 {ok:False, error,...}
  """
  src_path = os.path.abspath(src_path)
  if not os.path.isfile(src_path):
    return {"ok": False, "error": "source-not-found", "path": src_path}
  mode = (mode or "auto").lower().strip()
  if mode not in ("auto", "copy", "reencode"):
    mode = "auto"

  before = os.path.getsize(src_path)
  src = Path(src_path)

  # 保留时间戳
  try:
    st_old = os.stat(src_path)
    at_ns, mt_ns = st_old.st_atime_ns, st_old.st_mtime_ns
  except Exception:
    st_old = None
    at_ns = mt_ns = None

  mux, out_ext = _choose_mux_and_ext(src)
  tmp_copy = str(src.with_name(src.stem + ".rp_copy" + out_ext))
  tmp_enc  = str(src.with_name(src.stem + ".rp_enc"  + out_ext))
  bak_path = str(src.with_name(src.name + ".bak"))

  # 统一：尽量生成 PTS + 忽略坏包（对“某秒必卡”更有效）
  common_pre = ["ffmpeg", "-nostdin", "-y", "-hide_banner", "-loglevel", "error",
                "-fflags", "+genpts", "-err_detect", "ignore_err"]

  def _cmd_out(tmp_path: str, reencode: bool):
    cmd = common_pre + ["-i", src_path]
    if reencode:
      # 转码兜底：重建编码流，最稳但较慢
      # 只保留“主视频流 + 音频流”，避免 -map 0 把封面/附件/奇怪流也塞进输出导致前端选流异常。
      # 同时强制 yuv420p（浏览器/硬解兼容性最好），并把宽高压到偶数，避免某些源导致的异常像素格式/奇数分辨率问题。
      cmd += ["-map", "0:v:0", "-map", "0:a?", "-sn", "-dn", "-map_metadata", "0",
              "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p",
              "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
              "-pix_fmt", "yuv420p",
              "-tag:v", "avc1",
              "-c:a", "aac", "-b:a", "192k", "-ac", "2"]
    else:
      cmd += ["-map", "0", "-dn", "-map_metadata", "0", "-c", "copy"]
    if mux == "mp4":
      cmd += ["-movflags", "+faststart", "-avoid_negative_ts", "make_zero", "-f", "mp4"]
    elif mux:
      cmd += ["-f", mux]
    cmd += [tmp_path]
    return cmd

  lock = _get_repair_lock(src_path)
  with lock:
    # 清理残留
    for p in (tmp_copy, tmp_enc):
      try:
        if os.path.exists(p):
          os.remove(p)
      except Exception:
        pass

    def _atomic_replace(tmp_path: str):
      if os.path.exists(bak_path):
        try: os.remove(bak_path)
        except Exception: pass
      os.replace(src_path, bak_path)
      try:
        os.replace(tmp_path, src_path)
      except Exception as e:
        # 回滚
        try:
          if os.path.exists(bak_path) and not os.path.exists(src_path):
            os.replace(bak_path, src_path)
        finally:
          try:
            if os.path.exists(tmp_path):
              os.remove(tmp_path)
          except Exception:
            pass
        raise e
      # 删除备份
      try:
        if os.path.exists(bak_path):
          os.remove(bak_path)
      except Exception:
        pass
      # ★ 恢复原 mtime（Steam 会校验 mtime，修改后会触发重新下载）
      # 浏览器缓存刷新由前端的 cacheBust 机制（URL 时间戳参数）保证
      try:
        if at_ns is not None and mt_ns is not None:
          os.utime(src_path, ns=(at_ns, mt_ns))
      except Exception:
        try:
          if st_old is not None:
            os.utime(src_path, (st_old.st_atime, st_old.st_mtime))
        except Exception:
          pass

    # 1) 无损 copy 重封装（可选）
    if mode in ("auto", "copy"):
      try:
        subprocess.run(_cmd_out(tmp_copy, reencode=False), check=True)
        if os.path.isfile(tmp_copy) and os.path.getsize(tmp_copy) > 0:
          _atomic_replace(tmp_copy)
          after = os.path.getsize(src_path)
          return {
            "ok": True, "mode": "copy", "before": before, "after": after,
            "out": src_path, "mtime_preserved": True
          }
      except Exception as e:
        # copy 失败 → 继续尝试转码（auto），或直接返回（copy）
        try:
          if os.path.exists(tmp_copy):
            os.remove(tmp_copy)
        except Exception:
          pass
        if mode == "copy":
          return {"ok": False, "error": f"copy-failed:{e}", "path": src_path}

    # 2) 转码兜底
    try:
      subprocess.run(_cmd_out(tmp_enc, reencode=True), check=True)
      if os.path.isfile(tmp_enc) and os.path.getsize(tmp_enc) > 0:
        _atomic_replace(tmp_enc)
        after = os.path.getsize(src_path)
        return {
          "ok": True, "mode": "reencode", "before": before, "after": after,
          "out": src_path, "mtime_preserved": True
        }
      return {"ok": False, "error": "tmp-empty", "path": src_path}
    except Exception as e:
      try:
        if os.path.exists(tmp_enc):
          os.remove(tmp_enc)
      except Exception:
        pass
      return {"ok": False, "error": f"ffmpeg-repair-failed:{e}", "path": src_path}

@app.post("/api/faststart/{vid_id}")
def api_faststart_inplace(vid_id: str):
  """
  前端在「卡顿≥阈值」时调用：
  1) 若该 ID 曾执行过 faststart → 直接跳过（ok=true, skipped=true）；
  2) 否则就地无损重封装 + 覆盖原文件 + 恢复 mtime；
  3) 成功后标记该 ID 为已完成，前端拿到 ok 后重新加载播放即可。
  """
  # ★ 只运行一次：命中则跳过
  if _faststart_is_done(vid_id):
    return JSONResponse({"ok": True, "skipped": True, "reason": "already-done"})

  _, id_map, _ = _scan_state()
  v = id_map.get(vid_id)
  if not v:
    raise HTTPException(404, detail="video-not-found")

  res = _faststart_inplace(v.video_path)

  if res.get("ok"):
    _faststart_mark_done(vid_id)     # ★ 成功后标记“已执行过”
    res["skipped"] = False
    return JSONResponse(res, status_code=200)
  else:
    res["skipped"] = False
    return JSONResponse(res, status_code=500)

@app.post("/api/repair/{vid_id}")
def api_repair_inplace(vid_id: str, mode: str = Query("auto", description="auto|copy|reencode")):
  """
  针对"某秒必卡/解码错误"的更强修复：
  - 尝试 genpts+ignore_err 的无损重封装；
  - 失败则转码兜底。
  - ★ 修复后清理该 vid 的所有音频缓存，避免前端拿到旧的"只有音频"的缓存。
  - ★ 注意：当 mode=reencode 时，不覆盖原文件，而是写入 VIDEO_CACHE_DIR（避免触发 Steam 校验/重下）。
  """
  _, id_map, _ = _scan_state()
  v = id_map.get(vid_id)
  if not v:
    raise HTTPException(404, detail="video-not-found")

  print(f"[REPAIR] vid={vid_id} mode={mode} path={getattr(v,'video_path',None)}")
  if (mode or "").lower().strip() == "reencode":
    res = _reencode_to_video_cache(vid_id, v.video_path)
  else:
    res = _repair_inplace(v.video_path, mode=mode)
  print(f"[REPAIR] vid={vid_id} result_ok={res.get('ok')} result_mode={res.get('mode')} err={res.get('error')}")
  
  # ★ 修复成功后清理音频缓存（避免前端拿到旧的只有音频的 m4a）
  if res.get("ok"):
    try:
      _cleanup_old_audio_caches(vid_id, "")  # 清理该 vid 的所有音频缓存
      print(f"[REPAIR] vid={vid_id} cleaned audio caches")
    except Exception as e:
      print(f"[REPAIR] vid={vid_id} audio cache cleanup failed: {e}")
    return JSONResponse(res, status_code=200)
  return JSONResponse(res, status_code=500)

# =======================
# 媒体传输（预览 & 视频）
# =======================
def _etag_for(path: str) -> str:
  try:
    st = os.stat(path)
  except OSError:
    return ""
  return f'W/"{st.st_ino}-{st.st_size}-{int(st.st_mtime)}"'

def _last_modified_str(path: str) -> str:
  try:
    st = os.stat(path)
  except OSError:
    return ""
  dt = datetime.utcfromtimestamp(st.st_mtime)
  return dt.strftime("%a, %d %b %Y %H:%M:%S GMT")


# === 媒体文件 OS page cache 预热 ===
# 关键瓶颈：浏览器 buffer 见底 -> 发新 Range 请求 -> 服务端到磁盘 seek (HDD 上百 ms) -> 数据到达。
# 提前让内核把整段文件读进 page cache，后续 Range 请求只走内存，能从根本上消除"卡一下"的空窗期。
#
# 策略：
#   - 同一个绝对路径在一次容器生命周期内只预热一次（_prewarmed 记忆）
#   - 限制总体并发，防止用户连续点几十个视频时把磁盘打爆
#   - 限制单文件大小（默认 < 2GB），避免极端大文件挤掉别的缓存
#   - 后台线程，daemon=True，不阻塞请求响应
_prewarmed_paths: set[str] = set()
_prewarm_lock = threading.Lock()
_prewarm_sem = threading.BoundedSemaphore(2)  # 最多 2 个文件同时预热
_PREWARM_MAX_BYTES = int(os.getenv("PREWARM_MAX_BYTES", str(2 * 1024 * 1024 * 1024)))  # 2GB

def _prewarm_into_page_cache(path: str):
  """异步把整个文件读一遍喂进 OS page cache。

  - 用 posix_fadvise(WILLNEED) 给内核异步 readahead 提示，立即生效。
  - 再起一个后台线程把文件完整读一遍，确保覆盖大型 mp4 的所有 cluster，
    之后任何 Range 请求都能秒级命中 page cache。
  - 同一路径只做一次。
  """
  try:
    ap = os.path.abspath(path)
  except Exception:
    return
  with _prewarm_lock:
    if ap in _prewarmed_paths:
      return
    _prewarmed_paths.add(ap)

  # 1) 立即下发非阻塞 readahead 提示，由内核自己决定怎么读。
  try:
    if hasattr(os, "posix_fadvise"):
      fd = os.open(ap, os.O_RDONLY)
      try:
        os.posix_fadvise(fd, 0, 0, os.POSIX_FADV_SEQUENTIAL)
        os.posix_fadvise(fd, 0, 0, os.POSIX_FADV_WILLNEED)
      finally:
        os.close(fd)
  except Exception:
    pass

  # 2) 后台线程整段读一次，确保 page cache 真的落上。
  def _do():
    if not _prewarm_sem.acquire(blocking=False):
      # 并发上限到了，让出（已经下过 fadvise 提示，内核也会自己 readahead）
      return
    try:
      st = os.stat(ap)
      if st.st_size <= 0 or st.st_size > _PREWARM_MAX_BYTES:
        return
      with open(ap, "rb", buffering=0) as f:
        while True:
          chunk = f.read(4 * 1024 * 1024)  # 4MB
          if not chunk:
            break
    except Exception:
      # 预热失败不影响播放，移出已预热集合，下次还可以再试。
      with _prewarm_lock:
        _prewarmed_paths.discard(ap)
    finally:
      try:
        _prewarm_sem.release()
      except Exception:
        pass

  threading.Thread(target=_do, daemon=True, name=f"prewarm-{os.path.basename(ap)[:32]}").start()


def _send_media_file(path: str, media_type: str, etag: str, last_mod: str):
  """直接由 FastAPI 发送媒体文件。

  现代 Starlette FileResponse 已经原生支持：
    - HTTP Range（206 Partial Content）
    - 304 If-None-Match / If-Modified-Since（这里也额外做了一道）
    - 与 uvicorn 配合的 zero-copy `http.response.pathsend`（即 sendfile）

  我们额外：
    - Direct Play 用 128KB 小 chunk（DirectPlayFileResponse），迎合浏览器 Range 流控
    - HLS 段仍用 FastFileResponse 大 chunk
    - 触发 OS page cache 预热，消除浏览器 Range 拉取空窗期的磁盘 seek 延迟
  """
  if not os.path.isfile(path):
    raise HTTPException(404)
  _prewarm_into_page_cache(path)
  response_cls = DirectPlayFileResponse if media_type.startswith("video/") else FastFileResponse
  return response_cls(path, media_type=media_type, headers={
    "Accept-Ranges": "bytes",
    "ETag": etag,
    "Last-Modified": last_mod,
    "Cache-Control": "public, max-age=31536000, immutable",
  })

# =======================
# 视频转码缓存（video_cache/<vid_id>/...）
# =======================
def _video_cache_dir(vid_id: str) -> str:
  return os.path.join(VIDEO_CACHE_DIR, str(vid_id))

def _video_cache_meta_path(vid_id: str) -> str:
  return os.path.join(_video_cache_dir(vid_id), "meta.json")

def _video_cache_out_path(vid_id: str) -> str:
  # 强制转码输出统一为 mp4，便于浏览器播放
  return os.path.join(_video_cache_dir(vid_id), "reencode.mp4")

def _read_json(path: str) -> dict:
  try:
    with open(path, "r", encoding="utf-8") as f:
      return json.load(f) or {}
  except Exception:
    return {}

def _write_json_atomic(path: str, data: dict):
  tmp = path + ".tmp"
  with open(tmp, "w", encoding="utf-8") as f:
    json.dump(data, f, ensure_ascii=False, indent=2)
  os.replace(tmp, path)

def _is_video_cache_valid(vid_id: str, src_path: str) -> bool:
  outp = _video_cache_out_path(vid_id)
  meta = _video_cache_meta_path(vid_id)
  if not (os.path.isfile(outp) and os.path.getsize(outp) > 0 and os.path.isfile(meta)):
    return False
  m = _read_json(meta)
  try:
    st = os.stat(src_path)
  except Exception:
    return False
  try:
    return (
      os.path.abspath(m.get("src_path", "")) == os.path.abspath(src_path)
      and int(m.get("src_size", -1)) == int(st.st_size)
      and int(m.get("src_mtime", -1)) == int(st.st_mtime)
      and int(m.get("src_ino", -1)) == int(getattr(st, "st_ino", -1))
    )
  except Exception:
    return False

def _get_video_cache_path_if_any(vid_id: str, src_path: str) -> str | None:
  try:
    if _is_video_cache_valid(vid_id, src_path):
      return _video_cache_out_path(vid_id)
  except Exception:
    pass
  return None

def _reencode_to_video_cache(vid_id: str, src_path: str) -> dict:
  """
  强制转码修复：输出到 data/video_cache/<vid_id>/reencode.mp4，不覆盖原文件（避免触发 Steam 校验/重下）。
  返回 {ok, mode, before, after, out, cached:true}
  """
  src_path = os.path.abspath(src_path)
  if not os.path.isfile(src_path):
    return {"ok": False, "error": "source-not-found", "path": src_path}

  before = os.path.getsize(src_path)
  try:
    st = os.stat(src_path)
    src_meta = {
      "src_path": src_path,
      "src_size": int(st.st_size),
      "src_mtime": int(st.st_mtime),
      "src_ino": int(getattr(st, "st_ino", -1)),
      "created_at": int(time.time()),
    }
  except Exception:
    src_meta = {"src_path": src_path, "created_at": int(time.time())}

  out_dir = _video_cache_dir(vid_id)
  os.makedirs(out_dir, exist_ok=True)
  out_path = _video_cache_out_path(vid_id)
  tmp_out = out_path + ".tmp"

  # 若已有且仍有效，直接复用
  if _is_video_cache_valid(vid_id, src_path):
    try:
      return {
        "ok": True, "mode": "reencode_cache", "before": before,
        "after": os.path.getsize(out_path), "out": out_path, "cached": True, "reused": True
      }
    except Exception:
      pass

  common_pre = ["ffmpeg", "-nostdin", "-y", "-hide_banner", "-loglevel", "error",
                "-fflags", "+genpts", "-err_detect", "ignore_err"]
  # 强制浏览器兼容：H.264 (avc1) + AAC + yuv420p + 偶数宽高 + MP4
  cmd = common_pre + [
    "-i", src_path,
    "-map", "0:v:0",
    "-map", "0:a?",
    "-sn", "-dn",
    "-map_metadata", "0",
    "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
    "-pix_fmt", "yuv420p",
    "-tag:v", "avc1",
    "-c:a", "aac", "-b:a", "192k", "-ac", "2",
    "-movflags", "+faststart",
    "-avoid_negative_ts", "make_zero",
    "-f", "mp4",
    tmp_out
  ]

  try:
    if os.path.exists(tmp_out):
      os.remove(tmp_out)
  except Exception:
    pass

  try:
    subprocess.run(cmd, check=True)
    if not os.path.isfile(tmp_out) or os.path.getsize(tmp_out) <= 0:
      try:
        if os.path.exists(tmp_out):
          os.remove(tmp_out)
      except Exception:
        pass
      return {"ok": False, "error": "tmp-empty", "path": src_path}

    os.replace(tmp_out, out_path)
    try:
      _write_json_atomic(_video_cache_meta_path(vid_id), src_meta | {"ffmpeg": " ".join(cmd)})
    except Exception:
      try:
        _write_json_atomic(_video_cache_meta_path(vid_id), src_meta)
      except Exception:
        pass

    after = os.path.getsize(out_path)
    return {"ok": True, "mode": "reencode_cache", "before": before, "after": after, "out": out_path, "cached": True}
  except Exception as e:
    try:
      if os.path.exists(tmp_out):
        os.remove(tmp_out)
    except Exception:
      pass
    return {"ok": False, "error": f"ffmpeg-reencode-cache-failed:{e}", "path": src_path}

# ======= 预览图（新增：缩放/转码/缓存） =======
def _client_supports_webp(request: Request) -> bool:
  accept = request.headers.get("accept", "")
  return "image/webp" in accept.lower()

def _ext_from_mime(mime: str) -> str:
  if not mime: return ".bin"
  if "jpeg" in mime: return ".jpg"
  if "png" in mime: return ".png"
  if "gif" in mime: return ".gif"
  if "webp" in mime: return ".webp"
  return mimetypes.guess_extension(mime) or ".bin"

@app.get("/media/preview/{vid_id}")
def media_preview(vid_id: str, request: Request,
                  s: int | None = Query(default=None, ge=32, le=2048, description="方形缩略图边长"),
                  fmt: str | None = Query(default=None, description="webp|jpeg|png|auto"),
                  q: int = Query(default=80, ge=10, le=100)):
  # 构建原图信息
  from PIL import Image, ImageSequence  # 需要 pillow
  _, id_map, _ = _scan_state()
  v = id_map.get(vid_id)
  if not v: raise HTTPException(404)
  src_path = v.preview_path
  if not src_path or not os.path.isfile(src_path):
    raise HTTPException(404, detail="preview not available")

  # 基础元数据
  src_mime, _ = mimetypes.guess_type(src_path)
  src_mime = src_mime or "image/gif"
  src_etag = _etag_for(src_path)
  last_mod = _last_modified_str(src_path)

  # 如果未请求缩放/转码，就直接走原图（保持你之前的强缓存行为）
  want_auto = (fmt is None or fmt == "auto")
  target_fmt = None
  if want_auto:
    target_fmt = "webp" if _client_supports_webp(request) else None
  else:
    f = (fmt or "").lower().strip()
    if f in ("webp","jpeg","jpg","png"): target_fmt = "jpg" if f=="jpg" else f
    else: target_fmt = None  # 未知 → 不转码

  # 是否需要处理
  need_resize = s is not None
  need_transcode = target_fmt is not None and not src_mime.endswith(target_fmt)

  if not need_resize and not need_transcode:
    # 直接返回原图（带条件缓存）
    inm = request.headers.get("if-none-match")
    ims = request.headers.get("if-modified-since")
    if inm == src_etag:
      return Response(status_code=304, headers={
        "ETag": src_etag, "Last-Modified": last_mod,
        "Cache-Control": "public, max-age=31536000, immutable",
        "Vary": "Accept",
      })
    if ims:
      try:
        ims_dt = parsedate_to_datetime(ims)
        if int(os.stat(src_path).st_mtime) <= int(ims_dt.timestamp()):
          return Response(status_code=304, headers={
            "ETag": src_etag, "Last-Modified": last_mod,
            "Cache-Control": "public, max-age=31536000, immutable",
            "Vary": "Accept",
          })
      except Exception:
        pass
    return FileResponse(src_path, media_type=src_mime, headers={
      "ETag": src_etag, "Last-Modified": last_mod,
      "Cache-Control": "public, max-age=31536000, immutable",
      "Vary": "Accept",
    })

  # 生成缓存 key
  st = os.stat(src_path)
  fs_vid = _fs_safe_vid_token(vid_id)
  key_raw = f"{vid_id}|{int(st.st_mtime)}|{st.st_size}|{s or 0}|{target_fmt or 'orig'}|{q}"
  key_hash = hashlib.sha1(key_raw.encode("utf-8")).hexdigest()[:20]
  out_ext = ".webp" if (target_fmt == "webp") else (".jpg" if target_fmt in ("jpg","jpeg") else (".png" if target_fmt=="png" else _ext_from_mime(src_mime)))
  cache_path = os.path.join(PREVIEW_CACHE_DIR, f"{fs_vid}_{key_hash}{out_ext}")
  etag = f'W/"prev-{key_hash}"'

  # 条件缓存（对加工品）
  inm = request.headers.get("if-none-match")
  if inm == etag and os.path.isfile(cache_path):
    return Response(status_code=304, headers={
      "ETag": etag, "Last-Modified": last_mod,
      "Cache-Control": "public, max-age=31536000, immutable",
      "Vary": "Accept",
    })

  # 命中文件缓存
  if os.path.isfile(cache_path):
    mime = mimetypes.guess_type(cache_path)[0] or "image/webp"
    return FileResponse(cache_path, media_type=mime, headers={
      "ETag": etag, "Last-Modified": last_mod,
      "Cache-Control": "public, max-age=31536000, immutable",
      "Vary": "Accept",
    })

  # 需要生成：加锁防并发
  lock = _get_cache_lock(cache_path)
  with lock:
    # 双检：可能别的请求已生成
    if os.path.isfile(cache_path):
      mime = mimetypes.guess_type(cache_path)[0] or "image/webp"
      return FileResponse(cache_path, media_type=mime, headers={
        "ETag": etag, "Last-Modified": last_mod,
        "Cache-Control": "public, max-age=31536000, immutable",
        "Vary": "Accept",
      })

    # 处理图像
    try:
      im = Image.open(src_path)
    except Exception:
      # 打不开 → 直接原图兜底
      return FileResponse(src_path, media_type=src_mime, headers={
        "ETag": src_etag, "Last-Modified": last_mod,
        "Cache-Control": "public, max-age=31536000, immutable",
        "Vary": "Accept",
      })

    # 判断动图
    is_animated = getattr(im, "is_animated", False) and getattr(im, "n_frames", 1) > 1

    def _resize_square(img):
      """等比缩到最短边>=s，然后居中裁切 s×s；若 s 未给则原尺寸"""
      if not s: return img
      w, h = img.size
      if w == 0 or h == 0: return img
      # 先等比缩放使“短边”>= s（尽量少放大）
      short = float(min(w, h))
      scale = s / short
      new_w = max(s, int(w * scale))
      new_h = max(s, int(h * scale))
      if (new_w, new_h) != (w, h):
        img = img.resize((new_w, new_h), Image.LANCZOS)
      left = max((img.width - s) // 2, 0)
      top  = max((img.height - s) // 2, 0)
      img = img.crop((left, top, left + s, top + s))
      return img

    tmp_path = cache_path + ".tmp"

    try:
      if is_animated and (target_fmt == "webp"):
        # 转 WebP 动图
        frames = []
        durations = []
        try:
          from PIL import ImageSequence
          for f in ImageSequence.Iterator(im):
            frame = f.convert("RGBA")
            frame = _resize_square(frame)
            frames.append(frame)
            durations.append(f.info.get("duration", im.info.get("duration", 40)))
        except Exception:
          # 退化：取第一帧静态
          frame = im.convert("RGBA")
          frame = _resize_square(frame)
          frames = [frame]
          durations = [im.info.get("duration", 40)]
        if not frames:
          frames = [im.convert("RGBA")]
          frames[0] = _resize_square(frames[0])
          durations = [40]
        frames[0].save(tmp_path, format="WEBP", save_all=True,
                       append_images=frames[1:] if len(frames)>1 else None,
                       duration=durations, loop=0, quality=q, method=6)
      else:
        # 静态图或不转码动图：导出为 webp/jpeg/png/或原格式
        # 统一先转成 RGB(A) 以避免模式问题
        fmt_out = ("WEBP" if target_fmt == "webp" else
                   "JPEG" if target_fmt in ("jpg","jpeg") else
                   "PNG"  if target_fmt == "png" else None)
        base = im.convert("RGBA") if im.mode not in ("RGB","RGBA") else im
        base = _resize_square(base) if need_resize else base
        save_kwargs = {}
        if fmt_out == "JPEG":
          base = base.convert("RGB")
          save_kwargs.update(dict(quality=q, progressive=True, optimize=True))
        elif fmt_out == "WEBP":
          save_kwargs.update(dict(quality=q, method=6))
        elif fmt_out == "PNG":
          save_kwargs.update(dict(optimize=True))
        # 未指定 fmt_out → 按原后缀导出（尽量保真）
        out_fmt_final = fmt_out or (im.format if im.format in ("PNG","JPEG","WEBP","GIF") else "PNG")
        base.save(tmp_path, format=out_fmt_final, **save_kwargs)

      # 原子落盘
      os.replace(tmp_path, cache_path)
      mime = mimetypes.guess_type(cache_path)[0] or "image/webp"
      return FileResponse(cache_path, media_type=mime, headers={
        "ETag": etag, "Last-Modified": last_mod,
        "Cache-Control": "public, max-age=31536000, immutable",
        "Vary": "Accept",
      })
    except Exception:
      # 出错兜底：直接原图
      try:
        if os.path.exists(tmp_path):
          os.remove(tmp_path)
      except Exception:
        pass
      return FileResponse(src_path, media_type=src_mime, headers={
        "ETag": src_etag, "Last-Modified": last_mod,
        "Cache-Control": "public, max-age=31536000, immutable",
        "Vary": "Accept",
      })

# =======================
# HLS 切片（ffmpeg 输出 m3u8 + ts 段，HLS.js 播）
# =======================
def _hls_dir_for(vid_id: str, tier: str = "full") -> str:
  root = HLS_PREVIEW_CACHE_DIR if _hls_is_preview_tier(tier) else HLS_CACHE_DIR
  return os.path.join(root, str(vid_id))

# 同 vid_id 同时只跑一个 ffmpeg
_hls_locks: dict[str, threading.Lock] = {}
_hls_locks_guard = threading.Lock()
_hls_jobs: dict[str, dict] = {}
_hls_jobs_guard = threading.Lock()
_hls_disabled_modes: set[str] = set()
_hls_disabled_modes_guard = threading.Lock()
_hls_encoder_probe_cache: dict[str, bool] = {}
_HLS_HW_STATE_PATH = os.path.join(DATA_DIR, "hls_hw_state.json")
_HLS_HW_ERR_MARKERS = (
  "mfx session",
  "error creating a mfx",
  "no capable devices",
  "openencodesessionex",
  "incompatible client key",
  "cannot load nvcuda",
  "does not support nvenc",
  "device failed",
  "not supported on this device",
)
_HLS_HW_ERR_TRANSIENT = (
  "too many",
  "out of memory",
  "resource temporarily unavailable",
  "try again",
  "encoder busy",
  "no free encoder",
  "insufficient resources",
  "exceeded",
  "max concurrent",
  "cannot create channel",
  "busy",
  "temporarily",
  "too many clients",
  "encode session",
)
_hls_runtime_probe_last_errors: dict[str, str] = {}
_hls_runtime_probe_attempt_errors: dict[str, dict[str, str]] = {}
_hls_qsv_hw_prefix: list[str] = []


class _HlsHwSlotPool:
  """NVENC / Intel 分池限流；preview 与 full 可有不同上限；遇瞬时错误可动态回退。"""

  def __init__(self, name: str, ceiling_full: int, ceiling_preview: int, floor: int = 1):
    self.name = name
    self.ceiling_full = max(1, int(ceiling_full))
    self.ceiling_preview = max(1, int(ceiling_preview))
    self.floor = max(1, int(floor))
    self._in_use = 0
    self._lock = threading.RLock()
    self._cond = threading.Condition(self._lock)
    self._pressure_level = 0
    self._pressure_until = 0.0

  def ceiling(self, tier: str = "full") -> int:
    return self.ceiling_preview if _hls_is_preview_tier(tier) else self.ceiling_full

  def effective_max(self, tier: str = "full") -> int:
    base = self.ceiling(tier)
    if not HLS_HW_SLOTS_DYNAMIC:
      return base
    with self._lock:
      if self._pressure_level > 0 and time.time() < self._pressure_until:
        return max(self.floor, base - self._pressure_level)
      return base

  def note_transient_pressure(self, step: int = 1):
    if not HLS_HW_SLOTS_DYNAMIC:
      return
    with self._lock:
      cap = max(self.ceiling_full, self.ceiling_preview)
      self._pressure_level = min(cap - self.floor, self._pressure_level + max(1, step))
      self._pressure_until = time.time() + 75
      eff_full = max(self.floor, self.ceiling_full - self._pressure_level)
      eff_prev = max(self.floor, self.ceiling_preview - self._pressure_level)
      logging.info("[hls] %s slot pressure -> effective full≤%s preview≤%s (level=%s)",
                   self.name, eff_full, eff_prev, self._pressure_level)
      self._cond.notify_all()

  def tick_recovery(self):
    if not HLS_HW_SLOTS_DYNAMIC:
      return
    with self._lock:
      if self._pressure_level <= 0:
        return
      if time.time() < self._pressure_until:
        return
      self._pressure_level = max(0, self._pressure_level - 1)
      if self._pressure_level > 0:
        self._pressure_until = time.time() + 45
      else:
        self._pressure_until = 0.0
      logging.info("[hls] %s slot pressure eased level=%s", self.name, self._pressure_level)
      self._cond.notify_all()

  def acquire(self, tier: str, timeout: float) -> bool:
    deadline = time.time() + max(0.05, float(timeout))
    with self._cond:
      while True:
        if self._in_use < self.effective_max(tier):
          self._in_use += 1
          return True
        remaining = deadline - time.time()
        if remaining <= 0:
          return False
        self._cond.wait(timeout=min(2.0, remaining))

  def release(self):
    with self._cond:
      self._in_use = max(0, self._in_use - 1)
      self._cond.notify()

  def stats(self, tier: str = "full") -> dict:
    with self._lock:
      return {
        "name": self.name,
        "in_use": self._in_use,
        "ceiling": self.ceiling(tier),
        "effective_max": self.effective_max(tier),
        "pressure_level": self._pressure_level,
        "pressure_until": int(self._pressure_until) if self._pressure_until else 0,
      }


_hls_nvenc_pool = _HlsHwSlotPool("nvenc", HLS_NVENC_MAX, HLS_NVENC_MAX_PREVIEW)
_hls_intel_pool = _HlsHwSlotPool("intel", HLS_INTEL_MAX, HLS_INTEL_MAX_PREVIEW)
_hls_hw_assign_counter = 0
_hls_hw_assign_lock = threading.Lock()
_hls_copy_blocked_sources: dict[str, str] = {}
_hls_copy_blocked_guard = threading.Lock()
_hls_playheads: dict[str, tuple[float, float]] = {}
_hls_playheads_guard = threading.Lock()
# 段请求推断的缓冲前沿（多窗口/iframe 时 progress 上报可能被节流，避免误杀 ffmpeg）
_hls_segment_demand: dict[str, tuple[float, float]] = {}
_hls_segment_demand_guard = threading.Lock()
_hls_abandoned: set[str] = set()
_hls_abandoned_guard = threading.Lock()
_hls_preview_priority: dict[str, tuple[float, float]] = {}
_hls_preview_priority_guard = threading.Lock()

def _hls_norm_vid_id(vid_id: str) -> str:
  v = str(vid_id or "").strip()
  if v.lower().startswith("mp:"):
    return v[3:]
  return v

def _hls_vid_matches(job_vid: str, req_vid: str) -> bool:
  a = str(job_vid or "").strip()
  b = str(req_vid or "").strip()
  if not a or not b:
    return False
  if a == b:
    return True
  return _hls_norm_vid_id(a) == _hls_norm_vid_id(b)

def _hls_abandon_key(vid_id: str, tier: str = "preview") -> str:
  return f"{_hls_norm_vid_id(vid_id)}@{_hls_norm_tier(tier)}"

def _hls_mark_abandoned(vid_id: str, tier: str = "preview"):
  with _hls_abandoned_guard:
    _hls_abandoned.add(_hls_abandon_key(vid_id, tier))

def _hls_clear_abandoned(vid_id: str, tier: str = "preview"):
  with _hls_abandoned_guard:
    _hls_abandoned.discard(_hls_abandon_key(vid_id, tier))

def _hls_is_abandoned(vid_id: str, tier: str = "preview") -> bool:
  with _hls_abandoned_guard:
    return _hls_abandon_key(vid_id, tier) in _hls_abandoned

def _hls_priority_key(vid_id: str, tier: str = "preview") -> str:
  return _hls_abandon_key(vid_id, tier)

def _hls_set_preview_priority(vid_id: str, priority: float, tier: str = "preview"):
  key = _hls_priority_key(vid_id, tier)
  with _hls_preview_priority_guard:
    _hls_preview_priority[key] = (float(priority), time.time())

def _hls_get_preview_priority(vid_id: str, tier: str = "preview") -> float:
  key = _hls_priority_key(vid_id, tier)
  with _hls_preview_priority_guard:
    return float((_hls_preview_priority.get(key) or (0.0, 0.0))[0])

def _hls_preview_job_has_segment(job: dict, idx: int | None = None) -> bool:
  if not job:
    return False
  vid = str(job.get("vid_id") or "")
  tier = _hls_norm_tier(str(job.get("tier") or "preview"))
  start = max(0, int(idx if idx is not None else job.get("start_index") or 0))
  out_dir = _hls_dir_for(vid, tier)
  return _hls_segment_file_ready(_hls_segment_path(out_dir, start))

def _hls_evict_lower_preview_jobs(vid_id: str, only_if_slot_needed: bool = False) -> int:
  """仅 evict 已有首段就绪的低优先级 job；warming（尚无 seg0）永不杀，避免 HLS 已 attach 但黑屏。"""
  my_pri = _hls_get_preview_priority(vid_id, "preview")
  victims: list[tuple[float, dict]] = []
  with _hls_jobs_guard:
    for job in list(_hls_jobs.values()):
      if not job or job.get("done"):
        continue
      if _hls_norm_tier(str(job.get("tier") or "full")) != "preview":
        continue
      jvid = str(job.get("vid_id") or "")
      if _hls_vid_matches(jvid, vid_id):
        continue
      jpri = _hls_get_preview_priority(jvid, "preview")
      if jpri >= my_pri:
        continue
      if not _hls_preview_job_has_segment(job, 0):
        continue
      victims.append((jpri, job))
  victims.sort(key=lambda x: x[0])
  killed = 0
  for _, job in victims:
    logging.info(
      "[hls] evict lower-priority preview job vid=%s pri=%s for vid=%s pri=%s",
      job.get("vid_id"),
      _hls_get_preview_priority(str(job.get("vid_id") or ""), "preview"),
      vid_id,
      my_pri,
    )
    _hls_kill_job(job)
    killed += 1
    if only_if_slot_needed:
      break
  return killed

def _hls_lock(vid_id: str) -> threading.Lock:
  with _hls_locks_guard:
    if vid_id not in _hls_locks:
      _hls_locks[vid_id] = threading.Lock()
    return _hls_locks[vid_id]

def _hls_mode_disabled(mode: str) -> bool:
  with _hls_disabled_modes_guard:
    return mode in _hls_disabled_modes

def _hls_disable_mode(mode: str, err: str = ""):
  if mode not in _hls_hw_modes():
    return
  if not _hls_should_disable_mode(mode, err):
    logging.warning("[hls] transient hw error mode=%s (not disabling): %s", mode, (err or "")[-240:])
    return
  with _hls_disabled_modes_guard:
    if mode in _hls_disabled_modes:
      return
    _hls_disabled_modes.add(mode)
  _hls_encoder_probe_cache[mode] = False
  _hls_save_hw_encoder_state()
  logging.warning("[hls] disable mode=%s after failure: %s", mode, (err or "")[-300:])

def _hls_hardware_encoder_error(err: str) -> bool:
  low = (err or "").casefold()
  return any(m in low for m in _HLS_HW_ERR_MARKERS)

def _hls_transient_hw_error(err: str) -> bool:
  low = (err or "").casefold()
  return any(m in low for m in _HLS_HW_ERR_TRANSIENT)

def _hls_should_disable_mode(mode: str, err: str) -> bool:
  if mode not in {"nvenc", "qsv", "vaapi"}:
    return False
  if not err:
    return False
  if _hls_transient_hw_error(err):
    return False
  return _hls_hardware_encoder_error(err)

def _hls_hw_modes() -> set[str]:
  return {"nvenc", "qsv", "vaapi"}

def _hls_is_hw_mode(mode: str) -> bool:
  return str(mode or "") in _hls_hw_modes()

def _hls_release_job_hw_slot(job: dict | None):
  if not job or job.get("hw_slot_released"):
    return
  if job.get("hw_slot"):
    mode = str(job.get("hw_slot_mode") or job.get("mode") or "")
    _hls_release_hw_slot(mode)
  job["hw_slot_released"] = True

def _hls_hw_slot_group(mode: str) -> str:
  if mode == "nvenc":
    return "nvenc"
  if mode in {"qsv", "vaapi"}:
    return "intel"
  return ""

def _hls_hw_slot_pool(grp: str) -> _HlsHwSlotPool | None:
  if grp == "nvenc":
    return _hls_nvenc_pool
  if grp == "intel":
    return _hls_intel_pool
  return None

def _hls_acquire_hw_slot(mode: str, timeout: float, tier: str = "full") -> bool:
  grp = _hls_hw_slot_group(mode)
  pool = _hls_hw_slot_pool(grp)
  if pool is None:
    return True
  return pool.acquire(tier, timeout)

def _hls_release_hw_slot(mode: str):
  grp = _hls_hw_slot_group(mode)
  pool = _hls_hw_slot_pool(grp)
  if pool is None:
    return
  try:
    pool.release()
  except ValueError:
    pass

def _hls_note_hw_slot_pressure(mode: str, err: str = ""):
  if err and not _hls_transient_hw_error(err):
    return
  grp = _hls_hw_slot_group(mode)
  pool = _hls_hw_slot_pool(grp)
  if pool:
    pool.note_transient_pressure()

def _hls_hw_concurrent_max(tier: str = "preview") -> int:
  tier = _hls_norm_tier(tier)
  hw = _hls_available_hw_modes()
  total = 0
  if "nvenc" in hw and not _hls_mode_disabled("nvenc"):
    total += _hls_nvenc_pool.effective_max(tier)
  if any(m in hw for m in ("qsv", "vaapi")) and not (
    _hls_mode_disabled("qsv") and _hls_mode_disabled("vaapi")
  ):
    total += _hls_intel_pool.effective_max(tier)
  return max(1, total)

def _hls_hw_capacity(tier: str = "preview") -> dict:
  tier = _hls_norm_tier(tier)
  hw = _hls_available_hw_modes()
  out = {
    "ok": True,
    "tier": tier,
    "dynamic": HLS_HW_SLOTS_DYNAMIC,
    "dual_gpu": _hls_dual_gpu_enabled(),
    "concurrent_max": _hls_hw_concurrent_max(tier),
    "nvenc": _hls_nvenc_pool.stats(tier) if "nvenc" in hw else None,
    "intel": _hls_intel_pool.stats(tier) if any(m in hw for m in ("qsv", "vaapi")) else None,
    "nvenc_max_full": HLS_NVENC_MAX,
    "intel_max_full": HLS_INTEL_MAX,
    "nvenc_max_preview": HLS_NVENC_MAX_PREVIEW,
    "intel_max_preview": HLS_INTEL_MAX_PREVIEW,
  }
  return out

def _hls_hw_slot_recovery():
  while True:
    try:
      time.sleep(30)
      _hls_nvenc_pool.tick_recovery()
      _hls_intel_pool.tick_recovery()
    except Exception as e:
      logging.warning("[hls] hw slot recovery error: %s", e)

def _hls_available_hw_modes() -> list[str]:
  modes: list[str] = []
  if not _hls_mode_disabled("nvenc") and _hls_encoder_available("nvenc"):
    modes.append("nvenc")
  intel: str | None = None
  if not _hls_mode_disabled("qsv") and _hls_encoder_available("qsv"):
    intel = "qsv"
  elif not _hls_mode_disabled("vaapi") and _hls_encoder_available("vaapi"):
    intel = "vaapi"
  if intel:
    modes.append(intel)
  return modes

def _hls_dual_gpu_enabled() -> bool:
  if HLS_DUAL_GPU in {"0", "false", "no", "off"}:
    return False
  if HLS_DUAL_GPU in {"1", "true", "yes", "on"}:
    return True
  hw = _hls_available_hw_modes()
  return ("nvenc" in hw) and any(m in hw for m in ("qsv", "vaapi"))

def _hls_pick_hw_mode(vid_id: str | None) -> str | None:
  modes = _hls_available_hw_modes()
  if not modes:
    return None
  if len(modes) == 1:
    return modes[0]
  if not _hls_dual_gpu_enabled():
    return modes[0]
  seed = str(vid_id or "")
  with _hls_hw_assign_lock:
    global _hls_hw_assign_counter
    _hls_hw_assign_counter += 1
    n = _hls_hw_assign_counter
  nvenc_ok = "nvenc" in modes
  intel_mode = next((m for m in modes if m != "nvenc"), None)
  if nvenc_ok and intel_mode:
    if seed:
      return "nvenc" if (hash(seed) % 2 == 0) else intel_mode
    return "nvenc" if (n % 2 == 0) else intel_mode
  return modes[n % len(modes)]

def _hls_running_jobs_summary() -> dict:
  summary = {"total": 0, "hw": 0, "by_mode": {}, "jobs": []}
  with _hls_jobs_guard:
    for key, job in _hls_jobs.items():
      if not job or job.get("done") or job.get("killed"):
        continue
      proc = job.get("proc")
      try:
        running = proc is None or proc.poll() is None
      except Exception:
        running = False
      if not running:
        continue
      mode = str(job.get("mode") or "")
      summary["total"] += 1
      if _hls_is_hw_mode(mode):
        summary["hw"] += 1
      summary["by_mode"][mode] = int(summary["by_mode"].get(mode) or 0) + 1
      if len(summary["jobs"]) < 12:
        summary["jobs"].append({
          "key": key,
          "vid": job.get("vid_id"),
          "mode": mode,
          "tier": job.get("tier") or "full",
        })
  summary["nvenc_max"] = HLS_NVENC_MAX
  summary["intel_max"] = HLS_INTEL_MAX
  summary["nvenc_max_preview"] = HLS_NVENC_MAX_PREVIEW
  summary["intel_max_preview"] = HLS_INTEL_MAX_PREVIEW
  summary["nvenc_slots"] = _hls_nvenc_pool.stats("full")
  summary["intel_slots"] = _hls_intel_pool.stats("full")
  summary["preview_concurrent_max"] = _hls_hw_concurrent_max("preview")
  summary["prefer_gpu"] = HLS_PREFER_GPU
  summary["dual_gpu"] = _hls_dual_gpu_enabled()
  return summary

def _hls_load_hw_encoder_state():
  try:
    with open(_HLS_HW_STATE_PATH, "r", encoding="utf-8") as f:
      data = json.load(f)
  except Exception:
    return
  if not isinstance(data, dict):
    return
  saved_ff = str(data.get("ffmpeg_version") or "").strip()
  current_ff = _hls_ffmpeg_version()
  if not saved_ff or (current_ff and saved_ff != current_ff):
    if data.get("probe") or data.get("disabled"):
      logging.info("[hls] ignore stale hw probe cache (ffmpeg_version missing or changed)")
    return
  for mode, ok in (data.get("probe") or {}).items():
    if mode in {"nvenc", "qsv", "vaapi"}:
      _hls_encoder_probe_cache[str(mode)] = bool(ok)
  with _hls_disabled_modes_guard:
    for mode in (data.get("disabled") or []):
      if mode in {"nvenc", "qsv", "vaapi"}:
        _hls_disabled_modes.add(str(mode))

def _hls_save_hw_encoder_state():
  try:
    with _hls_disabled_modes_guard:
      disabled = sorted(_hls_disabled_modes)
    data = {
      "ffmpeg_version": _hls_ffmpeg_version(),
      "probe": {k: v for k, v in _hls_encoder_probe_cache.items() if k in {"nvenc", "qsv", "vaapi"}},
      "disabled": disabled,
      "updated_at": int(time.time()),
    }
    tmp = _HLS_HW_STATE_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
      json.dump(data, f, ensure_ascii=False, indent=2)
    os.replace(tmp, _HLS_HW_STATE_PATH)
  except Exception as e:
    logging.warning("[hls] save hw encoder state failed: %s", e)

def _hls_qsv_init_options() -> list[tuple[str, list[str]]]:
  """ffmpeg 7 QSV 设备初始化（按优先级尝试）。"""
  dev = HLS_QSV_DEVICE
  if not dev or not os.path.exists(dev):
    return []
  driver = os.getenv("LIBVA_DRIVER_NAME", "iHD")
  return [
    ("legacy-qsv", ["-qsv_device", dev]),
    ("hw-child-vaapi", [
      "-init_hw_device", f"qsv=hw,child_device={dev},child_device_type=vaapi",
      "-filter_hw_device", "hw",
    ]),
    ("hw-child", [
      "-init_hw_device", f"qsv=hw,child_device={dev}",
      "-filter_hw_device", "hw",
    ]),
    ("va-derived", [
      "-init_hw_device", f"vaapi=va:{dev},driver={driver}",
      "-init_hw_device", "qsv=hw@va",
      "-filter_hw_device", "hw",
    ]),
  ]

def _hls_ffmpeg_hw_prefix(mode: str) -> list[str]:
  if mode == "qsv":
    if _hls_qsv_hw_prefix:
      return list(_hls_qsv_hw_prefix)
    opts = _hls_qsv_init_options()
    return list(opts[0][1]) if opts else []
  if mode == "vaapi":
    dev = HLS_QSV_DEVICE
    driver = os.getenv("LIBVA_DRIVER_NAME", "iHD")
    if dev and os.path.exists(dev):
      return ["-init_hw_device", f"vaapi=va:{dev},driver={driver}", "-filter_hw_device", "va"]
    return []
  if mode == "nvenc" and _hls_use_nvenc_cuda():
    return ["-init_hw_device", "cuda=cu:0", "-filter_hw_device", "cu"]
  return []

def _hls_runtime_probe_encoder(mode: str) -> bool:
  global _hls_nvenc_probe_cuda, _hls_qsv_hw_prefix
  if mode == "nvenc":
    attempts: list[tuple[str, list[str]]] = []
    if _hls_nvenc_env_cuda and _hls_nvenc_has_nvidia():
      attempts.append(("cuda", ["-init_hw_device", "cuda=cu:0", "-filter_hw_device", "cu"]))
    attempts += [
      ("plain", []),
      ("plain-auto", []),
    ]
  elif mode == "qsv":
    attempts = _hls_qsv_init_options()
  else:
    return False
  last_err = ""
  attempt_errors: dict[str, str] = {}
  for variant, hw_prefix in attempts:
    cmd = _hls_runtime_probe_cmd(mode, variant, hw_prefix)
    try:
      proc = subprocess.run(
        cmd,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        timeout=15,
      )
      if proc.returncode == 0:
        if mode == "nvenc":
          _hls_nvenc_probe_cuda = (variant == "cuda")
          logging.info("[hls] nvenc probe ok via %s (probe_cuda=%s transcode_cuda=%s)",
                       variant, _hls_nvenc_probe_cuda, _hls_use_nvenc_cuda())
        elif mode == "qsv":
          _hls_qsv_hw_prefix = list(hw_prefix)
          logging.info("[hls] qsv probe ok via %s", variant)
        _hls_runtime_probe_last_errors.pop(mode, None)
        _hls_runtime_probe_attempt_errors.pop(mode, None)
        return True
      last_err = (proc.stderr or b"").decode("utf-8", errors="ignore")
      attempt_errors[variant] = last_err[-600:]
    except Exception as e:
      last_err = str(e)
      attempt_errors[variant] = last_err
  if attempt_errors:
    _hls_runtime_probe_attempt_errors[mode] = attempt_errors
  if last_err:
    _hls_runtime_probe_last_errors[mode] = last_err
  if _hls_hardware_encoder_error(last_err):
    _hls_disable_mode(mode, last_err)
  return False

def _hls_runtime_probe_vaapi() -> bool:
  dev = HLS_QSV_DEVICE
  driver = os.getenv("LIBVA_DRIVER_NAME", "iHD")
  if not dev or not os.path.exists(dev):
    return False
  cmd = [
    "ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
    "-init_hw_device", f"vaapi=va:{dev},driver={driver}",
    "-filter_hw_device", "va",
    "-f", "lavfi", "-i", f"testsrc=size={HLS_HW_PROBE_SIZE}:rate=1",
    "-frames:v", "1", "-an",
    "-vf", "format=nv12,hwupload",
    "-c:v", "h264_vaapi", "-qp", "24",
    "-f", "null", "-",
  ]
  try:
    proc = subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=15)
    if proc.returncode == 0:
      _hls_runtime_probe_last_errors.pop("vaapi", None)
      return True
    err = (proc.stderr or b"").decode("utf-8", errors="ignore")
    _hls_runtime_probe_last_errors["vaapi"] = err
    _hls_runtime_probe_attempt_errors["vaapi"] = {"vaapi": err[-600:]}
    return False
  except Exception as e:
    _hls_runtime_probe_last_errors["vaapi"] = str(e)
    return False

def _hls_runtime_probe_cmd(mode: str, variant: str, hw_prefix: list[str] | None = None) -> list[str]:
  encoder = "h264_nvenc" if mode == "nvenc" else "h264_qsv"
  cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-y"]
  prefix = list(hw_prefix or [])
  input_args = [
    "-f", "lavfi", "-i", f"testsrc=size={HLS_HW_PROBE_SIZE}:rate=1",
    "-frames:v", "1", "-an",
  ]
  if mode == "qsv":
    cmd += prefix
    if variant == "legacy-qsv":
      cmd += input_args + ["-pix_fmt", "nv12", "-c:v", encoder]
    else:
      cmd += input_args + ["-vf", "format=nv12,hwupload=extra_hw_frames=64", "-c:v", encoder]
  elif mode == "nvenc" and variant == "cuda":
    cmd += prefix + input_args + [
      "-vf", "format=nv12,hwupload=extra_hw_frames=64",
      "-c:v", encoder,
    ]
  else:
    cmd += prefix + input_args + ["-pix_fmt", "yuv420p", "-c:v", encoder]
    if mode == "nvenc" and variant == "plain":
      cmd += ["-gpu", "0"]
  cmd += ["-f", "null", "-"]
  return cmd

def _hls_preview_scale_dims(src_path: str) -> tuple[int, int]:
  """preview 缩放目标尺寸：保持宽高比、偶数、≤ 配置上限，且不放大。

  scale_qsv 这版不支持 force_original_aspect_ratio、scale_cuda 配 format 又会触发
  格式转换错误，所以这里在 Python 里算好定宽高，直接喂给硬件 scaler（最兼容）。
  """
  info = _probe_hls_codecs(src_path)
  try:
    sw = int(info.get("width") or 0)
    sh = int(info.get("height") or 0)
  except Exception:
    sw = sh = 0
  maxw, maxh = HLS_PREVIEW_MAX_WIDTH, HLS_PREVIEW_MAX_HEIGHT
  if sw <= 0 or sh <= 0:
    return maxw, maxh
  scale = min(maxw / sw, maxh / sh, 1.0)
  tw = max(2, (int(round(sw * scale)) // 2) * 2)
  th = max(2, (int(round(sh * scale)) // 2) * 2)
  return tw, th

def _hls_video_filter_chain(mode: str, pix_fmt: str, tier: str = "full", src_path: str = "") -> list[str]:
  preview = _hls_is_preview_tier(tier)
  is_hw = mode in {"nvenc", "qsv", "vaapi"} and not (mode == "nvenc" and not _hls_use_nvenc_cuda())
  if is_hw:
    # GPU 解码帧在显存里，缩放必须用对应硬件 scaler，且只传定宽高（不用 force_original_aspect_ratio
    # / format / 表达式 —— 部分 jellyfin-ffmpeg 版本不支持，会直接 Option not found 或格式转换失败）。
    # 全屏不缩放：不加 -vf，编码器直接吃 GPU 帧（8bit/10bit 由 nvenc/qsv 内部处理）。
    if not preview:
      return []
    tw, th = _hls_preview_scale_dims(src_path) if src_path else (HLS_PREVIEW_MAX_WIDTH, HLS_PREVIEW_MAX_HEIGHT)
    if mode == "qsv":
      return ["-vf", f"scale_qsv=w={tw}:h={th}:format=nv12"]
    if mode == "vaapi":
      return ["-vf", f"scale_vaapi=w={tw}:h={th}:format=nv12"]
    return ["-vf", f"scale_cuda={tw}:{th}"]  # nvenc/cuda：不带 format，nvenc 直接编码 cuda 帧
  # 软件编码（libx264 / nvenc 无 cuda）：系统内存帧，CPU 滤镜可用全功能语法
  w, h = HLS_PREVIEW_MAX_WIDTH, HLS_PREVIEW_MAX_HEIGHT
  chain = ""
  if preview:
    chain = f"scale='min(iw,{w})':'min(ih,{h})':force_original_aspect_ratio=decrease,"
  chain += "setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709"
  chain += f",format={pix_fmt}"
  return ["-vf", chain]

def _hls_color_out_args(mode: str) -> list[str]:
  """硬件转码路径用输出参数打 bt709 色彩标签（替代会破坏 GPU 帧的 setparams 滤镜）。"""
  if mode in {"nvenc", "qsv", "vaapi"}:
    return ["-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709"]
  return []

def _hls_bootstrap_hw_state():
  if HLS_HW_PROBE_RESET:
    with _hls_disabled_modes_guard:
      _hls_disabled_modes.clear()
    _hls_encoder_probe_cache.clear()
    global _hls_qsv_hw_prefix
    _hls_qsv_hw_prefix = []
    try:
      os.remove(_HLS_HW_STATE_PATH)
      logging.info("[hls] hardware encoder state reset (HLS_HW_PROBE_RESET=1)")
    except FileNotFoundError:
      pass
    except OSError as e:
      logging.warning("[hls] hw probe reset failed: %s", e)
    return
  _hls_load_hw_encoder_state()
  with _hls_disabled_modes_guard:
    stale = sorted(_hls_disabled_modes)
  if stale:
    recovered: list[str] = []
    for mode in stale:
      with _hls_disabled_modes_guard:
        _hls_disabled_modes.discard(mode)
      _hls_encoder_probe_cache.pop(mode, None)
      if _hls_encoder_available(mode):
        recovered.append(mode)
    if recovered:
      logging.info("[hls] recovered hw modes from stale state file: %s", recovered)
      _hls_save_hw_encoder_state()
    elif stale:
      logging.warning(
        "[hls] disabled_modes=%s still failing; delete %s or set HLS_HW_PROBE_RESET=1",
        stale, _HLS_HW_STATE_PATH,
      )

def _hls_gpu_diag() -> dict:
  qsv_dev = HLS_QSV_DEVICE
  out = {
    "ffmpeg_version": _hls_ffmpeg_version(),
    "qsv_device": qsv_dev,
    "qsv_device_exists": bool(qsv_dev and os.path.exists(qsv_dev)),
    "nvenc_cuda": _hls_use_nvenc_cuda(),
    "nvenc_probe_cuda": _hls_nvenc_probe_cuda,
    "nvenc_env_cuda": _hls_nvenc_env_cuda,
    "hw_encode_max": HLS_NVENC_MAX + HLS_INTEL_MAX,
    "hw_encode_max_preview": HLS_NVENC_MAX_PREVIEW + HLS_INTEL_MAX_PREVIEW,
    "preview_concurrent_max": _hls_hw_concurrent_max("preview"),
    "full_concurrent_max": _hls_hw_concurrent_max("full"),
    "hw_slots_dynamic": HLS_HW_SLOTS_DYNAMIC,
    "nvenc_slots": _hls_nvenc_pool.stats("preview"),
    "intel_slots": _hls_intel_pool.stats("preview"),
    "nvenc_max": HLS_NVENC_MAX,
    "intel_max": HLS_INTEL_MAX,
    "nvenc_max_preview": HLS_NVENC_MAX_PREVIEW,
    "intel_max_preview": HLS_INTEL_MAX_PREVIEW,
    "prefer_gpu": HLS_PREFER_GPU,
    "dual_gpu": _hls_dual_gpu_enabled(),
    "available_hw_modes": _hls_available_hw_modes(),
    "running_jobs": _hls_running_jobs_summary(),
    "disabled_modes": sorted(_hls_disabled_modes),
    "probe_cache": dict(_hls_encoder_probe_cache),
    "hw_state_path": _HLS_HW_STATE_PATH,
  }
  try:
    proc = subprocess.run(
      ["vainfo"],
      stdout=subprocess.PIPE,
      stderr=subprocess.STDOUT,
      timeout=8,
      text=True,
    )
    out["vainfo_rc"] = proc.returncode
    out["vainfo"] = (proc.stdout or "")[-2000:]
  except Exception as e:
    out["vainfo_error"] = str(e)
  try:
    proc = subprocess.run(
      ["nvidia-smi", "-L"],
      stdout=subprocess.PIPE,
      stderr=subprocess.STDOUT,
      timeout=5,
      text=True,
    )
    out["nvidia_smi_rc"] = proc.returncode
    out["nvidia_smi"] = (proc.stdout or "").strip()[:500]
  except Exception as e:
    out["nvidia_smi_error"] = str(e)
  try:
    out["nvidia_devices"] = sorted(
      n for n in os.listdir("/dev") if n.startswith("nvidia") or n == "nvidiactl"
    )
  except Exception as e:
    out["nvidia_devices_error"] = str(e)
  out["nvidia_driver_capabilities"] = os.getenv("NVIDIA_DRIVER_CAPABILITIES", "")
  if out.get("nvidia_smi_rc") == 0 and not any("uvm" in str(d) for d in (out.get("nvidia_devices") or [])):
    out["nvidia_hint"] = (
      "nvidia-smi 可用但可能未挂载 video 编码设备；"
      "请在 docker run / 群晖创建容器时设置 "
      "NVIDIA_DRIVER_CAPABILITIES=compute,video,utility（runtime.env 太晚无效）"
    )
  for mode in ("nvenc", "qsv", "vaapi"):
    try:
      ok = _hls_encoder_available(mode) if not _hls_mode_disabled(mode) else False
      out[f"{mode}_available"] = ok
      if not ok:
        err = _hls_runtime_probe_last_errors.get(mode, "")
        if err:
          out[f"{mode}_probe_error"] = err[-800:]
        attempts = _hls_runtime_probe_attempt_errors.get(mode)
        if attempts:
          out[f"{mode}_probe_attempts"] = attempts
    except Exception as e:
      out[f"{mode}_available"] = False
      out[f"{mode}_error"] = str(e)
  return out

def _hls_ffmpeg_version() -> str:
  try:
    proc = subprocess.run(
      ["ffmpeg", "-hide_banner", "-version"],
      stdout=subprocess.PIPE,
      stderr=subprocess.DEVNULL,
      timeout=5,
      text=True,
    )
    line = (proc.stdout or "").splitlines()[0] if proc.stdout else ""
    return line.strip()
  except Exception:
    return ""

def _hls_log_startup_gpu_probe():
  try:
    ver = _hls_ffmpeg_version()
    if ver:
      logging.info("[hls] %s", ver)
    diag = _hls_gpu_diag()
    logging.info(
      "[hls] gpu probe: nvenc=%s qsv=%s vaapi=%s disabled=%s qsv_dev=%s",
      diag.get("nvenc_available"),
      diag.get("qsv_available"),
      diag.get("vaapi_available"),
      diag.get("disabled_modes"),
      diag.get("qsv_device"),
    )
    if diag.get("disabled_modes"):
      logging.info("[hls] tip: delete %s or set HLS_HW_PROBE_RESET=1 after fixing GPU", _HLS_HW_STATE_PATH)
  except Exception as e:
    logging.warning("[hls] startup gpu probe failed: %s", e)

def _hls_copy_block_key(src_path: str) -> str:
  return _hls_source_version(src_path)

def _hls_copy_blocked_for_source(src_path: str) -> bool:
  with _hls_copy_blocked_guard:
    return _hls_copy_block_key(src_path) in _hls_copy_blocked_sources

def _hls_copy_block_reason(src_path: str) -> str:
  with _hls_copy_blocked_guard:
    return _hls_copy_blocked_sources.get(_hls_copy_block_key(src_path), "")

def _hls_block_copy_for_source(src_path: str, reason: str):
  key = _hls_copy_block_key(src_path)
  with _hls_copy_blocked_guard:
    _hls_copy_blocked_sources[key] = reason
  logging.warning("[hls] disable copy for source=%s: %s", src_path, reason)

def _hls_encoder_available(mode: str) -> bool:
  if mode not in {"nvenc", "qsv", "vaapi"}:
    return True
  if _hls_mode_disabled(mode):
    return False
  cached = _hls_encoder_probe_cache.get(mode)
  if cached is not None:
    return cached
  encoder = {"nvenc": "h264_nvenc", "qsv": "h264_qsv", "vaapi": "h264_vaapi"}[mode]
  try:
    proc = subprocess.run(
      ["ffmpeg", "-hide_banner", "-loglevel", "error", "-h", f"encoder={encoder}"],
      stdout=subprocess.PIPE,
      stderr=subprocess.PIPE,
      timeout=5,
    )
    if proc.returncode != 0:
      err = (proc.stderr or proc.stdout or b"").decode("utf-8", errors="ignore")[-500:]
      _hls_encoder_probe_cache[mode] = False
      _hls_disable_mode(mode, f"encoder unavailable: {encoder} {err}")
      return False
  except Exception as e:
    _hls_encoder_probe_cache[mode] = False
    _hls_disable_mode(mode, str(e))
    return False
  if mode == "vaapi":
    ok = _hls_runtime_probe_vaapi()
  else:
    ok = _hls_runtime_probe_encoder(mode)
  _hls_encoder_probe_cache[mode] = ok
  if ok:
    _hls_save_hw_encoder_state()
  elif not _hls_mode_disabled(mode):
    logging.warning("[hls] %s runtime probe failed (not disabled); check GPU mount", mode)
  return ok

def _hls_meta_path(out_dir: str) -> str:
  return os.path.join(out_dir, "meta.json")

def _hls_source_stat(src_path: str) -> tuple[int, int]:
  st = os.stat(src_path)
  return int(st.st_mtime), int(st.st_size)

def _hls_cache_matches(out_dir: str, src_path: str, tier: str = "full") -> bool:
  try:
    with open(_hls_meta_path(out_dir), "r", encoding="utf-8") as f:
      meta = json.load(f)
    mtime, size = _hls_source_stat(src_path)
    first_seg = _hls_segment_path(out_dir, 0)
    if os.path.isfile(first_seg) and os.path.getsize(first_seg) > HLS_MAX_REASONABLE_SEGMENT_BYTES:
      logging.warning("[hls] invalidate oversized segment cache: %s size=%s", first_seg, os.path.getsize(first_seg))
      return False
    return (
      meta.get("pipeline_version") == _hls_pipeline_version(tier)
      and int(meta.get("source_mtime") or 0) == mtime
      and int(meta.get("source_size") or 0) == size
    )
  except Exception:
    return False

def _hls_cache_complete(out_dir: str, src_path: str) -> bool:
  """后台连续 HLS 生成是否已经完整结束。"""
  if not _hls_cache_matches(out_dir, src_path):
    return False
  pl = os.path.join(out_dir, "playlist.m3u8")
  if not os.path.isfile(pl):
    return False
  try:
    with open(pl, "rb") as f:
      f.seek(max(0, os.path.getsize(pl) - 512))
      return b"#EXT-X-ENDLIST" in f.read()
  except Exception:
    return False

_hls_probe_cache: dict[tuple[str, int, int], dict] = {}
def _probe_hls_codecs(src_path: str) -> dict:
  """探测 HLS copy 是否能被浏览器/HLS.js 稳定解析。"""
  try:
    st = os.stat(src_path)
    key = (os.path.abspath(src_path), int(st.st_mtime), int(st.st_size))
  except Exception:
    return {"video": "", "audio": "", "pix_fmt": "", "ok": False}
  cached = _hls_probe_cache.get(key)
  if cached:
    return cached
  info = {"video": "", "audio": "", "pix_fmt": "", "duration": 0.0, "ok": False}
  try:
    p = subprocess.run(
      [
        "ffprobe", "-v", "error",
        "-show_entries", "stream=index,codec_type,codec_name,pix_fmt,width,height,duration,avg_frame_rate,r_frame_rate,color_space,color_transfer,color_primaries:format=duration",
        "-of", "json",
        src_path,
      ],
      stdout=subprocess.PIPE,
      stderr=subprocess.PIPE,
      text=True,
      timeout=10,
    )
    data = json.loads(p.stdout or "{}")
    format_duration = 0.0
    video_duration = 0.0
    audio_duration = 0.0
    try:
      format_duration = float((data.get("format") or {}).get("duration") or 0)
    except Exception:
      pass
    for s in (data.get("streams") or []):
      typ = (s.get("codec_type") or "").lower()
      try:
        d = float(s.get("duration") or 0)
      except Exception:
        d = 0.0
      if typ == "video" and d > 0 and video_duration <= 0:
        video_duration = d
      elif typ == "audio" and d > 0 and audio_duration <= 0:
        audio_duration = d
      if typ == "video" and not info["video"]:
        info["video"] = (s.get("codec_name") or "").lower()
        info["pix_fmt"] = (s.get("pix_fmt") or "").lower()
        try:
          info["width"] = int(s.get("width") or 0)
          info["height"] = int(s.get("height") or 0)
        except Exception:
          info["width"] = info["height"] = 0
        info["color_space"] = (s.get("color_space") or "").lower()
        info["color_transfer"] = (s.get("color_transfer") or "").lower()
        info["color_primaries"] = (s.get("color_primaries") or "").lower()
        for rate_key in ("avg_frame_rate", "r_frame_rate"):
          rate = (s.get(rate_key) or "").strip()
          if "/" in rate:
            try:
              n, d = rate.split("/", 1)
              fps = float(n) / max(1.0, float(d))
              if fps > 0:
                info["fps"] = fps
                break
            except Exception:
              pass
      elif typ == "audio" and not info["audio"]:
        info["audio"] = (s.get("codec_name") or "").lower()
    # Media-library style runtime: prefer the primary video stream, then container,
    # then audio. This avoids long audio/container tails stretching the player UI
    # past the point where video can actually continue.
    info["duration"] = max(0.0, video_duration or format_duration or audio_duration)
    info["format_duration"] = max(0.0, format_duration)
    info["video_duration"] = max(0.0, video_duration)
    info["audio_duration"] = max(0.0, audio_duration)
  except Exception as e:
    logging.warning("[hls] ffprobe failed for %s: %s", src_path, e)
  info["ok"] = True
  _hls_probe_cache[key] = info
  return info

def _probe_media_duration_fallback(src_path: str) -> float:
  """ffprobe 个别文件读不到 format.duration 时，用 ffmpeg stderr 的 Duration 兜底。"""
  try:
    p = subprocess.run(
      ["ffmpeg", "-hide_banner", "-i", src_path],
      stdout=subprocess.PIPE,
      stderr=subprocess.PIPE,
      text=True,
      timeout=10,
    )
    txt = (p.stderr or "") + "\n" + (p.stdout or "")
    m = re.search(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)", txt)
    if not m:
      return 0.0
    hh, mm, ss = int(m.group(1)), int(m.group(2)), float(m.group(3))
    return max(0.0, hh * 3600 + mm * 60 + ss)
  except Exception:
    return 0.0

def _hls_source_size(src_path: str) -> int:
  try:
    return int(os.path.getsize(src_path))
  except Exception:
    return 0

def _hls_estimated_bitrate_bps(src_path: str) -> float:
  try:
    dur = float((_probe_hls_codecs(src_path).get("duration") or 0))
    if dur <= 0:
      dur = _probe_media_duration_fallback(src_path)
    size = _hls_source_size(src_path)
    if dur > 0 and size > 0:
      return (size * 8.0) / dur
  except Exception:
    pass
  return 0.0

def _hls_copy_risky_for_browser(src_path: str) -> bool:
  """高码率/超大 H.264 copy 可能因长 GOP 生成 GB 级首段，直接压垮 HLS.js。"""
  size = _hls_source_size(src_path)
  if size and size >= HLS_COPY_MAX_SOURCE_BYTES:
    return True
  bitrate = _hls_estimated_bitrate_bps(src_path)
  return bool(bitrate and bitrate >= HLS_COPY_MAX_BITRATE_BPS)

def _hls_can_copy_for_browser(src_path: str) -> bool:
  """只允许 HLS.js/Chrome 稳定支持的编码走 -c copy。

  ffmpeg 能把不少编码写进 HLS/TS，但 HLS.js 不一定能解析/喂给 MSE。
  对 HEVC/VP9/AV1/Opus/Vorbis/AC3/10bit H.264 等直接转 H.264/AAC。
  """
  info = _probe_hls_codecs(src_path)
  video = info.get("video") or ""
  audio = info.get("audio") or ""
  pix_fmt = info.get("pix_fmt") or ""
  if video != "h264":
    return False
  if pix_fmt and pix_fmt not in {"yuv420p", "nv12"}:
    return False
  if audio and audio not in {"aac", "mp3"}:
    return False
  return True

def _hls_needs_h264_metadata_fix(src_path: str) -> bool:
  info = _probe_hls_codecs(src_path)
  if (info.get("video") or "") != "h264":
    return False
  bad = {"", "unknown", "reserved", "unspecified"}
  return (
    (info.get("color_space") or "") in bad
    or (info.get("color_transfer") or "") in bad
    or (info.get("color_primaries") or "") in bad
  )

def _hls_is_ready(out_dir: str, src_path: str | None = None) -> bool:
  pl = os.path.join(out_dir, "playlist.m3u8")
  if not os.path.isfile(pl):
    return False
  # 源文件比缓存新（被修复/替换了）→ 失效
  if src_path and os.path.isfile(src_path):
    try:
      if os.path.getmtime(src_path) > os.path.getmtime(pl):
        return False
    except Exception:
      pass
    # 旧版本可能已经把 HEVC/VP9/奇怪音频 copy 成 TS，ffmpeg 成功但 HLS.js 会 fragParsingError。
    # 如果源不适合 copy，而缓存缺少 meta 或 meta 记录为 copy，就强制重切为转码版。
    if not _hls_can_copy_for_browser(src_path):
      try:
        with open(_hls_meta_path(out_dir), "r", encoding="utf-8") as f:
          meta = json.load(f)
        if (meta.get("mode") or "") in {"copy", "copyfix"}:
          return False
      except Exception:
        return False
  # 完成的 playlist 末尾会有 #EXT-X-ENDLIST
  try:
    with open(pl, "rb") as f:
      f.seek(max(0, os.path.getsize(pl) - 256))
      tail = f.read().decode("utf-8", errors="ignore")
      return "#EXT-X-ENDLIST" in tail
  except Exception:
    return False

def _hls_base_muxer_args(seg_pat: str, playlist: str, start_number: int = 0) -> list[str]:
  return [
    "-f", "hls",
    "-max_delay", "5000000",
    "-hls_time", str(HLS_SEGMENT_SEC),
    "-hls_list_size", "0",
    "-hls_segment_type", "mpegts",
    "-hls_playlist_type", "vod",
    "-start_number", str(max(0, int(start_number))),
    # temp_file：先写 .tmp，完成后 rename，避免后端把半成品 ts 发给浏览器。
    "-hls_flags", "independent_segments+temp_file",
    "-hls_segment_filename", seg_pat,
    playlist,
  ]

def _hls_keyframe_args(src_path: str, mode: str, start_number: int = 0) -> list[str]:
  info = _probe_hls_codecs(src_path)
  try:
    fps = float(info.get("fps") or 0)
  except Exception:
    fps = 0.0
  if fps <= 0:
    fps = 30.0
  seg = max(1, int(HLS_SEGMENT_SEC))
  gop = max(1, int(math.ceil(seg * fps)))
  keyframes = [
    "-force_key_frames:0", f"expr:gte(t,{max(0, int(start_number)) * seg}+n_forced*{seg})",
  ]
  gop_args = [
    "-g:v:0", str(gop),
    "-keyint_min:v:0", str(gop),
    "-sc_threshold:v:0", "0",
  ]
  if mode in {"nvenc", "qsv", "vaapi"}:
    return gop_args
  if mode == "libx264":
    # 与 Jellyfin 的 HLS 转码策略一致：libx264 用强制关键帧，并关闭场景切换关键帧干扰。
    return keyframes + ["-sc_threshold:v:0", "0"]
  return keyframes + gop_args

def _hls_color_normalize_filter(pix_fmt: str = "yuv420p", mode: str = "", tier: str = "full", src_path: str = "") -> list[str]:
  return _hls_video_filter_chain(mode, pix_fmt, tier, src_path)

def _hls_cmd_for_mode(mode: str, src_path: str, seg_pat: str, playlist: str, start_number: int = 0, start_time: float = 0.0, tier: str = "full") -> list[str]:
  """生成单个连续 HLS job 的 ffmpeg 命令。"""
  preview = _hls_is_preview_tier(tier)
  audio_br = HLS_PREVIEW_AUDIO_BITRATE if preview else "192k"
  muxer = _hls_base_muxer_args(seg_pat, playlist, start_number)
  keyframes = _hls_keyframe_args(src_path, mode, start_number)
  base = ["ffmpeg", "-nostdin", "-loglevel", "error", "-y"]
  base += _hls_ffmpeg_hw_prefix(mode)
  if mode == "nvenc" and _hls_use_nvenc_cuda():
    base += ["-hwaccel", "cuda", "-hwaccel_output_format", "cuda"]
  elif mode == "qsv":
    base += ["-hwaccel", "qsv", "-hwaccel_output_format", "qsv"]
  elif mode == "vaapi":
    dev = HLS_QSV_DEVICE
    if dev and os.path.exists(dev):
      base += ["-hwaccel", "vaapi", "-hwaccel_device", dev, "-hwaccel_output_format", "vaapi"]
  if start_time > 0:
    base += ["-ss", f"{max(0.0, start_time):.3f}"]
  base += [
    "-i", src_path,
    "-map_metadata", "-1",
    "-map_chapters", "-1",
    "-map", "0:v:0?",
    "-map", "0:a:0?",
  ]
  is_copy = mode in {"copy", "copyfix"}
  # copyts/start_at_zero 仅用于 copy（保段间连续）和 seek 续接；从头转码用它们时，
  # 若源起始 PTS 偏大或音视频起点错位，HLS 切片器会一直等对齐导致 seg0 永不产出。
  # 从头转码改用默认时间戳归零，seg0 立即可切。
  if is_copy or start_time > 0:
    base += ["-copyts", "-avoid_negative_ts", "disabled", "-start_at_zero"]
  else:
    base += ["-avoid_negative_ts", "make_zero"]
  base += ["-max_muxing_queue_size", "1024"]
  if mode == "copy":
    # 纯 remux，秒切、零 GPU；只在探测为浏览器可播时进入 copy。
    return base + ["-c", "copy"] + muxer
  if mode == "copyfix":
    return base + [
      "-c", "copy",
      "-bsf:v", "h264_metadata=colour_primaries=1:transfer_characteristics=1:matrix_coefficients=1",
    ] + muxer
  if mode == "nvenc":
    cq = "28" if preview else "24"
    enc = ["-c:v", "h264_nvenc", "-preset", "p1", "-tune", "ll",
           "-rc", "vbr", "-cq", cq, "-b:v", "0"]
    if preview:
      enc += ["-maxrate", "3M", "-bufsize", "6M"]
    if not _hls_use_nvenc_cuda():
      enc += ["-gpu", "0"]
    return base + enc + keyframes + _hls_color_normalize_filter("yuv420p", mode, tier, src_path) + _hls_color_out_args(mode) + [
      "-c:a", "aac", "-b:a", audio_br,
    ] + muxer
  if mode == "qsv":
    gq = "28" if preview else "22"
    return base + [
      "-c:v", "h264_qsv", "-preset", "medium", "-global_quality", gq,
      *keyframes,
      *_hls_color_normalize_filter("nv12", mode, tier, src_path),
      *_hls_color_out_args(mode),
      "-c:a", "aac", "-b:a", audio_br,
    ] + muxer
  if mode == "vaapi":
    qp = "28" if preview else "24"
    return base + [
      "-c:v", "h264_vaapi", "-qp", qp,
      *keyframes,
      *_hls_color_normalize_filter("nv12", "vaapi", tier, src_path),
      *_hls_color_out_args("vaapi"),
      "-c:a", "aac", "-b:a", audio_br,
    ] + muxer
  crf = "26" if preview else "22"
  x264 = ["-c:v", "libx264", "-preset", "veryfast", "-crf", crf]
  if preview:
    x264 += ["-maxrate", "3M", "-bufsize", "6M"]
  return base + x264 + keyframes + _hls_color_normalize_filter("yuv420p", "libx264", tier, src_path) + [
    "-c:a", "aac", "-b:a", audio_br,
  ] + muxer

def _hls_attempt_chain() -> list[str]:
  """根据 HLS_TRANSCODE_FALLBACK 决定 -c copy 失败后的尝试顺序。"""
  if HLS_TRANSCODE_FALLBACK == "none":
    return ["copy"]
  prefix = ["copy"] if HLS_ALLOW_COPY else []
  if HLS_TRANSCODE_FALLBACK == "nvenc":
    return prefix + ["nvenc"]
  if HLS_TRANSCODE_FALLBACK == "qsv":
    return prefix + ["qsv"]
  if HLS_TRANSCODE_FALLBACK == "libx264":
    return prefix + ["libx264"]
  # auto：默认 nvenc → qsv → vaapi → libx264；显式 HLS_ALLOW_COPY=1 时才先 copy
  return prefix + ["nvenc", "qsv", "vaapi", "libx264"]

def _hls_attempt_chain_for_source(src_path: str, tier: str = "full", vid_id: str | None = None) -> list[str]:
  attempts = _hls_attempt_chain()
  if _hls_is_preview_tier(tier):
    attempts = [x for x in attempts if x not in {"copy", "copyfix"}]
  copy_blocked = _hls_copy_blocked_for_source(src_path)
  if HLS_ALLOW_COPY and not copy_blocked and _hls_can_copy_for_browser(src_path) and _hls_needs_h264_metadata_fix(src_path):
    attempts = ["copyfix"] + [x for x in attempts if x != "copy"]
  if copy_blocked:
    attempts = [x for x in attempts if x not in {"copy", "copyfix"}]
  # 全屏(full)：浏览器可播的 H.264/AAC 一律优先 copy（只切片、不转码、不占 GPU），
  # 即使码率/体积大；万一某段 copy 出来超大，由 _hls_segment_oversized 自动回退转码。
  # preview 顶上已剔除 copy（必须降分辨率），这里的 copy_risky 仅在“非 full 或不可 copy”时才剔。
  if _hls_copy_risky_for_browser(src_path) and not (
    not _hls_is_preview_tier(tier) and _hls_can_copy_for_browser(src_path)
  ):
    attempts = [x for x in attempts if x not in {"copy", "copyfix"}]
  if ("copy" in attempts or "copyfix" in attempts) and not _hls_can_copy_for_browser(src_path):
    if HLS_TRANSCODE_FALLBACK != "none":
      attempts = [x for x in attempts if x not in {"copy", "copyfix"}]

  copy_prefix = [x for x in attempts if x in {"copy", "copyfix"}]
  hw_modes = _hls_available_hw_modes()
  if hw_modes:
    primary = _hls_pick_hw_mode(vid_id)
    if primary and primary in hw_modes:
      hw_chain = [primary] + [m for m in hw_modes if m != primary]
    else:
      hw_chain = list(hw_modes)
    # NVDEC 对 H.264 不保证 >1080p（4K H.264 常解码空转）。高分辨率 H.264 优先走
    # Intel QSV 解码（4K H.264 没问题），nvenc 退到后面；HEVC/4K 等 NVDEC 原生支持不受影响。
    info = _probe_hls_codecs(src_path)
    if (info.get("video") or "") == "h264" and int(info.get("height") or 0) > 1080:
      intel = next((m for m in hw_chain if m in {"qsv", "vaapi"}), None)
      if intel:
        hw_chain = [intel] + [m for m in hw_chain if m != intel]
    attempts = copy_prefix + hw_chain
  else:
    attempts = [x for x in attempts if x in {"copy", "copyfix"} or not _hls_is_hw_mode(x)]

  attempts = [x for x in attempts if not _hls_mode_disabled(x)]
  validated: list[str] = []
  for x in attempts:
    if x in {"copy", "copyfix", "libx264"}:
      validated.append(x)
    elif _hls_is_hw_mode(x):
      if _hls_encoder_available(x):
        validated.append(x)
    else:
      validated.append(x)
  attempts = validated

  if HLS_PREFER_GPU and hw_modes:
    attempts = [x for x in attempts if x != "libx264"]
  elif not attempts and HLS_TRANSCODE_FALLBACK != "none":
    if hw_modes and HLS_PREFER_GPU:
      attempts = list(hw_modes)
    else:
      attempts = ["libx264"]
  # preview：链尾保留 libx264 软解兜底。GPU 硬解可能对某些源空转（如 NVDEC 啃不动
  # 4K H.264），硬件模式全卡死时用 CPU 解码+编码保证至少能出预览（前面的硬件模式
  # 仍优先，只有它们 0 段被判定卡死后才会走到这里）。
  if (
    _hls_is_preview_tier(tier)
    and hw_modes
    and HLS_TRANSCODE_FALLBACK != "none"
    and not _hls_mode_disabled("libx264")
    and "libx264" not in attempts
  ):
    attempts = attempts + ["libx264"]
  if "libx264" in attempts and hw_modes and not _hls_is_preview_tier(tier):
    logging.warning("[hls] libx264 fallback while GPU available modes=%s (check %s)", hw_modes, _HLS_HW_STATE_PATH)
  return attempts

def _write_hls_meta(out_dir: str, src_path: str, mode: str, tier: str = "full"):
  try:
    st = os.stat(src_path)
    meta = {
      "mode": mode,
      "tier": _hls_norm_tier(tier),
      "pipeline_version": _hls_pipeline_version(tier),
      "source_mtime": int(st.st_mtime),
      "source_size": int(st.st_size),
      "codecs": _probe_hls_codecs(src_path),
      "created_at": int(time.time()),
    }
    with open(_hls_meta_path(out_dir), "w", encoding="utf-8") as f:
      json.dump(meta, f, ensure_ascii=False, indent=2)
  except Exception as e:
    logging.warning("[hls] write meta failed: %s", e)

def _hls_discontinuity_path(out_dir: str) -> str:
  return os.path.join(out_dir, "discontinuities.json")

def _hls_read_discontinuities(out_dir: str) -> set[int]:
  try:
    data = _read_json(_hls_discontinuity_path(out_dir))
    return {
      int(x)
      for x in (data.get("indexes") or [])
      if int(x) > 0
    }
  except Exception:
    return set()

def _hls_mark_discontinuity(out_dir: str, idx: int):
  if idx <= 0:
    return
  try:
    indexes = _hls_read_discontinuities(out_dir)
    if idx in indexes:
      return
    indexes.add(int(idx))
    _write_json_atomic(_hls_discontinuity_path(out_dir), {
      "indexes": sorted(indexes),
      "updated_at": int(time.time()),
    })
    logging.info("[hls] marked discontinuity at segment %s in %s", idx, out_dir)
  except Exception as e:
    logging.warning("[hls] failed to mark discontinuity: %s", e)

def _stamp_hls_playlist(playlist: str, src_path: str):
  """给 segment URL 加源文件版本，避开浏览器/HLS.js 对旧坏段的缓存。"""
  try:
    ver = str(int(os.path.getmtime(src_path)))
    with open(playlist, "r", encoding="utf-8") as f:
      lines = f.read().splitlines()
    out = []
    changed = False
    for line in lines:
      s = line.strip()
      if s and not s.startswith("#") and "?" not in s:
        out.append(f"{line}?v={ver}")
        changed = True
      else:
        out.append(line)
    if changed:
      with open(playlist, "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(out) + "\n")
  except Exception as e:
    logging.warning("[hls] stamp playlist failed: %s", e)

def _hls_source_for_vid(vid_id: str) -> str:
  _, id_map, _ = _scan_state()
  v = id_map.get(vid_id)
  if not v:
    raise HTTPException(404)
  src_path = v.video_path
  cache_path = _get_video_cache_path_if_any(vid_id, src_path)
  resolved = cache_path or src_path
  if not resolved or not os.path.isfile(resolved):
    raise HTTPException(404, detail="video not found (may still be downloading)")
  return resolved

def _hls_duration_for(src_path: str) -> float:
  dur = float((_probe_hls_codecs(src_path).get("duration") or 0))
  if dur <= 0:
    dur = _probe_media_duration_fallback(src_path)
  if dur > 0:
    return dur
  logging.warning("[hls] cannot determine duration for %s", src_path)
  raise HTTPException(500, "hls duration probe failed")

def _hls_source_version(src_path: str) -> str:
  try:
    st = os.stat(src_path)
    return f"{HLS_PIPELINE_VERSION}-{int(st.st_mtime)}-{int(st.st_size)}"
  except Exception:
    return str(int(time.time()))

def _hls_actual_playlist_durations(out_dir: str) -> dict[int, float]:
  """读取 ffmpeg 已生成 playlist 中的真实 EXTINF，避免 copy 模式时间轴和 MSE 实际 PTS 漂移。"""
  pl = os.path.join(out_dir, "playlist.m3u8")
  out: dict[int, float] = {}
  try:
    if not os.path.isfile(pl):
      return out
    pending: float | None = None
    with open(pl, "r", encoding="utf-8", errors="ignore") as f:
      for raw in f:
        line = raw.strip()
        if line.startswith("#EXTINF:"):
          try:
            pending = float(line.split(":", 1)[1].split(",", 1)[0])
          except Exception:
            pending = None
          continue
        if not line or line.startswith("#") or pending is None:
          continue
        m = re.search(r"seg_(\d{5,8})\.ts", line)
        if m:
          out[int(m.group(1))] = max(0.1, pending)
        pending = None
  except Exception as e:
    logging.warning("[hls] parse actual playlist durations failed: %s", e)
  return out

def _ensure_hls_dynamic_cache_dir(vid_id: str, src_path: str, tier: str = "full"):
  out_dir = _hls_dir_for(vid_id, tier)
  if os.path.isdir(out_dir) and not _hls_cache_matches(out_dir, src_path, tier):
    try:
      shutil.rmtree(out_dir)
    except Exception:
      pass
  os.makedirs(out_dir, exist_ok=True)
  if not _hls_cache_matches(out_dir, src_path, tier):
    _write_hls_meta(out_dir, src_path, "dynamic", tier)
    try:
      _write_json_atomic(_hls_discontinuity_path(out_dir), {"indexes": [], "updated_at": int(time.time())})
    except Exception:
      pass
  return out_dir

def _hls_dynamic_playlist(vid_id: str, src_path: str, tier: str = "full") -> str:
  """立即返回 VOD playlist；segment 在请求时按需生成并缓存。"""
  out_dir = _ensure_hls_dynamic_cache_dir(vid_id, src_path, tier)
  dur = _hls_duration_for(src_path)
  seg = max(1, int(HLS_SEGMENT_SEC))
  count = max(1, int(math.ceil(dur / seg)))
  ver = _hls_source_version(src_path)
  actual_durs = _hls_actual_playlist_durations(out_dir)
  discontinuities = _hls_read_discontinuities(out_dir)
  max_seg_dur = max([float(seg), *actual_durs.values()], default=float(seg))
  lines = [
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    f"#EXT-X-TARGETDURATION:{max(1, int(math.ceil(max_seg_dur)))}",
    "#EXT-X-MEDIA-SEQUENCE:0",
    "#EXT-X-PLAYLIST-TYPE:VOD",
    "#EXT-X-INDEPENDENT-SEGMENTS",
  ]
  acc = 0.0
  for i in range(count):
    if i in actual_durs:
      seg_dur = actual_durs[i]
    else:
      remaining = max(0.1, dur - acc)
      seg_dur = max(0.1, min(seg, remaining)) if i == count - 1 else seg
    if i == count - 1:
      seg_dur = max(0.1, dur - acc)
    acc += seg_dur
    if i in discontinuities:
      lines.append("#EXT-X-DISCONTINUITY")
    lines.append(f"#EXTINF:{seg_dur:.3f},")
    lines.append(f"seg_{i:05d}.ts?v={ver}")
  lines.append("#EXT-X-ENDLIST")
  return "\n".join(lines) + "\n"

def _hls_job_key(vid_id: str, src_path: str, tier: str = "full") -> str:
  return f"{vid_id}:{_hls_norm_tier(tier)}:{_hls_source_version(src_path)}"

def _hls_job_for(key: str) -> dict | None:
  with _hls_jobs_guard:
    return _hls_jobs.get(key)

def _hls_forget_job(key: str):
  with _hls_jobs_guard:
    _hls_jobs.pop(key, None)

def _hls_segment_path(out_dir: str, idx: int) -> str:
  return os.path.join(out_dir, f"seg_{idx:05d}.ts")

def _hls_segment_oversized(seg_path: str) -> bool:
  try:
    return os.path.isfile(seg_path) and os.path.getsize(seg_path) > HLS_MAX_REASONABLE_SEGMENT_BYTES
  except Exception:
    return False

def _hls_reset_bad_copy_cache(key: str, vid_id: str, src_path: str, job: dict | None, seg_path: str, tier: str = "full"):
  try:
    size = os.path.getsize(seg_path) if os.path.isfile(seg_path) else 0
  except Exception:
    size = 0
  reason = f"oversized HLS segment {os.path.basename(seg_path)} size={size}"
  _hls_block_copy_for_source(src_path, reason)
  if job:
    _hls_kill_job(job)
  _hls_forget_job(key)
  out_dir = _hls_dir_for(vid_id, tier)
  try:
    if os.path.isdir(out_dir):
      shutil.rmtree(out_dir)
  except Exception as e:
    logging.warning("[hls] failed to remove bad copy cache for %s: %s", vid_id, e)
  os.makedirs(out_dir, exist_ok=True)
  _write_hls_meta(out_dir, src_path, "dynamic", tier)
  return reason

def _hls_existing_segment_indexes(out_dir: str) -> list[int]:
  try:
    out = []
    for fn in os.listdir(out_dir):
      m = re.fullmatch(r"seg_(\d{5,8})\.ts", fn)
      if m:
        out.append(int(m.group(1)))
    return sorted(out)
  except Exception:
    return []

def _hls_current_segment_index(out_dir: str) -> int | None:
  try:
    best_idx = None
    best_mtime = -1.0
    for fn in os.listdir(out_dir):
      m = re.fullmatch(r"seg_(\d{5,8})\.ts", fn)
      if not m:
        continue
      p = os.path.join(out_dir, fn)
      try:
        mt = os.path.getmtime(p)
      except Exception:
        continue
      if mt > best_mtime:
        best_mtime = mt
        best_idx = int(m.group(1))
    return best_idx
  except Exception:
    return None

def _hls_delete_last_transcoding_file(out_dir: str):
  try:
    latest = None
    latest_mtime = -1.0
    for fn in os.listdir(out_dir):
      if not re.fullmatch(r"seg_\d{5,8}\.ts(?:\.tmp)?", fn):
        continue
      path = os.path.join(out_dir, fn)
      try:
        mtime = os.path.getmtime(path)
      except Exception:
        continue
      if mtime > latest_mtime:
        latest_mtime = mtime
        latest = path
    if latest:
      try:
        os.remove(latest)
      except Exception:
        pass
  except Exception:
    pass

def _hls_clear_client_state(vid_id: str, tier: str = "full"):
  key = _hls_playhead_key(vid_id, tier)
  with _hls_playheads_guard:
    _hls_playheads.pop(key, None)
  with _hls_segment_demand_guard:
    _hls_segment_demand.pop(key, None)

def _hls_set_playhead(vid_id: str, position: float, tier: str = "full"):
  key = _hls_playhead_key(vid_id, tier)
  with _hls_playheads_guard:
    _hls_playheads[key] = (max(0.0, float(position)), time.time())

def _hls_get_playhead(vid_id: str, tier: str = "full") -> float:
  key = _hls_playhead_key(vid_id, tier)
  with _hls_playheads_guard:
    return float((_hls_playheads.get(key) or (0.0, 0.0))[0])

def _hls_note_segment_demand(vid_id: str, idx: int, tier: str = "full"):
  """记录客户端仍在拉取段 → 推断缓冲前沿，供 encode-ahead 节流使用。"""
  key = _hls_playhead_key(vid_id, tier)
  seg = max(1, int(HLS_SEGMENT_SEC))
  demand_sec = max(0.0, (int(idx) + 3) * seg)
  now = time.time()
  with _hls_segment_demand_guard:
    prev = float((_hls_segment_demand.get(key) or (0.0, 0.0))[0])
    _hls_segment_demand[key] = (max(prev, demand_sec), now)

def _hls_effective_playhead(vid_id: str, tier: str = "full") -> float:
  """取 progress 上报与段请求推断的较大值，避免后台窗口进度停更后 ffmpeg 被误杀。"""
  key = _hls_playhead_key(vid_id, tier)
  reported = _hls_get_playhead(vid_id, tier)
  now = time.time()
  with _hls_segment_demand_guard:
    demand, ts = _hls_segment_demand.get(key, (0.0, 0.0))
  if now - ts <= 180:
    return max(reported, max(0.0, demand - 90))
  return reported

def _hls_encoded_position_sec(out_dir: str, job: dict | None) -> float:
  return _hls_job_encoded_position_sec(out_dir, job)

def _hls_job_encoded_position_sec(out_dir: str, job: dict | None) -> float:
  """只统计当前 job 启动后新写的段，避免旧缓存导致误杀。"""
  seg_len = max(1, int(HLS_SEGMENT_SEC))
  if not job:
    indexes = _hls_existing_segment_indexes(out_dir)
    if indexes:
      return (max(indexes) + 1) * seg_len
    return 0.0
  start_idx = max(0, int(job.get("start_index") or 0))
  started_at = float(job.get("started_at") or 0)
  fresh: list[int] = []
  for idx in _hls_existing_segment_indexes(out_dir):
    if idx < start_idx:
      continue
    if started_at > 0:
      try:
        if os.path.getmtime(_hls_segment_path(out_dir, idx)) < started_at - 0.5:
          continue
      except Exception:
        pass
    fresh.append(idx)
  if fresh:
    return (max(fresh) + 1) * seg_len
  return start_idx * seg_len

def _hls_running_job_count() -> int:
  n = 0
  with _hls_jobs_guard:
    for job in _hls_jobs.values():
      if not job or job.get("done") or job.get("killed"):
        continue
      proc = job.get("proc")
      try:
        if proc is not None and proc.poll() is None:
          n += 1
      except Exception:
        pass
  return n

def _hls_maybe_throttle_job(vid_id: str, out_dir: str, job: dict | None, tier: str = "full"):
  if not job or job.get("done") or job.get("killed"):
    return
  tier = _hls_norm_tier(tier)
  if _hls_is_abandoned(vid_id, tier):
    logging.info("[hls] kill abandoned job vid=%s tier=%s", vid_id, tier)
    _hls_kill_job(job)
    return
  proc = job.get("proc")
  try:
    running = proc is not None and proc.poll() is None
  except Exception:
    running = False
  if not running:
    return
  playhead = _hls_effective_playhead(vid_id, tier)
  encoded = _hls_job_encoded_position_sec(out_dir, job)
  ahead = encoded - playhead
  if _hls_is_preview_tier(tier):
    if playhead <= 0 and _hls_preview_last_activity(vid_id, tier) <= 0:
      return
    limit = max(30, HLS_ENCODE_AHEAD_SEC + 10)
    if ahead > limit:
      logging.info("[hls] preview ahead kill vid=%s ahead=%.1fs limit=%ss", vid_id, ahead, limit)
      _hls_kill_job(job)
    return
  concurrent = max(1, _hls_running_job_count())
  limit = HLS_ENCODE_AHEAD_SEC * concurrent + 90
  if ahead > limit * 2:
    logging.debug(
      "[hls] encode-ahead high (not killing) vid=%s tier=%s playhead=%.1fs encoded=%.1fs ahead=%.1fs limit=%ss concurrent=%s",
      vid_id, tier, playhead, encoded, ahead, limit, concurrent,
    )

def _media_container_for(src_path: str) -> str:
  ext = os.path.splitext(src_path)[1].lower().lstrip(".")
  return ext or "unknown"

def _browser_supports_source_codecs(info: dict, supported: dict | None) -> bool:
  sc = supported or {}
  video = (info.get("video") or "").lower()
  audio = (info.get("audio") or "").lower()
  if video == "h264" and not sc.get("h264"):
    return False
  if audio in {"aac", "mp4a"} and not sc.get("aac"):
    return False
  return True

def _hls_preview_can_client_decode(src_path: str, payload: PlaybackNegotiateRequest) -> bool:
  """浮动 preview：浏览器能硬解则直出 MP4，NAS 只读盘发字节，不跑 ffmpeg。"""
  if not HLS_PREVIEW_DIRECT_PLAY:
    return False
  if _hls_copy_blocked_for_source(src_path):
    return False
  info = _probe_hls_codecs(src_path)
  video = (info.get("video") or "").lower()
  audio = (info.get("audio") or "").lower()
  sc = getattr(payload, "supported_codecs", None) or {}
  if video == "h264":
    return _hls_can_copy_for_browser(src_path)
  if video in {"hevc", "h265"} and sc.get("hevc"):
    if audio and audio not in {"aac", "mp4a", "mp3", ""}:
      return False
    return True
  return False

def _hls_js_config_for_client(src_path: str, payload: PlaybackNegotiateRequest) -> dict:
  """按客户端上报的 MSE 内存预算 + 码率，尽量填满 Chrome 缓冲而不 OOM。"""
  bps = int(_hls_estimated_bitrate_bps(src_path) or 0)
  is_mobile = bool(payload.is_mobile)
  budget = int(payload.mse_budget_bytes or 0)
  if budget <= 0:
    dev_gb = float(payload.device_memory_gb or 0) or (4.0 if is_mobile else 8.0)
    heap_lim = int(payload.js_heap_limit_bytes or 0)
    pixels = int(payload.screen_pixels or 0) or (1280 * 720)
    decode_bytes = int(pixels * 1.5 * 12)
    per_gb = 24 * 1024 * 1024 if is_mobile else 32 * 1024 * 1024
    ram_budget = int(dev_gb * per_gb)
    if heap_lim > 0:
      heap_used = max(0, int(payload.js_heap_used_bytes or 0))
      heap_avail = max(0, heap_lim - heap_used - int(heap_lim * 0.25))
      budget = min(int(heap_avail * 0.15), ram_budget)
    else:
      budget = ram_budget
    budget = max(12 * 1024 * 1024, budget - decode_bytes)
    cap = 64 * 1024 * 1024 if is_mobile else 192 * 1024 * 1024
    budget = min(budget, cap)

  seg_headroom = int(32 * 1024 * 1024 * 0.35)
  max_buffer_size = max(8 * 1024 * 1024, budget - seg_headroom)

  max_buffer_length = 600
  if bps > 0:
    max_buffer_length = min(600, max(15, int((max_buffer_size * 8 * 0.92) / bps)))

  back_buffer_length = min(120, max(8, int(max_buffer_length * 0.22)))
  if is_mobile:
    back_buffer_length = min(back_buffer_length, 20)

  return {
    "maxBufferLength": max_buffer_length,
    "maxMaxBufferLength": max_buffer_length,
    "maxBufferSize": max_buffer_size,
    "backBufferLength": back_buffer_length,
    "maxBufferHole": 0.5,
    "highBufferWatchdogPeriod": 2,
    "nudgeMaxRetries": 5,
    "startFragPrefetch": max_buffer_size >= 32 * 1024 * 1024,
    "mseBudgetBytes": budget,
  }

def _negotiate_playback(src_path: str, vid_id: str, payload: PlaybackNegotiateRequest) -> dict:
  tier = _hls_norm_tier(getattr(payload, "playback_tier", "full") or "full")
  duration = _hls_duration_for(src_path)
  source_size = _hls_source_size(src_path)
  bitrate = int(_hls_estimated_bitrate_bps(src_path) or 0)
  if _hls_is_preview_tier(tier):
    bitrate = min(bitrate or 3_000_000, 3_000_000)
  direct_ok = _hls_can_copy_for_browser(src_path)
  copy_risky = _hls_copy_risky_for_browser(src_path)
  copy_blocked = _hls_copy_blocked_for_source(src_path)
  info = _probe_hls_codecs(src_path)
  container = _media_container_for(src_path)
  qid = quote(vid_id, safe="")
  if _hls_is_preview_tier(tier):
    playlist_url = f"/media/hls/{qid}/preview/playlist.m3u8"
  else:
    playlist_url = f"/media/hls/{qid}/playlist.m3u8"
  direct_url = f"/media/video/{qid}"
  meta = {
    "id": str(vid_id),
    "duration": duration,
    "source_size": source_size,
    "estimated_bitrate_bps": bitrate,
    "direct_play_ok": direct_ok,
    "copy_risky": copy_risky,
    "copy_blocked": copy_blocked,
    "container": container,
    "video_codec": info.get("video") or "",
    "audio_codec": info.get("audio") or "",
    "playback_tier": tier,
  }

  # 浮动窗：可硬解则直出（H.264 全走；HEVC 需客户端上报 hevc 支持）
  if _hls_is_preview_tier(tier) and _hls_preview_can_client_decode(src_path, payload):
    logging.info(
      "[playback] preview direct_play vid=%s v=%s a=%s (client decode, no transcode)",
      vid_id, info.get("video"), info.get("audio"),
    )
    return {
      "method": "direct_play",
      "url": direct_url,
      "direct_url": direct_url,
      "meta": meta,
    }
  if _hls_is_preview_tier(tier) and meta.get("direct_play_ok"):
    logging.info(
      "[playback] preview hls_js vid=%s v=%s (direct_play skipped: blocked=%s hevc_no_client=%s)",
      vid_id, info.get("video"), copy_blocked,
      (info.get("video") or "").lower() not in {"h264", "hevc", "h265"},
    )

  # iOS/Safari：无 MSE，走原生 HLS（系统自己控内存）
  if not payload.supports_mse:
    return {
      "method": "native_hls",
      "url": playlist_url,
      "meta": meta,
    }

  # 有 MSE 的浏览器：一律优先 HLS.js；大文件靠紧缓冲 + 跳过长 GOP copy 防 OOM
  return {
    "method": "hls_js",
    "url": playlist_url,
    "direct_url": direct_url,
    "meta": meta,
    "config": _hls_js_config_for_client(src_path, payload),
  }

def _hls_kill_job(job: dict | None):
  if not job:
    return
  job["killed"] = True
  _hls_release_job_hw_slot(job)
  proc = job.get("proc")
  try:
    if proc is not None and proc.poll() is None:
      try:
        os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
      except Exception:
        proc.terminate()
      try:
        proc.wait(timeout=2)
      except Exception:
        try:
          os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
        except Exception:
          proc.kill()
  except Exception:
    pass
  job.update({"done": True, "proc": None})

def _hls_kill_jobs_for_vid(vid_id: str, tier: str = "preview") -> int:
  tier = _hls_norm_tier(tier)
  killed = 0
  keys: list[str] = []
  with _hls_jobs_guard:
    for key, job in list(_hls_jobs.items()):
      if not job:
        continue
      if _hls_norm_tier(str(job.get("tier") or "full")) != tier:
        continue
      if not _hls_vid_matches(str(job.get("vid_id") or ""), vid_id):
        continue
      if not job.get("done"):
        _hls_kill_job(job)
        killed += 1
      keys.append(key)
  for key in keys:
    _hls_forget_job(key)
  return killed

def _hls_stop_transcode(vid_id: str, tier: str = "preview") -> dict:
  tier = _hls_norm_tier(tier)
  killed = _hls_kill_jobs_for_vid(vid_id, tier)
  _hls_mark_abandoned(vid_id, tier)
  _hls_clear_client_state(vid_id, tier)
  logging.info("[hls] stop transcode vid=%s tier=%s killed=%s", vid_id, tier, killed)
  return {"ok": True, "killed": killed > 0, "killed_count": killed, "vid": vid_id, "tier": tier}

def _hls_stop_all_transcode(tier: str = "preview") -> dict:
  tier = _hls_norm_tier(tier)
  killed = 0
  vids: set[str] = set()
  with _hls_jobs_guard:
    for job in list(_hls_jobs.values()):
      if not job:
        continue
      if _hls_norm_tier(str(job.get("tier") or "full")) != tier:
        continue
      vids.add(str(job.get("vid_id") or ""))
      if not job.get("done"):
        _hls_kill_job(job)
        killed += 1
  with _hls_jobs_guard:
    for key, job in list(_hls_jobs.items()):
      if job and _hls_norm_tier(str(job.get("tier") or "full")) == tier:
        _hls_jobs.pop(key, None)
  for vid in vids:
    if vid:
      _hls_mark_abandoned(vid, tier)
      _hls_clear_client_state(vid, tier)
  logging.info("[hls] stop-all tier=%s killed=%s vids=%s", tier, killed, len(vids))
  return {"ok": True, "killed_count": killed, "tier": tier, "videos": len(vids)}

def _hls_preview_last_activity(vid_id: str, tier: str = "preview") -> float:
  key = _hls_playhead_key(vid_id, tier)
  now = time.time()
  last = 0.0
  with _hls_playheads_guard:
    ts = (_hls_playheads.get(key) or (0.0, 0.0))[1]
    if ts:
      last = max(last, ts)
  with _hls_segment_demand_guard:
    ts = (_hls_segment_demand.get(key) or (0.0, 0.0))[1]
    if ts:
      last = max(last, ts)
  return last

def _hls_preview_idle_reaper():
  while True:
    try:
      time.sleep(10)
      now = time.time()
      idle_limit = max(5.0, HLS_PREVIEW_IDLE_KILL_SEC)
      with _hls_jobs_guard:
        snapshot = [
          (key, job)
          for key, job in _hls_jobs.items()
          if job and not job.get("done")
        ]
      for key, job in snapshot:
        tier = _hls_norm_tier(str(job.get("tier") or "full"))
        if tier != "preview":
          continue
        vid = str(job.get("vid_id") or "")
        if not vid:
          continue
        with _hls_jobs_guard:
          live = _hls_jobs.get(key)
          if not live or live.get("done"):
            continue
          job = live
        if _hls_is_abandoned(vid, tier):
          logging.info("[hls] preview abandoned kill vid=%s", vid)
          _hls_kill_job(job)
          continue
        if not _hls_preview_job_has_segment(job, 0):
          continue
        last = _hls_preview_last_activity(vid, tier)
        if last and now - last > idle_limit:
          logging.info("[hls] preview idle kill vid=%s idle=%.1fs", vid, now - last)
          _hls_kill_job(job)
          continue
        out_dir = _hls_dir_for(vid, tier)
        playhead = _hls_effective_playhead(vid, tier)
        last = _hls_preview_last_activity(vid, tier)
        if playhead <= 0 and last <= 0:
          continue
        encoded = _hls_job_encoded_position_sec(out_dir, job)
        ahead = encoded - playhead
        if ahead > max(30, HLS_ENCODE_AHEAD_SEC + 15):
          logging.info("[hls] preview ahead kill vid=%s ahead=%.1fs playhead=%.1fs", vid, ahead, playhead)
          _hls_kill_job(job)
    except Exception as e:
      logging.warning("[hls] preview reaper error: %s", e)

def _hls_bg_cmd(mode: str, src_path: str, out_dir: str, start_idx: int, tier: str = "full") -> list[str]:
  playlist = os.path.join(out_dir, "playlist.m3u8")
  seg_pat = os.path.join(out_dir, "seg_%05d.ts")
  start_time = max(0, int(start_idx)) * max(1, int(HLS_SEGMENT_SEC))
  return _hls_cmd_for_mode(mode, src_path, seg_pat, playlist, start_idx, start_time, tier)

def _hls_monitor_job(key: str, run_id: str, vid_id: str, start_idx: int, mode: str, proc: subprocess.Popen, started_at: float):
  try:
    _, stderr = proc.communicate()
    rc = proc.returncode
  except Exception as e:
    rc = -1
    stderr = str(e).encode("utf-8", errors="ignore")
  err = (stderr or b"").decode("utf-8", errors="ignore")[-4000:]
  with _hls_jobs_guard:
    job = _hls_jobs.get(key)
    if not job or job.get("run_id") != run_id:
      _hls_release_job_hw_slot(job)
      return
    _hls_release_job_hw_slot(job)
    if job.get("killed"):
      job.update({"done": True, "error": "", "proc": None, "exit_code": rc})
      return
    if rc == 0:
      job.update({"done": True, "error": "", "proc": None, "exit_code": rc})
    else:
      job.update({"done": True, "error": err or f"ffmpeg exited with {rc}", "proc": None, "exit_code": rc})
  if rc == 0:
    logging.info("[hls] job encoded %s start=%s mode=%s in %.1fs", vid_id, start_idx, mode, time.time() - started_at)
    threading.Thread(target=_cleanup_hls_cache_dir, daemon=True).start()
  else:
    if _hls_should_disable_mode(mode, err):
      _hls_disable_mode(mode, err)
    else:
      _hls_note_hw_slot_pressure(mode, err)
    logging.warning("[hls] job mode=%s failed for %s start=%s rc=%s: %s", mode, vid_id, start_idx, rc, err[-500:])

def _hls_start_job_wait_for_segment(key: str, vid_id: str, src_path: str, idx: int, timeout_s: float | None = None, keep_running_on_timeout: bool = False, tier: str = "full") -> dict:
  if not src_path or not os.path.isfile(src_path):
    raise HTTPException(404, detail=f"video source missing for {vid_id}")
  tier = _hls_norm_tier(tier)
  out_dir = _hls_dir_for(vid_id, tier)
  target = _hls_segment_path(out_dir, idx)
  attempts = _hls_attempt_chain_for_source(src_path, tier, vid_id=vid_id)
  last_err = ""
  attempt_errors: list[str] = []
  last_cmd: list[str] = []
  slot_wait = float(timeout_s if timeout_s is not None else HLS_HW_ENCODE_SLOT_WAIT_SEC)
  logging.info("[hls] start job vid=%s tier=%s target=%s attempts=%s seg=%ss allow_copy=%s prefer_gpu=%s dual_gpu=%s",
               vid_id, tier, idx, attempts, HLS_SEGMENT_SEC, HLS_ALLOW_COPY and not _hls_is_preview_tier(tier),
               HLS_PREFER_GPU, _hls_dual_gpu_enabled())
  for mode in attempts:
    slot_acquired = False
    try:
      if _hls_is_hw_mode(mode):
        deadline = time.time() + max(5.0, slot_wait)
        evict_tried = False
        while time.time() < deadline:
          if _hls_acquire_hw_slot(mode, timeout=min(2.0, max(0.1, deadline - time.time())), tier=tier):
            slot_acquired = True
            break
          if (
            _hls_is_preview_tier(tier)
            and not evict_tried
            and _hls_evict_lower_preview_jobs(vid_id, only_if_slot_needed=True) > 0
          ):
            evict_tried = True
            continue
          time.sleep(0.15)
        if not slot_acquired:
          grp = _hls_hw_slot_group(mode)
          pool = _hls_hw_slot_pool(grp)
          eff = pool.effective_max(tier) if pool else 0
          last_err = f"hw slot busy ({grp} effective_max={eff} tier={tier})"
          attempt_errors.append(f"{mode}: {last_err}")
          logging.info("[hls] waiting next hw mode for %s tier=%s: %s", vid_id, tier, last_err)
          continue
      os.makedirs(out_dir, exist_ok=True)
      _write_hls_meta(out_dir, src_path, mode, tier)
      cmd = _hls_bg_cmd(mode, src_path, out_dir, idx, tier)
      last_cmd = cmd
      t0 = time.time()
      proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, start_new_session=True)
    except Exception as e:
      if slot_acquired:
        _hls_release_hw_slot(mode)
        slot_acquired = False
      last_err = str(e)
      attempt_errors.append(f"{mode}: {last_err}")
      _hls_note_hw_slot_pressure(mode, last_err)
      if _hls_should_disable_mode(mode, last_err):
        _hls_disable_mode(mode, last_err)
      continue

    run_id = f"{time.time():.6f}:{idx}:{mode}"
    job = {
      "vid_id": vid_id,
      "src_path": src_path,
      "start_index": idx,
      "run_id": run_id,
      "mode": mode,
      "tier": tier,
      "started": True,
      "started_at": t0,
      "done": False,
      "killed": False,
      "error": "",
      "cmd": cmd,
      "attempts": attempts,
      "proc": proc,
      "hw_slot": slot_acquired,
      "hw_slot_mode": mode if slot_acquired else None,
      "hw_slot_released": False,
    }
    with _hls_jobs_guard:
      _hls_jobs[key] = job
    threading.Thread(target=_hls_monitor_job, args=(key, run_id, vid_id, idx, mode, proc, t0), daemon=True, name=f"hls-mon-{vid_id}-{idx}").start()

    wait_s = float(timeout_s if timeout_s is not None else HLS_START_WAIT_SEC)
    deadline = time.time() + max(1.0, wait_s)
    while time.time() < deadline:
      if _hls_segment_file_ready(target):
        if mode in {"copy", "copyfix"} and _hls_segment_oversized(target):
          last_err = _hls_reset_bad_copy_cache(key, vid_id, src_path, job, target, tier)
          attempt_errors.append(f"{mode}: {last_err}")
          logging.warning("[hls] copy mode=%s produced oversized segment for %s; retry transcoding", mode, vid_id)
          break
        logging.info("[hls] job running vid=%s tier=%s mode=%s seg=%s", vid_id, tier, mode, idx)
        return job
      if proc.poll() is not None:
        # 监控线程会填 error，给它一个短窗口。
        time.sleep(0.1)
        with _hls_jobs_guard:
          cur = _hls_jobs.get(key)
          last_err = (cur or {}).get("error") or f"ffmpeg exited with {proc.returncode}"
        attempt_errors.append(f"{mode}: {last_err}")
        _hls_note_hw_slot_pressure(mode, last_err)
        if _hls_should_disable_mode(mode, last_err):
          _hls_disable_mode(mode, last_err)
        logging.warning("[hls] start mode=%s exited before target seg=%s for %s: %s", mode, idx, vid_id, last_err[-500:])
        break
      time.sleep(0.1)

    if proc.poll() is None and not _hls_segment_file_ready(target):
      # 有进展（正在写 .tmp 段或已切出其它段）→ 只是慢，保留继续跑。
      # 0 段且无 .tmp → 解码空转/卡死（如 NVDEC 啃不动 4K H.264），杀掉换下一个模式。
      is_last_mode = (mode == attempts[-1])
      progressing = os.path.exists(target + ".tmp") or _hls_current_segment_index(out_dir) is not None
      if keep_running_on_timeout and (is_last_mode or progressing):
        logging.info("[hls] start mode=%s still warming target seg=%s for %s after %.1fs", mode, idx, vid_id, wait_s)
        return job
      _hls_kill_job(job)
      last_err = f"no segment within {wait_s:.0f}s (mode={mode}; likely undecodable by this path)"
      attempt_errors.append(f"{mode}: {last_err}")
      logging.warning("[hls] start mode=%s stalled (0 seg) for %s, trying next mode", mode, vid_id)
    logging.warning("[hls] start mode=%s did not produce target seg=%s for %s: %s", mode, idx, vid_id, last_err)

  with _hls_jobs_guard:
    failed = {
      "vid_id": vid_id,
      "src_path": src_path,
      "start_index": idx,
      "done": True,
      "error": "\n\n".join(attempt_errors) or last_err or "hls start failed",
      "cmd": last_cmd,
      "attempts": attempts,
      "proc": None,
    }
    _hls_jobs[key] = failed
  raise HTTPException(504, f"hls start failed: {last_err}")

def _ensure_hls_job_for_segment(vid_id: str, src_path: str, idx: int, start_timeout_s: float | None = None, keep_running_on_timeout: bool = False, tier: str = "full"):
  """复用连续 HLS job；seek 距离太大时从目标段重启 job。"""
  tier = _hls_norm_tier(tier)
  if _hls_is_abandoned(vid_id, tier):
    _hls_clear_abandoned(vid_id, tier)
  if _hls_is_preview_tier(tier):
    keep_running_on_timeout = True
    if start_timeout_s is None:
      # 每个模式等 seg0 的窗口：正常 540p 转码 1-3s 就出段，所以 ~12s 足够；
      # 超时仍 0 段=该硬解路径空转，快速让位下一模式（见循环里的卡死判定）。
      start_timeout_s = 12.0
  out_dir = _hls_dir_for(vid_id, tier)
  key = _hls_job_key(vid_id, src_path, tier)
  _ensure_hls_dynamic_cache_dir(vid_id, src_path, tier)
  if _hls_segment_file_ready(_hls_segment_path(out_dir, idx)):
    return _hls_job_for(key)

  gap_limit = max(2, int(24 / max(1, int(HLS_SEGMENT_SEC))))
  lock = _hls_lock(f"{vid_id}:{tier}:job")
  with lock:
    if _hls_segment_file_ready(_hls_segment_path(out_dir, idx)):
      return _hls_job_for(key)

    current_idx = _hls_current_segment_index(out_dir)
    with _hls_jobs_guard:
      job = _hls_jobs.get(key)
    running = False
    if job and not job.get("done"):
      proc = job.get("proc")
      try:
        running = proc is None or proc.poll() is None
      except Exception:
        running = False

    if running:
      start_idx = int((job or {}).get("start_index") or 0)
      anchor_idx = current_idx if current_idx is not None else start_idx
      if idx >= anchor_idx and (idx - anchor_idx) <= gap_limit:
        _hls_maybe_throttle_job(vid_id, out_dir, job, tier)
        return job
      # 请求的段已在磁盘上：直接复用，不因另一客户端 playhead 不同而杀 job
      if _hls_segment_file_ready(_hls_segment_path(out_dir, idx)):
        _hls_maybe_throttle_job(vid_id, out_dir, job, tier)
        return job

    if running:
      if current_idx is not None and abs(idx - current_idx) > max(0, int(HLS_DISCONTINUITY_AFTER_GAP_SEGMENTS)):
        _hls_mark_discontinuity(out_dir, idx)
      _hls_kill_job(job)
    if idx == 0 and os.path.isdir(out_dir):
      try:
        shutil.rmtree(out_dir)
      except Exception:
        pass
      os.makedirs(out_dir, exist_ok=True)
    else:
      if current_idx is not None:
        _hls_delete_last_transcoding_file(out_dir)
    return _hls_start_job_wait_for_segment(key, vid_id, src_path, idx, start_timeout_s, keep_running_on_timeout, tier)

def _hls_segment_ready_to_serve(out_dir: str, idx: int, job: dict | None) -> bool:
  seg_path = _hls_segment_path(out_dir, idx)
  return _hls_segment_file_ready(seg_path)

def _hls_wait_for_min_segments(out_dir: str, min_segments: int, deadline: float):
  target = max(0, int(min_segments))
  if target <= 0:
    return
  while time.time() < deadline:
    ready = 0
    for i in range(target):
      if _hls_segment_file_ready(_hls_segment_path(out_dir, i)):
        ready += 1
      else:
        break
    if ready >= target:
      return
    time.sleep(0.1)

def _prime_hls_playlist(vid_id: str, src_path: str, tier: str = "full"):
  tier = _hls_norm_tier(tier)
  _hls_clear_abandoned(vid_id, tier)
  if _hls_is_preview_tier(tier):
    min_segments = max(0, int(HLS_PREVIEW_PLAYLIST_PRIME_SEGMENTS))
    wait_s = max(8.0, float(HLS_PREVIEW_PLAYLIST_PRIME_WAIT_SEC))
    keep_running = True
  else:
    min_segments = max(0, int(HLS_PLAYLIST_PRIME_SEGMENTS))
    wait_s = max(0.0, float(HLS_PLAYLIST_PRIME_WAIT_SEC))
    keep_running = True
  if min_segments <= 0 or wait_s <= 0:
    return
  out_dir = _hls_dir_for(vid_id, tier)
  if all(_hls_segment_file_ready(_hls_segment_path(out_dir, i)) for i in range(min_segments)):
    return
  deadline = time.time() + wait_s
  try:
    _ensure_hls_job_for_segment(
      vid_id,
      src_path,
      0,
      start_timeout_s=12.0 if _hls_is_preview_tier(tier) else max(0.5, min(wait_s, HLS_START_WAIT_SEC)),
      keep_running_on_timeout=keep_running,
      tier=tier,
    )
    _hls_wait_for_min_segments(out_dir, min_segments, deadline)
  except Exception as e:
    logging.warning("[hls] playlist prime skipped for %s tier=%s: %s", vid_id, tier, e)

def _wait_for_hls_segment(vid_id: str, src_path: str, idx: int, timeout_s: float = 90.0, tier: str = "full") -> str:
  tier = _hls_norm_tier(tier)
  _hls_clear_abandoned(vid_id, tier)
  out_dir = _hls_dir_for(vid_id, tier)
  seg_path = _hls_segment_path(out_dir, idx)
  _ensure_hls_dynamic_cache_dir(vid_id, src_path, tier)
  key = _hls_job_key(vid_id, src_path, tier)
  job = _hls_job_for(key)
  if _hls_cache_matches(out_dir, src_path, tier) and _hls_segment_ready_to_serve(out_dir, idx, job):
    return seg_path
  job = _ensure_hls_job_for_segment(vid_id, src_path, idx, tier=tier) or _hls_job_for(key)
  deadline = time.time() + timeout_s
  while time.time() < deadline:
    if _hls_cache_matches(out_dir, src_path, tier) and _hls_segment_ready_to_serve(out_dir, idx, job):
      return seg_path
    job = _hls_job_for(key)
    _hls_maybe_throttle_job(vid_id, out_dir, job, tier)
    if job and job.get("done") and job.get("error"):
      _hls_forget_job(key)
      job = _ensure_hls_job_for_segment(vid_id, src_path, idx, tier=tier) or _hls_job_for(key)
      continue
    if job is None or (job.get("done") and not job.get("error") and not _hls_segment_file_ready(seg_path)):
      job = _ensure_hls_job_for_segment(vid_id, src_path, idx, tier=tier) or _hls_job_for(key)
    time.sleep(0.15)
  raise HTTPException(504, f"hls segment not ready: {idx}")

def _hls_segment_file_ready(seg_path: str) -> bool:
  """只发送已经写完并稳定的 segment，避免 Content-Length mismatch。"""
  try:
    if os.path.exists(seg_path + ".tmp"):
      return False
    if not os.path.isfile(seg_path):
      return False
    s1 = os.path.getsize(seg_path)
    if s1 <= 0:
      return False
    # 兼容旧缓存/非 temp_file 输出：确认短时间内 size 不再增长。
    time.sleep(0.08)
    if os.path.exists(seg_path + ".tmp"):
      return False
    return os.path.isfile(seg_path) and os.path.getsize(seg_path) == s1
  except Exception:
    return False

def _ensure_hls_segment(vid_id: str, src_path: str, idx: int, tier: str = "full") -> str:
  dur_total = _hls_duration_for(src_path)
  seg_len = max(1, int(HLS_SEGMENT_SEC))
  if idx * seg_len >= dur_total + 0.5:
    raise HTTPException(404)
  wait_s = 180.0 if _hls_is_preview_tier(tier) else 90.0
  return _wait_for_hls_segment(vid_id, src_path, idx, timeout_s=wait_s, tier=tier)

def _cleanup_hls_cache_dir():
  """LRU + 过期清理。简单实现：按 mtime 排序，超过 GB 阈值或天数阈值的整目录删。"""
  try:
    for cache_root in (HLS_CACHE_DIR, HLS_PREVIEW_CACHE_DIR):
      entries = []
      total = 0
      now = time.time()
      if not os.path.isdir(cache_root):
        continue
      for name in os.listdir(cache_root):
        d = os.path.join(cache_root, name)
        if not os.path.isdir(d):
          continue
        pl = os.path.join(d, "playlist.m3u8")
        size = 0
        newest_mtime = 0.0
        has_media = os.path.isfile(pl) or os.path.isfile(os.path.join(d, "meta.json"))
        for root, _, files in os.walk(d):
          for fn in files:
            p = os.path.join(root, fn)
            try:
              size += os.path.getsize(p)
              newest_mtime = max(newest_mtime, os.path.getmtime(p))
              if fn.endswith(".ts") or fn == "playlist.m3u8":
                has_media = True
            except Exception:
              pass
        if not has_media:
          try: shutil.rmtree(d)
          except Exception: pass
          continue
        mtime = newest_mtime or os.path.getmtime(d)
        entries.append((mtime, size, d))
        total += size
      max_age = HLS_CACHE_MAX_AGE_DAYS * 86400
      for mtime, size, d in list(entries):
        if (now - mtime) > max_age:
          try: shutil.rmtree(d); total -= size
          except Exception: pass
          entries.remove((mtime, size, d))
      cap = int(HLS_CACHE_MAX_TOTAL_GB * 1024 * 1024 * 1024)
      if total > cap:
        entries.sort(key=lambda x: x[0])
        for mtime, size, d in entries:
          if total <= cap: break
          try: shutil.rmtree(d); total -= size
          except Exception: pass
  except Exception as e:
    logging.warning("[hls] cleanup error: %s", e)

@app.get("/media/hls/{vid_id}/playlist.m3u8")
def hls_playlist(vid_id: str):
  path = _hls_source_for_vid(vid_id)
  _hls_note_segment_demand(vid_id, 0, "full")
  _prime_hls_playlist(vid_id, path, "full")
  body = _hls_dynamic_playlist(vid_id, path, "full")
  return Response(content=body, media_type="application/vnd.apple.mpegurl", headers={
    "Cache-Control": "no-store",
  })

@app.get("/media/hls/{vid_id}/preview/playlist.m3u8")
def hls_preview_playlist(vid_id: str):
  _hls_clear_abandoned(vid_id, "preview")
  path = _hls_source_for_vid(vid_id)
  _hls_note_segment_demand(vid_id, 0, "preview")
  _prime_hls_playlist(vid_id, path, "preview")
  body = _hls_dynamic_playlist(vid_id, path, "preview")
  return Response(content=body, media_type="application/vnd.apple.mpegurl", headers={
    "Cache-Control": "no-store",
  })

@app.get("/media/hls/{vid_id}/info")
def hls_info(vid_id: str):
  path = _hls_source_for_vid(vid_id)
  duration = _hls_duration_for(path)
  return {
    "id": str(vid_id),
    "duration": duration,
    "source_size": _hls_source_size(path),
    "estimated_bitrate_bps": int(_hls_estimated_bitrate_bps(path) or 0),
    "direct_play_ok": _hls_can_copy_for_browser(path),
    "copy_risky": _hls_copy_risky_for_browser(path),
    "copy_blocked": _hls_copy_blocked_for_source(path),
    "copy_block_reason": _hls_copy_block_reason(path),
    "use_hls": True,
    "segment_sec": HLS_SEGMENT_SEC,
    "allow_copy": HLS_ALLOW_COPY,
    "transcode_fallback": HLS_TRANSCODE_FALLBACK,
    "attempts": _hls_attempt_chain_for_source(path, "full", vid_id=str(vid_id)),
    "start_wait_sec": HLS_START_WAIT_SEC,
    "playlist_prime_segments": HLS_PLAYLIST_PRIME_SEGMENTS,
    "playlist_prime_wait_sec": HLS_PLAYLIST_PRIME_WAIT_SEC,
  }

@app.get("/media/hls/{vid_id}/debug")
def hls_debug(vid_id: str, tier: str = Query("full")):
  tier = _hls_norm_tier(tier)
  path = _hls_source_for_vid(vid_id)
  out_dir = _hls_dir_for(vid_id, tier)
  key = _hls_job_key(vid_id, path, tier)
  job = _hls_job_for(key)
  proc_running = False
  if job and job.get("proc") is not None:
    try:
      proc_running = job["proc"].poll() is None
    except Exception:
      proc_running = False
  indexes = _hls_existing_segment_indexes(out_dir)
  return {
    "id": str(vid_id),
    "tier": tier,
    "pipeline_version": HLS_PIPELINE_VERSION,
    "source": path,
    "cache_dir": out_dir,
    "cache_matches": _hls_cache_matches(out_dir, path, tier),
    "segments": indexes[-20:],
    "segment_count": len(indexes),
    "source_size": _hls_source_size(path),
    "estimated_bitrate_bps": int(_hls_estimated_bitrate_bps(path) or 0),
    "direct_play_ok": _hls_can_copy_for_browser(path),
    "copy_risky": _hls_copy_risky_for_browser(path),
    "copy_blocked": _hls_copy_blocked_for_source(path),
    "copy_block_reason": _hls_copy_block_reason(path),
    "first_segment_size": (
      os.path.getsize(_hls_segment_path(out_dir, 0))
      if os.path.isfile(_hls_segment_path(out_dir, 0)) else 0
    ),
    "current_index": _hls_current_segment_index(out_dir),
    "transcode_fallback": HLS_TRANSCODE_FALLBACK,
    "attempts": _hls_attempt_chain_for_source(path, tier, vid_id=str(vid_id)),
    "playlist_prime_segments": HLS_PLAYLIST_PRIME_SEGMENTS,
    "playlist_prime_wait_sec": HLS_PLAYLIST_PRIME_WAIT_SEC,
    "job": {
      "exists": bool(job),
      "running": proc_running,
      "mode": (job or {}).get("mode"),
      "start_index": (job or {}).get("start_index"),
      "done": bool((job or {}).get("done")),
      "killed": bool((job or {}).get("killed")),
      "error": (job or {}).get("error") or "",
      "started_at": (job or {}).get("started_at"),
      "cmd": " ".join((job or {}).get("cmd") or []),
      "attempts": (job or {}).get("attempts") or [],
    },
    "disabled_modes": sorted(_hls_disabled_modes),
  }

# 段文件按需生成并缓存：playlist 立即返回，浏览器请求到哪段就切哪段。
@app.get("/media/hls/{vid_id}/preview/{segment}")
def hls_preview_segment(vid_id: str, segment: str):
  if not re.fullmatch(r"seg_\d{1,8}\.ts", segment):
    raise HTTPException(404)
  _hls_clear_abandoned(vid_id, "preview")
  idx = int(segment[4:-3])
  path = _hls_source_for_vid(vid_id)
  _hls_note_segment_demand(vid_id, idx, "preview")
  seg_path = _ensure_hls_segment(vid_id, path, idx, tier="preview")
  return FastFileResponse(seg_path, media_type="video/mp2t", headers={
    "Accept-Ranges": "bytes",
    "Cache-Control": "public, max-age=31536000, immutable",
  })

@app.get("/media/hls/{vid_id}/{segment}")
def hls_segment(vid_id: str, segment: str):
  if not re.fullmatch(r"seg_\d{1,8}\.ts", segment):
    raise HTTPException(404)
  idx = int(segment[4:-3])
  path = _hls_source_for_vid(vid_id)
  _hls_note_segment_demand(vid_id, idx, "full")
  seg_path = _ensure_hls_segment(vid_id, path, idx, tier="full")
  return FastFileResponse(seg_path, media_type="video/mp2t", headers={
    "Accept-Ranges": "bytes",
    "Cache-Control": "public, max-age=31536000, immutable",
  })

@app.api_route("/media/video/{vid_id}", methods=["GET", "HEAD"])
def media_video(request: Request, vid_id: str):
  _, id_map, _ = _scan_state()
  v = id_map.get(vid_id)
  if not v: raise HTTPException(404)
  src_path = v.video_path
  # ★ 若存在有效的转码缓存，则优先用缓存文件（不覆盖原文件也能在 WebUI 播放）
  cache_path = _get_video_cache_path_if_any(vid_id, src_path)
  path = cache_path or src_path
  mime, _ = mimetypes.guess_type(path)
  mime = mime or "application/octet-stream"

  etag = _etag_for(path)
  last_mod = _last_modified_str(path)

  inm = request.headers.get("if-none-match")
  ims = request.headers.get("if-modified-since")
  if inm == etag:
    return Response(status_code=304, headers={
      "ETag": etag,
      "Last-Modified": last_mod,
      "Accept-Ranges": "bytes",
      "Cache-Control": "public, max-age=31536000, immutable",
    })
  if ims:
    try:
      ims_dt = parsedate_to_datetime(ims)
      if int(os.stat(path).st_mtime) <= int(ims_dt.timestamp()):
        return Response(status_code=304, headers={
          "ETag": etag,
          "Last-Modified": last_mod,
          "Accept-Ranges": "bytes",
          "Cache-Control": "public, max-age=31536000, immutable",
        })
    except Exception:
      pass

  return _send_media_file(path, mime, etag, last_mod)

@app.get("/debug/media/{vid_id}")
def debug_media(vid_id: str):
  _, id_map, _ = _scan_state()
  v = id_map.get(vid_id)
  if not v:
    raise HTTPException(404)
  src_path = v.video_path
  cache_path = _get_video_cache_path_if_any(vid_id, src_path)
  path = cache_path or src_path
  return {
    "id": str(vid_id),
    "path": path,
    "exists": os.path.isfile(path),
    "readable_by_fastapi": os.access(path, os.R_OK),
    "size": os.path.getsize(path) if os.path.isfile(path) else 0,
  }

# =======================
# 新增：/media/audio/{vid_id} 纯音频直出（缓存 + Range）
# =======================

_audio_locks = {}
_audio_global_lock = threading.Lock()
def _get_audio_lock(key: str) -> threading.Lock:
  with _audio_global_lock:
    if key not in _audio_locks:
      _audio_locks[key] = threading.Lock()
    return _audio_locks[key]

def _audio_cache_file(vid: str, src_path: str) -> str:
  st = os.stat(src_path)
  key = f"{vid}_{int(st.st_mtime)}_{st.st_size}"
  # 统一导出 mp4/m4a 容器；mime 使用 audio/mp4
  return os.path.join(AUDIO_CACHE_DIR, f"{key}.m4a")

def _cleanup_old_audio_caches(vid: str, keep_path: str):
  """清理指定 vid 的旧音频缓存。如果 keep_path 为空字符串，则清理该 vid 的所有缓存。"""
  try:
    kp = os.path.abspath(keep_path) if keep_path else ""
    for p in glob.glob(os.path.join(AUDIO_CACHE_DIR, f"{vid}_*.m4a")):
      try:
        if not kp or os.path.abspath(p) != kp:
          os.remove(p)
          print(f"[AUDIO_CACHE] removed old cache: {os.path.basename(p)}")
      except Exception as e:
        print(f"[AUDIO_CACHE] failed to remove {os.path.basename(p)}: {e}")
  except Exception as e:
    print(f"[AUDIO_CACHE] cleanup failed for vid={vid}: {e}")

def _cleanup_audio_cache_dir():
  """按“最大保留天数 + 最大目录体积”清理 audio_cache。"""
  try:
    paths = glob.glob(os.path.join(AUDIO_CACHE_DIR, "*.m4a"))
    if not paths:
      return
    now = time.time()
    max_age_s = max(0, int(_AUDIO_CACHE_MAX_AGE_DAYS)) * 86400
    max_total_bytes = max(0, int(_AUDIO_CACHE_MAX_TOTAL_MB)) * 1024 * 1024

    # 1) 先按年龄删
    kept = []
    for p in paths:
      try:
        st = os.stat(p)
        age = now - float(st.st_mtime)
        if max_age_s > 0 and age > max_age_s:
          try:
            os.remove(p)
            print(f"[AUDIO_CACHE] pruned by age: {os.path.basename(p)}")
          except Exception as e:
            print(f"[AUDIO_CACHE] prune-by-age failed {os.path.basename(p)}: {e}")
        else:
          kept.append((p, st.st_mtime, st.st_size))
      except Exception:
        pass

    if max_total_bytes <= 0:
      return

    # 2) 再按总大小删（从最旧开始）
    total = sum(sz for _, _, sz in kept)
    if total <= max_total_bytes:
      return
    kept.sort(key=lambda x: x[1])  # mtime asc（最旧先删）
    for p, mt, sz in kept:
      if total <= max_total_bytes:
        break
      try:
        os.remove(p)
        total -= sz
        print(f"[AUDIO_CACHE] pruned by size: {os.path.basename(p)}")
      except Exception as e:
        print(f"[AUDIO_CACHE] prune-by-size failed {os.path.basename(p)}: {e}")
  except Exception as e:
    print(f"[AUDIO_CACHE] directory cleanup failed: {e}")

def _start_audio_cache_cleaner():
  try:
    interval_s = max(60, int(_AUDIO_CACHE_CLEAN_INTERVAL_MIN) * 60)
  except Exception:
    interval_s = 3600
  def _loop():
    while True:
      try:
        _cleanup_audio_cache_dir()
      except Exception:
        pass
      time.sleep(interval_s)
  t = threading.Thread(target=_loop, name="audio-cache-cleaner", daemon=True)
  t.start()

# 启动后台清理线程（模块加载即启动；daemon 不阻塞退出）
_start_audio_cache_cleaner()

def _verify_audio_timestamps(audio_path: str, video_src: str, vid: str) -> bool:
    """Check that extracted audio starts near t=0 and duration matches the source video."""
    try:
        probe_audio = subprocess.run(
            ["ffprobe", "-v", "quiet", "-print_format", "json",
             "-show_format", "-show_streams", "-select_streams", "a:0",
             audio_path],
            capture_output=True, text=True, timeout=10)
        ainfo = json.loads(probe_audio.stdout)

        fmt_start = float(ainfo.get("format", {}).get("start_time", "0") or "0")
        streams = ainfo.get("streams", [])
        stream_start = float(streams[0].get("start_time", "0") or "0") if streams else 0.0
        audio_dur = float(ainfo.get("format", {}).get("duration", "0") or "0")

        start = max(fmt_start, stream_start)
        if start > 0.5:
            print(f"[AUDIO_CACHE] copy has start_time={start:.2f}s, "
                  f"falling back to transcode for {vid}")
            return False

        # Also compare durations: if audio is significantly longer than the
        # source video, there's a hidden timestamp offset (e.g. edit lists).
        try:
            probe_video = subprocess.run(
                ["ffprobe", "-v", "quiet", "-print_format", "json",
                 "-show_format", video_src],
                capture_output=True, text=True, timeout=10)
            vinfo = json.loads(probe_video.stdout)
            video_dur = float(vinfo.get("format", {}).get("duration", "0") or "0")
            if video_dur > 0 and audio_dur > 0:
                diff = audio_dur - video_dur
                if diff > 1.0:
                    print(f"[AUDIO_CACHE] audio duration ({audio_dur:.1f}s) exceeds "
                          f"video ({video_dur:.1f}s) by {diff:.1f}s, "
                          f"falling back to transcode for {vid}")
                    return False
        except Exception:
            pass

        return True
    except Exception:
        return True

def _ensure_audio_cached(vid: str, src_path: str) -> Tuple[str, str]:
    """
    返回 (cached_path, mime)。
    优先 -c:a copy 无损抽轨，失败则回落 AAC 编码。
    强制将时间轴对齐至 0，避免前端显示的 position 偏移。
    """
    out_path = _audio_cache_file(vid, src_path)
    if os.path.isfile(out_path):
        return out_path, "audio/mp4"

    lock = _get_audio_lock(vid)
    with lock:
        if os.path.isfile(out_path):
            return out_path, "audio/mp4"

        tmp_path = out_path + ".tmp"

        # 通用前置参数：生成缺失 PTS、起点对齐 0
        common_pre = ["-y", "-hide_banner", "-loglevel", "error", "-fflags", "+genpts", "-ss", "0"]
        # 容器参数：faststart + 消除负时间戳
        common_post = ["-movflags", "+faststart", "-avoid_negative_ts", "make_zero", "-f", "mp4", tmp_path]

        # 1) 无损 copy：优雅失败
        cmd_copy = ["ffmpeg"] + common_pre + [
            "-i", src_path,
            "-vn", "-sn", "-dn",
            "-map", "0:a:0",
            "-c:a", "copy",
        ] + common_post

        # 2) 转码兜底（把时间线归零）
        cmd_transcode = ["ffmpeg"] + common_pre + [
            "-i", src_path,
            "-vn", "-sn", "-dn",
            "-map", "0:a:0",
            "-c:a", "aac", "-b:a", "192k",
            "-af", "asetpts=PTS-STARTPTS",
        ] + common_post

        try:
            if os.path.exists(tmp_path):
                os.remove(tmp_path)
        except Exception:
            pass

        ok = False
        try:
            subprocess.run(cmd_copy, check=True)
            if os.path.isfile(tmp_path):
                ok = _verify_audio_timestamps(tmp_path, src_path, vid)
            else:
                ok = False
        except Exception:
            ok = False

        if not ok:
            try:
                if os.path.exists(tmp_path):
                    os.remove(tmp_path)
            except Exception:
                pass
            try:
                subprocess.run(cmd_transcode, check=True)
                ok = True
            except Exception:
                ok = False

        if not ok:
            raise RuntimeError("audio-extract-failed")

        os.replace(tmp_path, out_path)
        _cleanup_old_audio_caches(vid, out_path)
        return out_path, "audio/mp4"

@app.get("/media/audio/{vid_id}")
def media_audio(request: Request, vid_id: str):
  """
  纯音频直出端点：前端 <audio> 指向这里，支持 Range/ETag/强缓存。
  首次命中会抽出音轨并缓存；后续直接走缓存文件，后台切集稳定出声。
  """
  _, id_map, _ = _scan_state()
  v = id_map.get(vid_id)
  if not v: raise HTTPException(404)
  src_path = v.video_path
  # ★ 若存在有效的转码缓存，音频也优先从缓存视频抽取（保证与 WebUI 播放的版本一致）
  cache_path = _get_video_cache_path_if_any(vid_id, src_path)
  if cache_path:
    src_path = cache_path

  try:
    cache_path, mime = _ensure_audio_cached(vid_id, src_path)
  except Exception:
    # 兜底：返回原视频（audio 标签也能播，但某些机型后台可能受限）
    cache_path = src_path
    mime, _ = mimetypes.guess_type(src_path)
    mime = mime or "application/octet-stream"

  etag = _etag_for(cache_path)
  last_mod = _last_modified_str(cache_path)

  inm = request.headers.get("if-none-match")
  ims = request.headers.get("if-modified-since")
  if inm == etag:
    return Response(status_code=304, headers={
      "ETag": etag,
      "Last-Modified": last_mod,
      "Accept-Ranges": "bytes",
      "Cache-Control": "public, max-age=31536000, immutable",
    })
  if ims:
    try:
      ims_dt = parsedate_to_datetime(ims)
      if int(os.stat(cache_path).st_mtime) <= int(ims_dt.timestamp()):
        return Response(status_code=304, headers={
          "ETag": etag,
          "Last-Modified": last_mod,
          "Accept-Ranges": "bytes",
          "Cache-Control": "public, max-age=31536000, immutable",
        })
    except Exception:
      pass

  return _send_media_file(cache_path, mime, etag, last_mod)

@app.get("/go/workshop/{vid_id}")
def go_workshop(vid_id: str):
  return RedirectResponse(url=f"https://steamcommunity.com/sharedfiles/filedetails/?id={vid_id}")

@app.get("/health")
def health():
  cfg_ok = os.path.isfile(os.path.join(WE_PATH, "config.json"))
  work_ok = os.path.isdir(WORKSHOP_PATH)
  try:
    work_has_dirs = any(name.isdigit() for name in os.listdir(WORKSHOP_PATH))
  except Exception:
    work_has_dirs = False
  return {
    "WE_PATH": WE_PATH,
    "config_json_exists": cfg_ok,
    "WORKSHOP_PATH": WORKSHOP_PATH,
    "workshop_exists": work_ok,
    "workshop_has_digit_dirs": work_has_dirs
  }

# =======================
# ★ 新增：取消订阅（服务器端队列 + 脚本回调），最小化集成
# =======================

# 队列：key -> {queue: deque[str], total:int, assigned:int, done:int, ts:float}
UNSUB_STORE = {}
UNSUB_LOCK  = threading.Lock()
UNSUB_TTL   = int(os.getenv("UNSUB_TTL", "3600"))  # 1 小时

def _unsub_cleanup():
    now = time.time()
    with UNSUB_LOCK:
        dead = [k for k, v in UNSUB_STORE.items() if (now - v.get("ts", now)) > UNSUB_TTL]
        for k in dead:
            UNSUB_STORE.pop(k, None)

def _build_cb_url(request: Request, key: str) -> str:
    base = str(request.base_url).rstrip("/")
    return f"{base}/unsub/next?key={quote(key)}"

def _steam_url_with_hash(workshop_id: str, cb_url: str) -> str:
    # 统一加 #bulk_unsub=1&cb=ENCODED
    # 必须对整个 cb_url 进行编码，包括 ? 和 &，否则 userscript 解析时会出错
    h = f"bulk_unsub=1&cb={quote(cb_url, safe='')}"
    return f"https://steamcommunity.com/sharedfiles/filedetails/?id={workshop_id}#{h}"

@app.get("/unsub", response_class=HTMLResponse)
def unsub_page(request: Request):
    # 模板 unsub.html 负责读取 ?ids= 和 batch= 并调用 /api/unsub/init
    return templates.TemplateResponse(request, "unsub.html", {"request": request})

@app.post("/api/unsub/init")
def api_unsub_init(request: Request, payload: dict = Body(..., embed=False)):
    """
    注册一个退订任务队列，默认 batch=1，并返回首批要打开的 Steam 链接（已带 #bulk_unsub=1&cb=…）。
    前端或用户脚本随后会在每次完成后回调 /unsub/next?key=… 取下一条。
    """
    ids = [str(x).strip() for x in (payload.get("ids") or []) if str(x).strip()]
    if not ids:
        raise HTTPException(400, detail="no ids")
    batch = int(payload.get("batch") or 1)
    batch = max(1, min(batch, 10))

    key = secrets.token_urlsafe(16)
    cb  = _build_cb_url(request, key)
    urls = [_steam_url_with_hash(wid, cb) for wid in ids]

    from collections import deque
    first, rest = urls[:batch], urls[batch:]
    with UNSUB_LOCK:
        UNSUB_STORE[key] = dict(queue=deque(rest), total=len(urls),
                                assigned=len(first), done=0, ts=time.time())
    
    print(f"[UNSUB/INIT] Created queue with key={key}, total={len(urls)} items, first_batch={len(first)}, queue_size={len(rest)}")
    print(f"[UNSUB/INIT] Callback URL: {cb}")
    print(f"[UNSUB/INIT] First URL: {first[0] if first else 'none'}")
    
    return {"key": key, "first": first, "total": len(urls)}

def _cors_headers(extra: dict | None = None):
    base = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "content-type",
        "Access-Control-Max-Age": "86400",
    }
    if extra:
        base.update(extra)
    return base

@app.options("/unsub/next")
def unsub_next_options():
    return Response(status_code=204, headers=_cors_headers())

@app.post("/unsub/next")
async def unsub_next(request: Request, key: str = Query(...)):
    """
    油猴脚本在完成当前条目的取消订阅后调用本接口，服务器返回下一条要处理的 URL。
    若队列为空，返回 {"url": ""}。
    """
    _unsub_cleanup()

    # 读取客户端上报（可选）
    data = {}
    try:
        raw = await request.body()
        if raw:
            import json as _json
            data = _json.loads(raw.decode("utf-8", "ignore"))
    except Exception:
        data = {}

    with UNSUB_LOCK:
        slot = UNSUB_STORE.get(key)
        if not slot:
            return JSONResponse({"url": ""}, headers=_cors_headers())
        # 统计
        slot["done"] = int(slot.get("done", 0)) + 1
        q = slot["queue"]
        nxt = q.popleft() if q else ""
        if nxt:
            slot["assigned"] = int(slot.get("assigned", 0)) + 1
        slot["ts"] = time.time()

    return JSONResponse({"url": nxt}, headers=_cors_headers())

@app.options("/unsub/batch")
def unsub_batch_options():
    return Response(status_code=204, headers=_cors_headers())

@app.get("/unsub/batch")
async def unsub_batch(request: Request, key: str = Query(None), size: int = Query(10)):
    """
    单页面模式：批量返回多个 workshop ID，供脚本在同一页面中处理。
    返回格式：{"ids": ["id1", "id2", ...], "remaining": N}
    如果没有提供 key，返回空列表（用于检测接口是否存在）
    """
    _unsub_cleanup()
    
    # 兼容 userscript 可能拼出：/unsub/batch?key=XXX?size=10（第二个 ? 进入 key 值）
    # 以及在某些环境下 size 解析不到的情况：尽量从原始 query 兜底解析。
    query_string = str(request.url.query or "")
    import re

    # 1) 优先修正 key：去掉误拼进来的 "?size=..."
    original_key = key
    if isinstance(key, str) and key:
        # FastAPI 可能会把 "XXX?size=10" 当成 key 的值
        key = key.split("?", 1)[0].strip()

    # 2) 若 key 仍为空，尝试从原始 query 里提取
    if not key:
        key_match = re.search(r"(?:^|[&?])key=([^&?]+)", query_string)
        if key_match:
            key = key_match.group(1).split("?", 1)[0].strip()

    # 3) size 兜底解析（支持 key=XXX?size=10 这种情况）
    size_match = re.search(r"(?:^|[&?])size=(\d+)", query_string)
    if size_match:
        try:
            size = int(size_match.group(1))
        except Exception:
            pass
    
    size = max(1, min(size, 50))  # 限制每次最多50个
    
    # 调试日志
    print(f"[UNSUB/BATCH] query_string={query_string}, original_key={original_key}, parsed_key={key}, size={size}")
    
    # 如果没有 key，返回空列表（用于检测接口是否存在）
    if not key:
        print(f"[UNSUB/BATCH] No key provided, returning empty list for detection")
        return JSONResponse({"ids": [], "remaining": 0}, headers=_cors_headers())
    
    with UNSUB_LOCK:
        slot = UNSUB_STORE.get(key)
        if not slot:
            print(f"[UNSUB/BATCH] Key '{key}' not found in store. Available keys: {list(UNSUB_STORE.keys())}")
            return JSONResponse({"ids": [], "remaining": 0}, headers=_cors_headers())
        
        # 从队列中取出 size 个 URL，解析出 workshop ID
        q = slot["queue"]
        ids = []
        print(f"[UNSUB/BATCH] Queue length: {len(q)}, requesting size: {size}")
        for _ in range(min(size, len(q))):
            if not q:
                break
            url = q.popleft()
            # 从 URL 中解析 workshop ID: https://steamcommunity.com/sharedfiles/filedetails/?id=123456#...
            import re
            match = re.search(r'[?&]id=(\d+)', url)
            if match:
                wid = match.group(1)
                ids.append(wid)
                slot["assigned"] = int(slot.get("assigned", 0)) + 1
                print(f"[UNSUB/BATCH] Extracted workshop ID: {wid}")
            else:
                print(f"[UNSUB/BATCH] Failed to extract ID from URL: {url}")
        
        slot["ts"] = time.time()
        remaining = len(q)
    
    print(f"[UNSUB/BATCH] Returning {len(ids)} IDs, {remaining} remaining")
    return JSONResponse({"ids": ids, "remaining": remaining}, headers=_cors_headers())