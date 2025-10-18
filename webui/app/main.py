# app/main.py
import os, math, mimetypes, re
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

from .we_scan import (
    load_we_config, extract_folders_list, build_folder_tree, scan_workshop_items,
    collect_unassigned_items, find_node_by_path, all_ids_recursive, delete_id_dir
)
from .models import ScanResponse, FolderOut, VideoOut, DeleteRequest, PlaylistRequest

WORKSHOP_PATH = os.getenv("WORKSHOP_PATH", "/data/workshop/content/431960")
WE_PATH       = os.getenv("WE_PATH", "/data/wallpaper_engine")

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

# （保留 m3u 接口，但前端已不再使用）
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
# 媒体传输（预览 & 视频）
# =======================

CHUNK = 8 * 1024 * 1024  # LAN 下更大的块，减少 Python 循环与 syscall 次数
_range_re = re.compile(r"bytes=(\d*)-(\d*)$")

def _etag_for(path: str) -> str:
  st = os.stat(path)
  # inode-size-mtime 的弱 ETag（无需读文件）
  return f'W/"{st.st_ino}-{st.st_size}-{int(st.st_mtime)}"'

def _last_modified_str(path: str) -> str:
  st = os.stat(path)
  dt = datetime.utcfromtimestamp(st.st_mtime)
  return dt.strftime("%a, %d %b %Y %H:%M:%S GMT")

def _parse_range_header(range_header: str, file_size: int):
  """支持 bytes=start-, bytes=-N, bytes=start-end；拒绝多段（含逗号）"""
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

@app.get("/media/preview/{vid_id}")
def media_preview(vid_id: str, request: Request):
  _, id_map, _ = _scan_state()
  v = id_map.get(vid_id)
  if not v: raise HTTPException(404)
  path = v.preview_path
  mime, _ = mimetypes.guess_type(path)
  mime = mime or "image/gif"
  etag = _etag_for(path)
  last_mod = _last_modified_str(path)

  # 条件缓存命中 → 304
  inm = request.headers.get("if-none-match")
  ims = request.headers.get("if-modified-since")
  if inm == etag:
    return Response(status_code=304, headers={
      "ETag": etag,
      "Last-Modified": last_mod,
      "Cache-Control": "public, max-age=31536000, immutable",
    })
  if ims:
    try:
      ims_dt = parsedate_to_datetime(ims)
      if int(os.stat(path).st_mtime) <= int(ims_dt.timestamp()):
        return Response(status_code=304, headers={
          "ETag": etag,
          "Last-Modified": last_mod,
          "Cache-Control": "public, max-age=31536000, immutable",
        })
    except Exception:
      pass

  return FileResponse(path, media_type=mime, headers={
    "ETag": etag,
    "Last-Modified": last_mod,
    "Cache-Control": "public, max-age=31536000, immutable",
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

  # 条件缓存（虽然视频一般不会 304 命中，但加上无害且可复用）
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

  # 无 Range：走 FileResponse（更省心，部分 server/平台可走 sendfile 快路径）
  if not rng:
    if err == "MULTI":
      return Response(status_code=416, headers={
        "Content-Range": f"bytes */{file_size}",
        "Accept-Ranges": "bytes",
        "ETag": etag,
        "Last-Modified": last_mod,
      })
    if err in ("BAD", "OUT"):
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

  # 有 Range：单段 206
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