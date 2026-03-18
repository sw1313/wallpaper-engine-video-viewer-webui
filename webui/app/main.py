# app/main.py (fs-35 audio-direct: add /media/audio/{vid_id} + inplace faststart + keepalive)
import os, math, mimetypes, re, sqlite3, threading, io, hashlib, subprocess, glob, shutil, json
import time, logging  # ★ 新增：用于 /api/keepalive 时间与日志过滤
import secrets  # ★ 新增
from urllib.parse import quote  # ★ 新增
from pathlib import Path
from typing import List, Tuple
from datetime import datetime
from email.utils import parsedate_to_datetime

from fastapi import FastAPI, Query, Request, HTTPException, Body  # ★ 添加 Body
from fastapi.responses import (
    FileResponse,
    StreamingResponse,
    PlainTextResponse,
    HTMLResponse,
    RedirectResponse,
    Response,
    JSONResponse,   # ★ 新增：用于 /api/faststart 返回标准 JSON
)
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel

from .we_scan import (
    load_we_config, extract_folders_list, build_folder_tree, scan_workshop_items,
    collect_unassigned_items, find_node_by_path, all_ids_recursive, delete_id_dir,
    create_folder as ws_create_folder, move_items as ws_move_items, delete_folders as ws_delete_folders,
)
from .models import ScanResponse, FolderOut, VideoOut, DeleteRequest, PlaylistRequest, FolderDeleteRequest

# === 可配置路径 ===
WORKSHOP_PATH = os.getenv("WORKSHOP_PATH", "/data/workshop/content/431960")
WE_PATH       = os.getenv("WE_PATH", "/data/wallpaper_engine")
APP_DIR       = os.path.dirname(__file__)
DATA_DIR      = os.path.join(APP_DIR, "data")
os.makedirs(DATA_DIR, exist_ok=True)

# SW 脚本路径（放根路径以便 scope='/' 拦截 /media/preview）
SW_FILE = os.path.join(APP_DIR, "static", "sw.js")

# === 新增：纯音频缓存目录 ===
AUDIO_CACHE_DIR = os.getenv("AUDIO_CACHE_DIR", os.path.join(DATA_DIR, "audio_cache"))
os.makedirs(AUDIO_CACHE_DIR, exist_ok=True)

# === 新增：视频转码缓存目录（用于“强制转码修复”不覆盖原文件，避免触发 Steam 校验） ===
VIDEO_CACHE_DIR = os.getenv("VIDEO_CACHE_DIR", os.path.join(DATA_DIR, "video_cache"))
os.makedirs(VIDEO_CACHE_DIR, exist_ok=True)

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
    # ★ faststart 表（新增）：记录某个创意工坊 ID 是否已 faststart 过
    conn.execute("""
    CREATE TABLE IF NOT EXISTS faststart (
        workshop_id TEXT PRIMARY KEY,
        done        INTEGER NOT NULL DEFAULT 0,
        updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
    )
    """)
    return conn

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

# ★ 新增：文件夹相关的请求模型
class CreateFolderRequest(BaseModel):  # ★ 新增
    parent: str = "/"
    title: str

class MoveRequest(BaseModel):  # ★ 新增
    ids: List[str] = []
    dest_path: str = "/"

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

# ======== ★ 新增：扫描结果内存缓存（TTL，默认 120s）========
SCAN_CACHE_TTL = int(os.getenv("SCAN_CACHE_TTL", "120"))
_SCAN_CACHE = {"ts": 0.0, "folder_roots": None, "id_map": None, "root_unassigned": None, "path_map": None}
_SCAN_LOCK = threading.RLock()

