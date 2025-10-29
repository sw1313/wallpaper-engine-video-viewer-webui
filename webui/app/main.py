# app/main.py (fs-31 + moov@tail faststart cache + logging + probe + stronger CORS/info headers)
import os, math, mimetypes, re, sqlite3, threading, io, hashlib, struct, subprocess, logging
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
)
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel

from .we_scan import (
    load_we_config, extract_folders_list, build_folder_tree, scan_workshop_items,
    collect_unassigned_items, find_node_by_path, all_ids_recursive, delete_id_dir
)
from .models import ScanResponse, FolderOut, VideoOut, DeleteRequest, PlaylistRequest

# ---------- Logging ----------
LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO").upper()
logging.basicConfig(level=LOG_LEVEL, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("wallpaper-webui")

# === 可配置路径 ===
WORKSHOP_PATH = os.getenv("WORKSHOP_PATH", "/data/workshop/content/431960")
WE_PATH       = os.getenv("WE_PATH", "/data/wallpaper_engine")
APP_DIR       = os.path.dirname(__file__)
DATA_DIR      = os.path.join(APP_DIR, "data")
os.makedirs(DATA_DIR, exist_ok=True)

# ========= watched（服务器端“已播放”持久化） =========
DB_PATH = os.getenv("WATCHED_DB", os.path.join(DATA_DIR, "watched.db"))
os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
_db_lock = threading.Lock()

def _get_conn():
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.execute("""
    CREATE TABLE IF NOT EXISTS watched (
        id TEXT PRIMARY KEY,
        watched INTEGER NOT NULL DEFAULT 1,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
    """)
    return conn

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

# ========= faststart 转码缓存 =========
TRANSCODE_CACHE_DIR = os.getenv("TRANSCODE_CACHE_DIR", os.path.join(DATA_DIR, "transcode_cache"))
os.makedirs(TRANSCODE_CACHE_DIR, exist_ok=True)
logger.info("TRANSCODE_CACHE_DIR = %s", TRANSCODE_CACHE_DIR)
_transcode_locks = {}
_transcode_global_lock = threading.Lock()

def _get_transcode_lock(path: str) -> threading.Lock:
    with _transcode_global_lock:
        if path not in _transcode_locks:
            _transcode_locks[path] = threading.Lock()
        return _transcode_locks[path]

# ========= FastAPI 应用 =========
app = FastAPI(title="Wallpaper WebUI")
app.mount("/static", StaticFiles(directory=os.path.join(os.path.dirname(__file__), "static")), name="static")
templates = Jinja2Templates(directory=os.path.join(os.path.dirname(__file__), "templates"))

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
# 工具：容器与编解码嗅探（+尾部扫描）
# =======================
def _sniff_container_mime(path: str) -> Tuple[str|None, str, str]:
  try:
    with open(path, "rb") as f:
      b = f.read(4096)
  except Exception:
    return None, "unknown", "open-failed"
  if len(b) < 12:
    return None, "unknown", "too-short"

  # Matroska / WebM (EBML)
  if b.startswith(b"\x1a\x45\xdf\xa3"):
    low = b.lower()
    if b"webm" in low:      return "video/webm", "webm", "ebml-webm"
    if b"matroska" in low:  return "video/x-matroska", "matroska", "ebml-matroska"
    return "video/x-matroska", "matroska", "ebml"

  # MP4 / QuickTime ('ftyp')
  if b[4:8] == b"ftyp" or b"ftyp" in b[:64]:
    brand = b[8:12]
    if brand == b"qt  ":
      return "video/quicktime", "mp4", "ftyp-qt"
    return "video/mp4", "mp4", "ftyp"

  if b.startswith(b"RIFF") and b[8:12] == b"AVI ": return "video/x-msvideo", "avi", "riff-avi"
  if b.startswith(b"FLV"):                          return "video/x-flv", "flv", "flv"
  if b.startswith(b"OggS"):                         return "video/ogg", "ogg", "ogg"
  if b.startswith(b"\x47"):                         return "video/mp2t", "ts", "ts"
  if b[:4] == b"\x00\x00\x01\xba":                  return "video/mpeg", "ps", "ps"

  return mimetypes.guess_type(path)[0], "unknown", "guess-by-ext"

def _sniff_mp4_codecs(path: str) -> str:
  """扫 mp4 前/后 2MB 常见四字码，返回 'avc1;mp4a' / 'hvc1;ec-3' / 'av01;opus' 等，仅用于调试。"""
  try:
    size = os.path.getsize(path)
    with open(path, "rb") as f:
      head = f.read(min(2 * 1024 * 1024, size))
      tail = b""
      if size > 2 * 1024 * 1024:
        f.seek(max(0, size - 2 * 1024 * 1024))
        tail = f.read(2 * 1024 * 1024)
      blob = head + tail
  except Exception:
    return ""
  video_marks = [b"avc1", b"hvc1", b"hev1", b"av01", b"vp09", b"vp08"]
  audio_marks = [b"mp4a", b"ac-3", b"ec-3", b"opus", b"alac", b"flac"]
  vids = sorted({m.decode() for m in video_marks if m in blob})
  auds = sorted({m.decode() for m in audio_marks if m in blob})
  parts = []
  if vids: parts.append(",".join(vids))
  if auds: parts.append(",".join(auds))
  return ";".join(parts)

# =======================
# MP4 moov 尾部检测 & faststart 缓存
# =======================
def _moov_atom_end_offset(path: str) -> int | None:
  """返回 moov atom 的结束偏移（end-exclusive），遍历顶层 atoms（支持 32/64-bit size）。"""
  try:
    with open(path, "rb") as f:
      file_size = os.path.getsize(path)
      offset = 0
      while offset + 8 <= file_size:
        f.seek(offset)
        header = f.read(8)
        if len(header) < 8:
          return None
        size32, atype = struct.unpack(">I4s", header)
        try:
          atype = atype.decode("ascii")
        except Exception:
          atype = ""
        if size32 == 0:
          offset_next = file_size
        elif size32 == 1:
          ext = f.read(8)
          if len(ext) < 8:
            return None
          (size64,) = struct.unpack(">Q", ext)
          offset_next = offset + size64
        else:
          offset_next = offset + size32
        if atype == "moov":
          return offset_next
        if offset_next <= offset or offset_next > file_size:
          return None
        offset = offset_next
  except Exception:
    return None
  return None

def _moov_at_end(path: str, tolerance: int = 4 * 1024 * 1024) -> bool:
  """
  True → moov 在尾部（EOF 前 <= tolerance 字节）。
  False → moov 不在尾部 / 未能解析（不触发 faststart）。
  """
  moov_end = _moov_atom_end_offset(path)
  if moov_end is None:
    logger.debug("[faststart] moov not found/parse failed: %s", path)
    return False
  file_size = os.path.getsize(path)
  tail = file_size - moov_end
  logger.debug("[faststart] moov_end=%d, file=%d, tail=%d", moov_end, file_size, tail)
  return tail >= 0 and tail <= tolerance

def _faststart_cached_path(src_path: str) -> str | None:
  """
  若需 faststart（moov 在尾部）→ 生成/返回缓存路径；否则返回 None。
  具备：并发互斥、双检、原子落盘、失败回退、详细日志。
  """
  low = src_path.lower()
  if not (low.endswith(".mp4") or low.endswith(".m4v") or low.endswith(".mov") or low.endswith(".qt")):
    logger.debug("[faststart] skip (ext not mp4/m4v/mov/qt): %s", src_path)
    return None

  try:
    need_faststart = _moov_at_end(src_path)  # True => 需要 faststart
  except Exception as e:
    logger.warning("[faststart] moov check error: %s [%s]", src_path, e)
    return None

  logger.info("[faststart] %s need_faststart=%s", src_path, need_faststart)
  if not need_faststart:
    return None

  # 缓存 key
  try:
    st = os.stat(src_path)
    key_raw = f"{os.path.basename(src_path)}|{st.st_ino}|{st.st_size}|{int(st.st_mtime)}"
  except Exception:
    key_raw = f"{os.path.basename(src_path)}|{os.path.getsize(src_path)}|{int(os.path.getmtime(src_path))}"
  key = hashlib.sha1(key_raw.encode("utf-8")).hexdigest()[:20]
  cache_path = os.path.join(TRANSCODE_CACHE_DIR, f"{key}.mp4")
  tmp_path = cache_path + ".tmp"

  if os.path.isfile(cache_path):
    logger.info("[faststart] cache hit: %s", cache_path)
    return cache_path

  lock = _get_transcode_lock(cache_path)
  with lock:
    if os.path.isfile(cache_path):
      logger.info("[faststart] cache hit(after-lock): %s", cache_path)
      return cache_path

    # 检查 ffmpeg
    try:
      subprocess.run(["ffmpeg", "-version"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
    except Exception:
      logger.warning("[faststart] ffmpeg not found; skip faststart for %s", src_path)
      return None

    Path(cache_path).parent.mkdir(parents=True, exist_ok=True)
    cmd = [
      "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
      "-i", src_path,
      "-c", "copy",
      "-movflags", "+faststart",
      tmp_path
    ]
    logger.info("[faststart] running: %s", " ".join(cmd))
    try:
      subprocess.run(cmd, check=True)
      os.replace(tmp_path, cache_path)
      logger.info("[faststart] success -> %s", cache_path)
      return cache_path
    except subprocess.CalledProcessError as e:
      logger.error("[faststart] ffmpeg failed(code=%s) for %s", getattr(e, "returncode", "?"), src_path)
      try:
        if os.path.exists(tmp_path): os.remove(tmp_path)
      except Exception:
        pass
      return None
    except Exception as e:
      logger.error("[faststart] unexpected error: %s", e)
      try:
        if os.path.exists(tmp_path): os.remove(tmp_path)
      except Exception:
        pass
      return None

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

# ======= 预览图（保持你原始逻辑，略） =======
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
  from PIL import Image, ImageSequence
  _, id_map, _ = _scan_state()
  v = id_map.get(vid_id)
  if not v: raise HTTPException(404)
  src_path = v.preview_path

  src_mime, _ = mimetypes.guess_type(src_path)
  src_mime = src_mime or "image/gif"
  src_etag = _etag_for(src_path)
  last_mod = _last_modified_str(src_path)

  want_auto = (fmt is None or fmt == "auto")
  target_fmt = None
  if want_auto:
    target_fmt = "webp" if _client_supports_webp(request) else None
  else:
    f = (fmt or "").lower().strip()
    if f in ("webp","jpeg","jpg","png"): target_fmt = "jpg" if f=="jpg" else f
    else: target_fmt = None

  need_resize = s is not None
  need_transcode = target_fmt is not None and not src_mime.endswith(target_fmt)

  if not need_resize and not need_transcode:
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

  st = os.stat(src_path)
  key_raw = f"{vid_id}|{int(st.st_mtime)}|{st.st_size}|{s or 0}|{target_fmt or 'orig'}|{q}"
  key_hash = hashlib.sha1(key_raw.encode("utf-8")).hexdigest()[:20]
  out_ext = ".webp" if (target_fmt == "webp") else (".jpg" if target_fmt in ("jpg","jpeg") else (".png" if target_fmt=="png" else _ext_from_mime(src_mime)))
  cache_path = os.path.join(PREVIEW_CACHE_DIR, f"{vid_id}_{key_hash}{out_ext}")
  etag = f'W/"prev-{key_hash}"'

  inm = request.headers.get("if-none-match")
  if inm == etag and os.path.isfile(cache_path):
    return Response(status_code=304, headers={
      "ETag": etag, "Last-Modified": last_mod,
      "Cache-Control": "public, max-age=31536000, immutable",
      "Vary": "Accept",
    })

  if os.path.isfile(cache_path):
    mime = mimetypes.guess_type(cache_path)[0] or "image/webp"
    return FileResponse(cache_path, media_type=mime, headers={
      "ETag": etag, "Last-Modified": last_mod,
      "Cache-Control": "public, max-age=31536000, immutable",
      "Vary": "Accept",
    })

  lock = _get_cache_lock(cache_path)
  with lock:
    if os.path.isfile(cache_path):
      mime = mimetypes.guess_type(cache_path)[0] or "image/webp"
      return FileResponse(cache_path, media_type=mime, headers={
        "ETag": etag, "Last-Modified": last_mod,
        "Cache-Control": "public, max-age=31536000, immutable",
        "Vary": "Accept",
      })

    try:
      im = Image.open(src_path)
    except Exception:
      return FileResponse(src_path, media_type=src_mime, headers={
        "ETag": src_etag, "Last-Modified": last_mod,
        "Cache-Control": "public, max-age=31536000, immutable",
        "Vary": "Accept",
      })

    is_animated = getattr(im, "is_animated", False) and getattr(im, "n_frames", 1) > 1

    def _resize_square(img):
      if not s: return img
      w, h = img.size
      if w == 0 or h == 0: return img
      scale = max(s / float(min(w, h)), 1.0)
      new_w, new_h = int(w * scale), int(h * scale)
      if (new_w, new_h) != (w, h):
        img = img.resize((new_w, new_h), Image.LANCZOS)
      left = max((img.width - s) // 2, 0)
      top  = max((img.height - s) // 2, 0)
      img = img.crop((left, top, left + s, top + s))
      return img

    tmp_path = cache_path + ".tmp"

    try:
      if is_animated and (target_fmt == "webp"):
        from PIL import ImageSequence
        frames = []; durations = []
        try:
          for f in ImageSequence.Iterator(im):
            frame = f.convert("RGBA"); frame = _resize_square(frame)
            frames.append(frame); durations.append(f.info.get("duration", im.info.get("duration", 40)))
        except Exception:
          frame = im.convert("RGBA"); frame = _resize_square(frame)
          frames = [frame]; durations = [im.info.get("duration", 40)]
        frames[0].save(tmp_path, format="WEBP", save_all=True,
                       append_images=frames[1:] if len(frames)>1 else None,
                       duration=durations, loop=0, quality=q, method=6)
      else:
        fmt_out = ("WEBP" if target_fmt == "webp" else
                   "JPEG" if target_fmt in ("jpg","jpeg") else
                   "PNG"  if target_fmt == "png" else None)
        base = im.convert("RGBA") if im.mode not in ("RGB","RGBA") else im
        base = _resize_square(base) if s else base
        save_kwargs = {}
        if fmt_out == "JPEG":
          base = base.convert("RGB")
          save_kwargs.update(dict(quality=q, progressive=True, optimize=True))
        elif fmt_out == "WEBP":
          save_kwargs.update(dict(quality=q, method=6))
        elif fmt_out == "PNG":
          save_kwargs.update(dict(optimize=True))
        out_fmt_final = fmt_out or (im.format if im.format in ("PNG","JPEG","WEBP","GIF") else "PNG")
        base.save(tmp_path, format=out_fmt_final, **save_kwargs)
      os.replace(tmp_path, cache_path)
      mime = mimetypes.guess_type(cache_path)[0] or "image/webp"
      return FileResponse(cache_path, media_type=mime, headers={
        "ETag": etag, "Last-Modified": last_mod,
        "Cache-Control": "public, max-age=31536000, immutable",
        "Vary": "Accept",
      })
    except Exception:
      try:
        if os.path.exists(tmp_path): os.remove(tmp_path)
      except Exception:
        pass
      return FileResponse(src_path, media_type=src_mime, headers={
        "ETag": src_etag, "Last-Modified": last_mod,
        "Cache-Control": "public, max-age=31536000, immutable",
        "Vary": "Accept",
      })

# ========== 调试接口 ==========
@app.get("/__probe/{vid_id}")
def probe_container(vid_id: str):
  _, id_map, _ = _scan_state()
  v = id_map.get(vid_id)
  if not v: raise HTTPException(404)
  p = v.video_path
  sniff_mime, container, how = _sniff_container_mime(p)
  st = os.stat(p)
  return {
    "id": vid_id,
    "path": p,
    "size": st.st_size,
    "mtime": int(st.st_mtime),
    "ext": os.path.splitext(p)[1].lower(),
    "sniff_mime": sniff_mime,
    "container": container,
    "how": how,
  }

@app.get("/__probe_codecs/{vid_id}")
def probe_codecs(vid_id: str):
  _, id_map, _ = _scan_state()
  v = id_map.get(vid_id)
  if not v: raise HTTPException(404)
  p = v.video_path
  codecs = _sniff_mp4_codecs(p)
  return {"id": vid_id, "codecs": codecs}

@app.get("/__faststart_status/{vid_id}")
def faststart_status(vid_id: str):
  _, id_map, _ = _scan_state()
  v = id_map.get(vid_id)
  if not v: raise HTTPException(404)
  p = v.video_path
  try:
    need = _moov_at_end(p)
  except Exception:
    need = False
  cache = _faststart_cached_path(p) if need else None
  return {"id": vid_id, "path": p, "need_faststart": bool(need), "cache_path": cache or ""}

# ======= 视频：GET（含 faststart 缓存 + 统一头） =======
def _video_common_heads(mime: str, extra: dict | None = None):
  heads = {
    "Cache-Control": "public, max-age=31536000, immutable",
    "Accept-Ranges": "bytes",
    "Cross-Origin-Resource-Policy": "cross-origin",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Expose-Headers": "Accept-Ranges, Content-Range, Content-Disposition, ETag, Last-Modified, X-Video-Container, X-Video-Mime, X-Video-Codecs, Cross-Origin-Resource-Policy",
    "Content-Type": mime,
    "Vary": "Origin",
  }
  if extra: heads.update(extra)
  return heads

@app.get("/media/video/{vid_id}")
def media_video(request: Request, vid_id: str):
  """
  1) 若 moov 在尾部 → 生成/命中 faststart 缓存并播放；
  2) 统一返回 CORS/调试头；支持 304 / 416 / 200 / 206。
  """
  _, id_map, _ = _scan_state()
  v = id_map.get(vid_id)
  if not v:
    raise HTTPException(404)
  orig_path = v.video_path

  path = _faststart_cached_path(orig_path) or orig_path
  if path != orig_path:
    logger.info("[media_video] using faststart cache for %s -> %s", orig_path, path)

  file_size = os.path.getsize(path)
  sniff_mime, container, _how = _sniff_container_mime(path)
  mime = sniff_mime or (mimetypes.guess_type(path)[0]) or "application/octet-stream"
  codecs_hint = _sniff_mp4_codecs(path)

  etag = _etag_for(path)
  last_mod = _last_modified_str(path)

  # 304
  inm = request.headers.get("if-none-match")
  ims = request.headers.get("if-modified-since")
  if inm == etag:
    heads = _video_common_heads(mime, {
      "ETag": etag, "Last-Modified": last_mod,
      "X-Video-Container": container, "X-Video-Mime": mime, "X-Video-Codecs": codecs_hint or "",
    })
    return Response(status_code=304, headers=heads)
  if ims:
    try:
      ims_dt = parsedate_to_datetime(ims)
      if int(os.stat(path).st_mtime) <= int(ims_dt.timestamp()):
        heads = _video_common_heads(mime, {
          "ETag": etag, "Last-Modified": last_mod,
          "X-Video-Container": container, "X-Video-Mime": mime, "X-Video-Codecs": codecs_hint or "",
        })
        return Response(status_code=304, headers=heads)
    except Exception:
      pass

  # Range
  range_header = request.headers.get("range")
  rng, err = _parse_range_header(range_header, file_size) if range_header else (None, None)

  if not rng:
    if err in ("MULTI", "BAD", "OUT"):
      heads = _video_common_heads(mime, {
        "ETag": etag, "Last-Modified": last_mod,
        "Content-Range": f"bytes */{file_size}",
        "X-Video-Container": container, "X-Video-Mime": mime, "X-Video-Codecs": codecs_hint or "",
      })
      return Response(status_code=416, headers=heads)

    heads = _video_common_heads(mime, {
      "ETag": etag, "Last-Modified": last_mod,
      "X-Video-Container": container, "X-Video-Mime": mime, "X-Video-Codecs": codecs_hint or "",
    })
    return FileResponse(path, media_type=mime, headers=heads)

  # 206
  start, end = rng
  length = end - start + 1
  heads = _video_common_heads(mime, {
    "ETag": etag, "Last-Modified": last_mod,
    "Content-Range": f"bytes {start}-{end}/{file_size}",
    "Content-Length": str(length),
    "X-Video-Container": container, "X-Video-Mime": mime, "X-Video-Codecs": codecs_hint or "",
  })

  def iterfile():
    with open(path, "rb") as f:
      f.seek(start)
      remaining = length
      while remaining > 0:
        data = f.read(min(CHUNK, remaining))
        if not data: break
        remaining -= len(data)
        yield data

  return StreamingResponse(iterfile(), status_code=206, headers=heads, media_type=mime)

# OPTIONS（调试）
@app.options("/media/video/{vid_id}")
def media_video_options(vid_id: str):
  return PlainTextResponse("OK", headers={
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "Accept, Accept-Encoding, Accept-Language, Content-Language, Content-Type, If-Modified-Since, If-None-Match, Origin, Range, User-Agent",
    "Access-Control-Max-Age": "600",
    "Access-Control-Expose-Headers": "Accept-Ranges, Content-Range, Content-Disposition, ETag, Last-Modified, X-Video-Container, X-Video-Mime, X-Video-Codecs, Cross-Origin-Resource-Policy",
  })

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
    "workshop_has_digit_dirs": work_has_dirs,
    "TRANSCODE_CACHE_DIR": TRANSCODE_CACHE_DIR,
    "LOG_LEVEL": LOG_LEVEL,
  }