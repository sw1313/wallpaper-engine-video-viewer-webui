import os, json, math, shutil, time, threading
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Set, Tuple

MIN_TILE_EDGE = 180

@dataclass
class VideoItem:
    id: str
    title: str
    preview_path: str
    video_path: str
    mtime: float
    size: int
    rating: str
    vtype: str

@dataclass
class FolderNode:
    title: str
    items: List[str] = field(default_factory=list)
    subfolders: List['FolderNode'] = field(default_factory=list)

def safe_join(*parts) -> str:
    return os.path.normpath(os.path.join(*parts))

def load_we_config(we_path: str) -> dict:
    cfg_path = os.path.join(we_path, "config.json")
    if not os.path.exists(cfg_path):
        raise FileNotFoundError(f"找不到 config.json: {cfg_path}")
    with open(cfg_path, "r", encoding="utf-8") as f:
        return json.load(f)

def extract_folders_list(we_cfg: dict) -> List[dict]:
    for _, v in we_cfg.items():
        if not isinstance(v, dict):
            continue
        general = v.get("general", {})
        if not isinstance(general, dict):
            continue
        browser = general.get("browser", {})
        folders = []
        if isinstance(browser, dict):
            folders = browser.get("folders", [])
        if not folders:
            folders = general.get("folders", [])
        if isinstance(folders, list) and folders:
            return folders
    return []

def build_folder_tree(folders_list: List[dict]) -> List[FolderNode]:
    def parse_folder(fobj: dict) -> FolderNode:
        title = fobj.get("title", "未命名文件夹")
        items_map = fobj.get("items", {}) or {}
        items = [str(x) for x in items_map.keys()]
        subs = [parse_folder(sf) for sf in (fobj.get("subfolders", []) or [])]
        return FolderNode(title=title, items=items, subfolders=subs)
    return [parse_folder(f) for f in folders_list]

# ====== 新增：扫描结果缓存（默认 300s）======
_SCAN_LOCK = threading.Lock()
_SCAN_CACHE = {"ts": 0.0, "data": {}}
_SCAN_TTL = int(os.getenv("WE_SCAN_CACHE_TTL", "300"))

def scan_workshop_items(workshop_root_431960: str) -> Dict[str, VideoItem]:
    """
    安全、只读地扫描 Workshop 项目并尽量减少磁盘触发：
    - 使用 os.scandir() 列目录（不跟随符号链接）；
    - 仅对视频文件做 os.stat() 获取 mtime/size；
    - 进程内缓存，减少重复触盘。
    """
    now = time.time()
    with _SCAN_LOCK:
        if _SCAN_CACHE["data"] and (now - _SCAN_CACHE["ts"] < _SCAN_TTL):
            # 返回拷贝，避免上层改动影响缓存
            return dict(_SCAN_CACHE["data"])

    id_map: Dict[str, VideoItem] = {}
    if not os.path.isdir(workshop_root_431960):
        return id_map

    try:
        with os.scandir(workshop_root_431960) as entries:
            for entry in entries:
                # 仅处理 10 位数字 ID 目录；不跟随符号链接
                if not (entry.is_dir(follow_symlinks=False) and entry.name.isdigit()):
                    continue

                wid = entry.name
                id_dir = safe_join(workshop_root_431960, wid)
                pj = safe_join(id_dir, "project.json")
                if not os.path.exists(pj):
                    continue

                # 只读读取 project.json（小文件，必要元数据）
                try:
                    with open(pj, "r", encoding="utf-8") as f:
                        pdata = json.load(f)
                except Exception:
                    continue

                vtype = (pdata.get("type", "") or "").lower()
                if vtype != "video":
                    continue

                title = pdata.get("title", wid)
                preview_file = pdata.get("preview", "") or ""
                video_file = pdata.get("file", "") or ""
                rating = pdata.get("contentrating", "") or ""

                preview_path = safe_join(id_dir, preview_file) if preview_file else ""
                video_path = safe_join(id_dir, video_file) if video_file else ""
                if not (preview_path and video_path and os.path.exists(preview_path) and os.path.exists(video_path)):
                    continue

                # 仅用 stat 拿必要元数据；不打开大文件，避免额外触盘
                mtime, size = 0.0, 0
                try:
                    st = os.stat(video_path, follow_symlinks=False)
                    mtime = getattr(st, "st_mtime", 0.0)
                    size = getattr(st, "st_size", 0)
                except Exception:
                    pass

                id_map[wid] = VideoItem(
                    id=wid, title=title,
                    preview_path=preview_path, video_path=video_path,
                    mtime=mtime, size=size, rating=rating, vtype=vtype
                )
    except Exception as e:
        # 扫描失败不抛出，避免影响上层
        print("[we_scan] 扫描异常：", e)

    # 回写缓存
    with _SCAN_LOCK:
        _SCAN_CACHE["ts"] = now
        _SCAN_CACHE["data"] = dict(id_map)

    return id_map

def collect_unassigned_items(id_map: Dict[str, VideoItem], roots: List[FolderNode]) -> List[str]:
    assigned: Set[str] = set()
    def walk(node: FolderNode):
        assigned.update(node.items)
        for sf in node.subfolders:
            walk(sf)
    for r in roots:
        walk(r)
    return sorted([i for i in id_map.keys() if i not in assigned])

def find_node_by_path(roots: List[FolderNode], path_parts: List[str]) -> Tuple[List[FolderNode], List[str]]:
    if not path_parts or path_parts == ['']:
        return roots, []
    cur = roots
    for depth, name in enumerate(path_parts):
        found = next((n for n in cur if n.title == name), None)
        if not found:
            return [], []
        if depth == len(path_parts) - 1:
            return found.subfolders, found.items
        cur = found.subfolders
    return [], []

def all_ids_recursive(nodes: List[FolderNode]) -> List[str]:
    out: List[str] = []
    for n in nodes:
        out.extend(n.items)
        if n.subfolders:
            out.extend(all_ids_recursive(n.subfolders))
    return out

# === 保持真实删除（不可恢复！）===
def delete_id_dir(workshop_root: str, wid: str) -> bool:
    src = safe_join(workshop_root, wid)
    if not (os.path.isdir(src) and wid.isdigit() and len(wid) == 10):
        return False
    shutil.rmtree(src, ignore_errors=False)
    return True