def _scan_state():
  now = time.time()
  with _SCAN_LOCK:
    ok = (_SCAN_CACHE["id_map"] is not None) and (now - _SCAN_CACHE["ts"] <= SCAN_CACHE_TTL)
    if not ok:
      folder_roots = []
      try:
        we_cfg = load_we_config(WE_PATH)
        folders_list = extract_folders_list(we_cfg)
        folder_roots = build_folder_tree(folders_list)
      except Exception:
        folder_roots = []
      id_map = scan_workshop_items(WORKSHOP_PATH)
      root_unassigned = collect_unassigned_items(id_map, folder_roots)

      # ★ 构建子路径级缓存：{ "/A/B": {subfolders, vids, all_vids} }
      def _build_path_map():
        path_map = {}

        def rec(parts: List[str], subfolders, vids):
          # 规范化路径
          path_str = "/" + "/".join(parts) if parts else "/"
          # 聚合所有子孙视频 id（只在构建期做一次）
          all_vids = list(vids)
          for sf in (subfolders or []):
            child_parts = parts + [sf.title]
            child_subfolders, child_vids = find_node_by_path(folder_roots, child_parts)
            # 递归对子路径建映射
            _, _, child_all = rec(child_parts, child_subfolders, child_vids)
            all_vids.extend(child_all)
          path_map[path_str] = {"subfolders": subfolders, "vids": list(vids), "all_vids": all_vids}
          return subfolders, vids, all_vids

        # 根路径
        rec([], folder_roots, root_unassigned[:])
        return path_map

      path_map = _build_path_map()

      _SCAN_CACHE.update(ts=now, folder_roots=folder_roots, id_map=id_map, root_unassigned=root_unassigned, path_map=path_map)
    return _SCAN_CACHE["folder_roots"], _SCAN_CACHE["id_map"], _SCAN_CACHE["root_unassigned"]

# ★ 新增：修改 config.json 后失效扫描缓存（让前端立即看到变化）
def _invalidate_scan_cache():  # ★ 新增
  with _SCAN_LOCK:
    _SCAN_CACHE["ts"] = 0.0
    _SCAN_CACHE["path_map"] = None

@app.post("/api/scan/refresh")
def api_scan_refresh():
  """使扫描缓存失效，下次 /api/scan 将重新扫描文件列表。供前端「刷新」按钮调用。"""
  _invalidate_scan_cache()
  return {"ok": True}

def _build_video_out(id_map, vid_id) -> VideoOut:
  v = id_map[vid_id]
  return VideoOut(
    id=vid_id,
    title=v.title,
    mtime=v.mtime,
    size=v.size,
    rating=v.rating or "",
    preview_url=f"/media/preview/{vid_id}",
    video_url=f"/media/video/{vid_id}",
    workshop_url=f"https://steamcommunity.com/sharedfiles/filedetails/?id={vid_id}" if vid_id.isdigit() and len(vid_id) == 10 else ""
  )

@app.get("/", response_class=HTMLResponse)
def index(request: Request):
  # 给模板一个 cache-bust 参数，避免前端 app.js 被浏览器长期缓存导致功能不更新
  try:
    request.scope["ts"] = str(int(time.time()))
  except Exception:
    request.scope["ts"] = "0"
  return templates.TemplateResponse("index.html", {"request": request})

# ★ 启动异步预扫描（预热缓存）
@app.on_event("startup")
def prewarm_scan():
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
    conn.commit()
    conn.close()
  return {"ok": True, "count": len(ids)}

# ========== 扫描 / 列表 ==========
@app.get("/api/scan")
def api_scan(
  path: str = Query("/", description="形如 /A/B"),
  page: int = Query(1, ge=1),
  per_page: int = Query(45, ge=1, le=500),  # 放宽到 500
  sort_idx: int = Query(0, ge=0, le=5),
  mature_only: bool = Query(False),
  q: str = Query("", description="标题筛选，空格分词，全部包含")
):
  folder_roots, id_map, root_unassigned = _scan_state()

  # 规范化路径 & 直接命中子路径缓存
  parts = [p for p in path.split("/") if p]
  norm_path = ("/" + "/".join(parts)) if parts else "/"
  with _SCAN_LOCK:
    pm = _SCAN_CACHE.get("path_map") or {}
    entry = pm.get(norm_path)

  if entry:
    current_subfolders = entry["subfolders"] or []
    current_item_ids = list(entry["vids"] or [])
    all_item_ids = list(entry["all_vids"] or [])
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
    # 回退时仅在需要时做递归
    all_item_ids = list(current_item_ids) + all_ids_recursive(current_subfolders)

  tokens = [t.casefold() for t in q.split() if t.strip()]
  if tokens:
    base_ids = list(dict.fromkeys(all_item_ids))  # 去重保持顺序
  else:
    base_ids = list(current_item_ids)

  vids: List[str] = []
  for vid in base_ids:
    v = id_map.get(vid)
    if not v:
      continue
    if mature_only and (v.rating or "").lower() != "mature":
      continue
    if tokens:
      title_cf = v.title.casefold()
      if not all(tok in title_cf for tok in tokens):
        continue
    vids.append(vid)

  key, rev = _sort_key(sort_idx)
  vids.sort(key=lambda _id: key(id_map[_id]), reverse=rev)

  folders_out: List[FolderOut] = []
  if not tokens:
    # ★ 激进加速：不再递归统计数量（前端已不显示），统一返回 0
    for sf in current_subfolders:
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
  with_meta: bool = Query(False)
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
    return {"items": [{"id": i, "title": id_map[i].title} for i in vids]}
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
  _invalidate_scan_cache()  # 失效缓存，前端刷新立即可见
  return {"ok": True}

