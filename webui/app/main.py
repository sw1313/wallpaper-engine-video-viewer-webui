# app/main.py (fs-35 audio-direct: add /media/audio/{vid_id} + inplace faststart + keepalive)
import os, math, mimetypes, re, sqlite3, threading, io, hashlib, subprocess, glob, shutil
import time, logging  # ★ 新增：用于 /api/keepalive 时间与日志过滤
from pathlib import Path
from typing import List, Tuple
from datetime import datetime
from email.utils import parsedate_to_datetime

from fastapi import FastAPI, Query, Request, HTTPException
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
    collect_unassigned_items, find_node_by_path, all_ids_recursive, delete_id_dir
)
from .models import ScanResponse, FolderOut, VideoOut, DeleteRequest, PlaylistRequest

# === 可配置路径 ===
WORKSHOP_PATH = os.getenv("WORKSHOP_PATH", "/data/workshop/content/431960")
WE_PATH       = os.getenv("WE_PATH", "/data/wallpaper_engine")
APP_DIR       = os.path.dirname(__file__)
DATA_DIR      = os.path.join(APP_DIR, "data")
os.makedirs(DATA_DIR, exist_ok=True)

# === 新增：纯音频缓存目录 ===
AUDIO_CACHE_DIR = os.getenv("AUDIO_CACHE_DIR", os.path.join(DATA_DIR, "audio_cache"))
os.makedirs(AUDIO_CACHE_DIR, exist_ok=True)

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

def _scan_state():
  folder_roots = []
  try:
    we_cfg = load_we_config(WE_PATH)
    folders_list = extract_folders_list(we_cfg)
    folder_roots = build_folder_tree(folders_list)
  except Exception:
    folder_roots = []
  id_map = scan_workshop_items(WORKSHOP_PATH)
  root_unassigned = collect_unassigned_items(id_map, folder_roots)
  return folder_roots, id_map, root_unassigned

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
  return templates.TemplateResponse("index.html", {"request": request})

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
@app.get("/api/scan", response_model=ScanResponse)
def api_scan(
  path: str = Query("/", description="形如 /A/B"),
  page: int = Query(1, ge=1),
  per_page: int = Query(45, ge=1, le=500),  # 放宽到 500
  sort_idx: int = Query(0, ge=0, le=5),
  mature_only: bool = Query(False),
  q: str = Query("", description="标题筛选，空格分词，全部包含")
):
  folder_roots, id_map, root_unassigned = _scan_state()

  parts = [p for p in path.split("/") if p]
  if not parts:
    current_subfolders = folder_roots
    current_item_ids = root_unassigned[:]
    breadcrumb = []
  else:
    current_subfolders, current_item_ids = find_node_by_path(folder_roots, parts)
    breadcrumb = parts

  tokens = [t.casefold() for t in q.split() if t.strip()]
  if tokens:
    candidate_ids = set(current_item_ids)
    candidate_ids.update(all_ids_recursive(current_subfolders))
    base_ids = list(candidate_ids)
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
    def count_recursive(node) -> int:
      total = len(node.items)
      for sf in node.subfolders:
        total += count_recursive(sf)
      return total
    for sf in current_subfolders:
      folders_out.append(FolderOut(title=sf.title, count=count_recursive(sf)))

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

  return ScanResponse(
    breadcrumb=breadcrumb,
    folders=out_folders,
    videos=out_videos,
    page=page,
    total_pages=total_pages,
    total_items=total_tiles
  )

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

def _faststart_inplace(src_path: str) -> dict:
  """
  无损重封装：-c copy -movflags +faststart
  生成同目录临时文件，成功后 os.replace 覆盖原文件。
  覆盖后恢复原文件的 atime/mtime，避免“修改时间”被刷新。
  返回 {ok, before, after, tmp, out}
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

  force_mp4 = src.suffix.lower() in (".mp4", ".m4v")
  tmp_path = str(src.with_suffix(src.suffix + ".faststart.tmp"))

  cmd = [
      "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
      "-i", src_path,
      "-map", "0", "-dn",
      "-c", "copy",
      "-movflags", "+faststart",
  ]
  if force_mp4:
      cmd += ["-f", "mp4"]
  cmd += [tmp_path]

  lock = _get_repair_lock(src_path)
  with lock:
    try:
      if os.path.exists(tmp_path):
        os.remove(tmp_path)
    except Exception:
      pass

    try:
      subprocess.run(cmd, check=True)
      # 原子替换
      os.replace(tmp_path, src_path)

      # 恢复时间戳（若可用）
      try:
        if at_ns is not None and mt_ns is not None:
          os.utime(src_path, ns=(at_ns, mt_ns))
      except Exception:
        # 回退到秒精度
        try:
          if st_old is not None:
            os.utime(src_path, (st_old.st_atime, st_old.st_mtime))
        except Exception:
          pass

      after = os.path.getsize(src_path)
      return {"ok": True, "before": before, "after": after, "out": src_path}
    except subprocess.CalledProcessError as e:
      try:
        if os.path.exists(tmp_path):
          os.remove(tmp_path)
      except Exception:
        pass
      return {"ok": False, "error": f"ffmpeg-failed:{e}", "path": src_path}
    except Exception as e:
      try:
        if os.path.exists(tmp_path):
          os.remove(tmp_path)
      except Exception:
        pass
      return {"ok": False, "error": f"exception:{e}", "path": src_path}

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
  path = v.video_path
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
  try:
    kp = os.path.abspath(keep_path)
    for p in glob.glob(os.path.join(AUDIO_CACHE_DIR, f"{vid}_*.m4a")):
      try:
        if os.path.abspath(p) != kp:
          os.remove(p)
      except Exception:
        pass
  except Exception:
    pass

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
            ok = True
        except Exception:
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