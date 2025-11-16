# we_scan.py — 最小化修改版（方案2：严格只碰 folders/items）
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


# =====================================================================
# ★ 基于 config.json 的“新建文件夹 / 移动项目”写操作（带 .bak 备份）
#   方案2：严格只碰 folders/items，不改 UI 状态键
# =====================================================================

_WRITE_LOCK = threading.Lock()

def _cfg_path(we_path: str) -> str:
    return os.path.join(we_path, "config.json")

def _locate_folders_slot(we_cfg: dict) -> Tuple[dict, str]:
    """
    只定位“folders”容器，避免写入/覆盖其它 UI/状态键：
    - 优先使用 general.browser.folders
    - 次选 general.folders
    - 若都不存在，仅在 default.general.browser 下创建 {"folders": []}
    """
    # 仅读取，不 create：不影响不存在的 profile
    for _, profile in we_cfg.items():
        if not isinstance(profile, dict):
            continue
        general = profile.get("general")
        if not isinstance(general, dict):
            continue
        browser = general.get("browser")
        if isinstance(browser, dict) and isinstance(browser.get("folders"), list):
            return browser, "folders"
        folders = general.get("folders")
        if isinstance(folders, list):
            return general, "folders"

    # 安全兜底：只在 default.general.browser 下创建 folders
    default_prof = we_cfg.setdefault("default", {})
    gen = default_prof.setdefault("general", {})
    bro = gen.get("browser")
    if not isinstance(bro, dict):
        bro = {}
        gen["browser"] = bro
    if not isinstance(bro.get("folders"), list):
        bro["folders"] = []
    return bro, "folders"

def _ensure_path(folders_list: List[dict], path_parts: List[str]) -> None:
    """
    确保 /A/B/... 路径逐级存在；不存在则创建占位 folder。
    """
    cur_list = folders_list
    for name in path_parts:
        found = None
        for f in cur_list:
            if isinstance(f, dict) and f.get("title") == name:
                found = f
                break
        if not found:
            found = {"type": "folder", "title": name, "items": {}, "subfolders": []}
            cur_list.append(found)
        cur_list = found.setdefault("subfolders", [])

def _write_config_atomic_with_backup(we_path: str, cfg: dict) -> None:
    """
    写回 config.json（先备份 .bak，再写临时文件，最后原子替换）。
    任一步骤失败会抛出异常；原文件与 .bak 均保留以便手工回滚。
    """
    cfg_file = _cfg_path(we_path)
    tmp_file = cfg_file + ".tmp"
    bak_file = cfg_file + ".bak"

    # 1) 先备份
    try:
        if os.path.isfile(cfg_file):
            shutil.copy2(cfg_file, bak_file)
    except Exception as e:
        # 备份失败也不继续写，避免覆盖原文件
        raise RuntimeError(f"备份 config.json 失败: {e}")

    # 2) 写入临时文件
    with open(tmp_file, "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)

    # 3) 原子替换
    os.replace(tmp_file, cfg_file)

def _prune_ids(node_list: List[dict], ids: List[str]) -> None:
    """
    从整颗 folders 树里移除这些 id（遍历 items 与 subfolders）。
    """
    for f in node_list or []:
        if not isinstance(f, dict):
            continue
        items = f.setdefault("items", {}) or {}
        for i in ids:
            if i in items:
                items.pop(i, None)
        subs = f.get("subfolders") or []
        _prune_ids(subs, ids)

def create_folder(we_path: str, parent_path: str, title: str) -> None:
    """
    在 parent_path 下创建名为 title 的子文件夹。
    parent_path: 形如 "/", "/A", "/A/B"
    """
    parent_path = (parent_path or "/").strip()
    title = (title or "").strip()
    if not title:
        raise ValueError("文件夹名称不能为空")

    parts = [p for p in parent_path.split("/") if p]
    with _WRITE_LOCK:
        cfg = load_we_config(we_path)
        container, key = _locate_folders_slot(cfg)
        folders = container.setdefault(key, [])

        # 确保父级路径存在
        _ensure_path(folders, parts)

        # 下钻到父级 subfolders
        target_list = folders
        for name in parts:
            target = next((x for x in target_list if x.get("title") == name), None)
            if not target:
                target = {"type": "folder", "title": name, "items": {}, "subfolders": []}
                target_list.append(target)
            target_list = target.setdefault("subfolders", [])

        # 如果同名已存在则不重复创建
        exists = next((x for x in target_list if x.get("title") == title), None)
        if not exists:
            target_list.append({"type": "folder", "title": title, "items": {}, "subfolders": []})

        _write_config_atomic_with_backup(we_path, cfg)

def move_items(we_path: str, ids: List[str], dest_path: str) -> None:
    """
    将若干 id 移动到目标路径 dest_path。
    - dest_path="/" 表示移出所有文件夹（保留在主页）
    - 仅修改 folders.items；不写入/覆写其它任何键
    """
    ids = [str(i) for i in (ids or []) if str(i)]
    if not ids:
        return
    dest_path = (dest_path or "/").strip()
    dest_parts = [p for p in dest_path.split("/") if p]

    with _WRITE_LOCK:
        cfg = load_we_config(we_path)
        container, key = _locate_folders_slot(cfg)
        folders = container.setdefault(key, [])

        # 1) 全树删掉这些 id
        _prune_ids(folders, ids)

        # 2) "/" = 主页：不写入任何 folder（即保持未分配状态）
        if dest_path != "/":
            # 确保目标路径存在
            _ensure_path(folders, dest_parts)

            # 找到目标节点
            cur_list = folders
            node = None
            for name in dest_parts:
                node = next((x for x in cur_list if x.get("title") == name), None)
                if not node:
                    node = {"type": "folder", "title": name, "items": {}, "subfolders": []}
                    cur_list.append(node)
                cur_list = node.setdefault("subfolders", [])

            items = node.setdefault("items", {})
            for i in ids:
                items[str(i)] = 1

        _write_config_atomic_with_backup(we_path, cfg)