# === 移动所选项目（支持多选）到目标路径；"/" 表示移动到主页 ===
@app.post("/api/move")  # ★ 新增
def api_move(req: MoveRequest):
  ws_move_items(WE_PATH, req.ids or [], req.dest_path or "/")
  _invalidate_scan_cache()
  return {"ok": True, "moved": len(req.ids or [])}

# === 直接删除（危险操作，已在前端加确认框） ===
@app.post("/api/delete")
def api_delete(req: DeleteRequest):
  _, id_map, _ = _scan_state()
  deleted = []
  skipped = []
  for vid in req.ids:
    if vid not in id_map:
      skipped.append(vid); continue
    ok = delete_id_dir(WORKSHOP_PATH, vid)
    if ok: deleted.append(vid)
    else: skipped.append(vid)
  return {"deleted": deleted, "skipped": skipped}

# === 从 config.json 的 folders 结构中删除若干文件夹（不碰物理文件）===
@app.post("/api/folder/delete")
def api_folder_delete(req: FolderDeleteRequest):
  removed = ws_delete_folders(WE_PATH, req.paths or [])
  _invalidate_scan_cache()
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
CHUNK = 8 * 1024 * 1024  # LAN 下更大的块
_range_re = re.compile(r"bytes=(\d*)-(\d*)$")

def _etag_for(path: str) -> str:
  st = os.stat(path)
  return f'W/"{st.st_ino}-{st.st_size}-{int(st.st_mtime)}"'

def _last_modified_str(path: str) -> str:
  st = os.stat(path)
  dt = datetime.utcfromtimestamp(st.st_mtime)
  return dt.strftime("%a, %d %b %Y %H:%M:%S GMT")

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

def _parse_range_header(range_header: str, file_size: int):
  if not range_header:
    return None, None
  if "," in range_header:
    return None, "MULTI"
  m = _range_re.match(range_header.strip())
  if not m:
    return None, "BAD"
  start_s, end_s = m.groups()
  if start_s == "" and end_s == "":
    return None, "BAD"
  if start_s == "":  # bytes=-N
    length = int(end_s or "0")
    if length <= 0:
      return None, "BAD"
    start = max(0, file_size - length)
    end = file_size - 1
  else:
    start = int(start_s)
    end = int(end_s) if end_s else file_size - 1
  if start >= file_size:
    return None, "OUT"
  end = min(end, file_size - 1)
  if start > end:
    return None, "BAD"
  return (start, end), None

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
  key_raw = f"{vid_id}|{int(st.st_mtime)}|{st.st_size}|{s or 0}|{target_fmt or 'orig'}|{q}"
  key_hash = hashlib.sha1(key_raw.encode("utf-8")).hexdigest()[:20]
  out_ext = ".webp" if (target_fmt == "webp") else (".jpg" if target_fmt in ("jpg","jpeg") else (".png" if target_fmt=="png" else _ext_from_mime(src_mime)))
  cache_path = os.path.join(PREVIEW_CACHE_DIR, f"{vid_id}_{key_hash}{out_ext}")
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
      scale = max(s / float(min(w, h)), 1.0)
      new_w, new_h = int(w * scale), int(h * scale)
      if (new_w, new_h) != (w, h):
        img = img.resize((new_w, new_h), Image.LANCZOS)
      # 居中裁切为 s×s
      left = max((img.width - s) // 2, 0)
      top  = max((img.height - s) // 2, 0)
      right = left + s
      bottom = top + s
      img = img.crop((left, top, right, bottom))
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

@app.get("/media/video/{vid_id}")
def media_video(request: Request, vid_id: str):
  _, id_map, _ = _scan_state()
  v = id_map.get(vid_id)
  if not v: raise HTTPException(404)
  src_path = v.video_path
  # ★ 若存在有效的转码缓存，则优先用缓存文件（不覆盖原文件也能在 WebUI 播放）
  cache_path = _get_video_cache_path_if_any(vid_id, src_path)
  path = cache_path or src_path
  file_size = os.path.getsize(path)
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

  range_header = request.headers.get("range")
  rng, err = _parse_range_header(range_header, file_size) if range_header else (None, None)

  if not rng:
    if err == "MULTI" or err in ("BAD", "OUT"):
      return Response(status_code=416, headers={
        "Content-Range": f"bytes */{file_size}",
        "Accept-Ranges": "bytes",
        "ETag": etag,
        "Last-Modified": last_mod,
      })
    return FileResponse(path, media_type=mime, headers={
      "Accept-Ranges": "bytes",
      "ETag": etag,
      "Last-Modified": last_mod,
      "Cache-Control": "public, max-age=31536000, immutable",
    })

  start, end = rng
  length = end - start + 1

  def iterfile():
    with open(path, "rb") as f:
      f.seek(start)
      remaining = length
      while remaining > 0:
        data = f.read(min(CHUNK, remaining))
        if not data: break
        remaining -= len(data)
        yield data

  headers = {
    "Content-Range": f"bytes {start}-{end}/{file_size}",
    "Accept-Ranges": "bytes",
    "Content-Length": str(length),
    "ETag": etag,
    "Last-Modified": last_mod,
    "Cache-Control": "public, max-age=31536000, immutable",
  }
  return StreamingResponse(iterfile(), status_code=206, headers=headers, media_type=mime)

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

  file_size = os.path.getsize(cache_path)
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

  range_header = request.headers.get("range")
  rng, err = _parse_range_header(range_header, file_size) if range_header else (None, None)

  if not rng:
    if err == "MULTI" or err in ("BAD", "OUT"):
      return Response(status_code=416, headers={
        "Content-Range": f"bytes */{file_size}",
        "Accept-Ranges": "bytes",
        "ETag": etag,
        "Last-Modified": last_mod,
      })
    return FileResponse(cache_path, media_type=mime, headers={
      "Accept-Ranges": "bytes",
      "ETag": etag,
      "Last-Modified": last_mod,
      "Cache-Control": "public, max-age=31536000, immutable",
    })

  start, end = rng
  length = end - start + 1

  def iterfile():
    with open(cache_path, "rb") as f:
      f.seek(start)
      remaining = length
      while remaining > 0:
        data = f.read(min(CHUNK, remaining))
        if not data: break
        remaining -= len(data)
        yield data

  headers = {
    "Content-Range": f"bytes {start}-{end}/{file_size}",
    "Accept-Ranges": "bytes",
    "Content-Length": str(length),
    "ETag": etag,
    "Last-Modified": last_mod,
    "Cache-Control": "public, max-age=31536000, immutable",
  }
  return StreamingResponse(iterfile(), status_code=206, headers=headers, media_type=mime)

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
# Service Worker（/sw.js）
# =======================
@app.get("/sw.js")
def service_worker():
  """
  Service Worker 必须在根路径或更高层级，才能覆盖 /media/*。
  这里从 static/sw.js 直出，禁止强缓存以便更新。
  """
  if not os.path.isfile(SW_FILE):
    raise HTTPException(404, detail="sw-not-found")
  return FileResponse(SW_FILE, media_type="application/javascript", headers={
    "Cache-Control": "no-cache",
  })

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
    return templates.TemplateResponse("unsub.html", {"request": request})

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
