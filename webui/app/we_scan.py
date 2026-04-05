# we_scan.py — 最小化修改版（方案2：严格只碰 folders/items）
import hashlib
import os, json, math, re, shutil, threading
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Set, Tuple

MIN_TILE_EDGE = 180

# 与 wallpaper-engine-video-deduplication 对齐：本地 myprojects 视频扩展名
VIDEO_EXTS = {".mp4", ".mkv", ".webm", ".avi", ".mov", ".m4v", ".mpg", ".mpeg"}
IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"}

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
    # config.json 的 items 键：创意工坊为 10 位 id；myprojects / projects/backup 等为 UNC 或相对路径
    we_config_key: str = ""
    # 同一视频在 config 中若出现多条等价键（不同 UNC 前缀），移动时需全部 prune
    we_config_key_aliases: List[str] = field(default_factory=list)

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

def _is_video_relpath(rel: str) -> bool:
    ext = os.path.splitext(rel)[1].lower()
    return ext in VIDEO_EXTS


def extract_projects_relative_path(norm: str) -> Optional[str]:
    """
    从 WE 配置里的路径键中取出 projects/ 之后的相对路径（POSIX）。
    例：//NAS/.../wallpaper_engine/projects/backup/1563525442/xxx.mp4 → backup/1563525442/xxx.mp4
    容器内映射为 WE_PATH/projects/<rel>。
    """
    if not norm:
        return None
    low = norm.replace("\\", "/").lower()
    needle = "/projects/"
    idx = low.find(needle)
    if idx < 0:
        return None
    rest = norm[idx + len(needle) :].lstrip("/").replace("\\", "/")
    return rest or None


def canonical_id_for_projects_file_rel(rel: str) -> str:
    """projects/ 下任意视频文件 → 稳定内部 id（与 Docker/UNC 主机名无关）。"""
    rel = rel.replace("\\", "/").strip("/")
    h = hashlib.sha1(rel.encode("utf-8")).hexdigest()[:20]
    return "p:" + h


def config_item_key_to_canonical_id(raw: str) -> str:
    """
    将 config.json items 的键规范为 WebUI 内部 id：
    - 10 位数字 → 创意工坊 id
    - 路径中含 .../projects/myprojects/... → mp:<直接子文件夹名>
    - 路径中含 .../projects/... 且指向视频文件（如 backup/...）→ p:<hash>
    - 其它键原样返回（兼容未知格式）
    """
    if raw is None:
        return ""
    s = str(raw).strip()
    if not s:
        return s
    if re.fullmatch(r"\d{10}", s):
        return s
    norm = s.replace("\\", "/")
    low = norm.lower()
    key = "myprojects/"
    idx_mp = low.find(key)
    if idx_mp >= 0:
        rest = norm[idx_mp + len(key) :].lstrip("/")
        parts = [p for p in rest.split("/") if p]
        if parts:
            return "mp:" + parts[0]
    rel = extract_projects_relative_path(norm)
    if rel and _is_video_relpath(rel):
        seg0 = rel.split("/")[0].lower() if rel else ""
        if seg0 != "myprojects":
            return canonical_id_for_projects_file_rel(rel)
    return s


def build_folder_tree(folders_list: List[dict]) -> List[FolderNode]:
    def parse_folder(fobj: dict) -> FolderNode:
        title = fobj.get("title", "未命名文件夹")
        items_map = fobj.get("items", {}) or {}
        seen: Set[str] = set()
        items: List[str] = []
        for raw_key in items_map.keys():
            cid = config_item_key_to_canonical_id(str(raw_key))
            if not cid or cid in seen:
                continue
            seen.add(cid)
            items.append(cid)
        subs = [parse_folder(sf) for sf in (fobj.get("subfolders", []) or [])]
        return FolderNode(title=title, items=items, subfolders=subs)
    return [parse_folder(f) for f in folders_list]

def scan_single_workshop_item(workshop_root: str, wid: str) -> Optional[VideoItem]:
    """扫描单个创意工坊项目目录，返回 VideoItem 或 None（非视频/不完整/不存在）。"""
    id_dir = safe_join(workshop_root, wid)
    pj = safe_join(id_dir, "project.json")
    if not os.path.isfile(pj):
        return None
    try:
        with open(pj, "r", encoding="utf-8") as f:
            pdata = json.load(f)
    except Exception:
        return None
    vtype = (pdata.get("type", "") or "").lower()
    if vtype != "video":
        return None
    title = pdata.get("title", wid)
    preview_file = pdata.get("preview", "") or ""
    video_file = pdata.get("file", "") or ""
    rating = pdata.get("contentrating", "") or ""
    preview_path = safe_join(id_dir, preview_file) if preview_file else ""
    video_path = safe_join(id_dir, video_file) if video_file else ""
    if not (preview_path and video_path
            and os.path.isfile(preview_path) and os.path.isfile(video_path)):
        return None
    mtime, size = 0.0, 0
    try:
        st = os.stat(video_path, follow_symlinks=False)
        mtime = getattr(st, "st_mtime", 0.0)
        size = getattr(st, "st_size", 0)
    except Exception:
        pass
    return VideoItem(
        id=wid, title=title,
        preview_path=preview_path, video_path=video_path,
        mtime=mtime, size=size, rating=rating, vtype=vtype,
        we_config_key=wid,
    )


def scan_workshop_items(workshop_root_431960: str) -> Dict[str, VideoItem]:
    """全量扫描 Workshop 目录（仅首次启动时使用，后续由 main 做增量）。"""
    id_map: Dict[str, VideoItem] = {}
    if not os.path.isdir(workshop_root_431960):
        return id_map
    try:
        with os.scandir(workshop_root_431960) as entries:
            for entry in entries:
                if not (entry.is_dir(follow_symlinks=False) and entry.name.isdigit()):
                    continue
                item = scan_single_workshop_item(workshop_root_431960, entry.name)
                if item:
                    id_map[item.id] = item
    except Exception as e:
        print("[we_scan] 扫描异常：", e)
    return id_map


def _we_install_dir_from_cfg(we_cfg: dict) -> str:
    inst = we_cfg.get("?installdirectory")
    if inst is None:
        return ""
    return str(inst).replace("\\", "/").rstrip("/")


def build_we_config_key_for_myproject(install_dir: str, folder_name: str, video_rel: str) -> str:
    video_rel = video_rel.replace("\\", "/").lstrip("/")
    rel = f"projects/myprojects/{folder_name}/{video_rel}"
    if install_dir:
        return install_dir.rstrip("/") + "/" + rel
    return rel


def _first_image_under(root_dir: str) -> str:
    best = ""
    try:
        for dirpath, _, files in os.walk(root_dir):
            for fn in sorted(files):
                ext = os.path.splitext(fn)[1].lower()
                if ext in IMAGE_EXTS:
                    return safe_join(dirpath, fn)
    except Exception:
        pass
    return best


def _pick_primary_video_under(project_dir: str) -> Tuple[str, str]:
    """返回 (绝对路径, 相对 project_dir 的 posix 相对路径)。"""
    cand: List[str] = []
    try:
        for root, _, files in os.walk(project_dir):
            for fn in files:
                ext = os.path.splitext(fn)[1].lower()
                if ext in VIDEO_EXTS:
                    cand.append(safe_join(root, fn))
    except Exception:
        pass
    if not cand:
        return "", ""
    cand.sort()
    vp = cand[0]
    rel = os.path.relpath(vp, project_dir).replace("\\", "/")
    return vp, rel


def scan_single_myproject_item(we_path: str, we_cfg: dict, folder_name: str) -> Optional[VideoItem]:
    """扫描单个 myprojects 子文件夹，返回 VideoItem 或 None。"""
    mp_root = safe_join(we_path, "projects", "myprojects")
    install_dir = _we_install_dir_from_cfg(we_cfg)
    canonical_id = f"mp:{folder_name}"
    id_dir = safe_join(mp_root, folder_name)
    if not os.path.isdir(id_dir):
        return None

    pj = safe_join(id_dir, "project.json")
    title = folder_name
    preview_path = ""
    video_path = ""
    video_rel = ""
    rating = ""
    vtype = "video"

    if os.path.isfile(pj):
        try:
            with open(pj, "r", encoding="utf-8") as f:
                pdata = json.load(f)
        except Exception:
            pdata = {}
        vt = (pdata.get("type", "") or "").lower()
        if vt and vt != "video":
            return None
        title = pdata.get("title", folder_name) or folder_name
        preview_file = pdata.get("preview", "") or ""
        video_file = pdata.get("file", "") or ""
        rating = pdata.get("contentrating", "") or ""
        preview_path = safe_join(id_dir, preview_file) if preview_file else ""
        video_path = safe_join(id_dir, video_file) if video_file else ""
        video_rel = video_file.replace("\\", "/") if video_file else ""
    else:
        video_path, video_rel = _pick_primary_video_under(id_dir)
        if not video_path:
            return None
        title = folder_name
        preview_path = _first_image_under(id_dir)

    if not (video_path and os.path.isfile(video_path)):
        return None
    if not (preview_path and os.path.isfile(preview_path)):
        preview_path = _first_image_under(id_dir)
    if not (preview_path and os.path.isfile(preview_path)):
        return None

    cfg_key = build_we_config_key_for_myproject(install_dir, folder_name, video_rel)
    mtime, size = 0.0, 0
    try:
        st = os.stat(video_path, follow_symlinks=False)
        mtime = getattr(st, "st_mtime", 0.0)
        size = getattr(st, "st_size", 0)
    except Exception:
        pass
    return VideoItem(
        id=canonical_id, title=title,
        preview_path=preview_path, video_path=video_path,
        mtime=mtime, size=size, rating=rating or "", vtype=vtype,
        we_config_key=cfg_key,
    )


def scan_myprojects_items(we_path: str, we_cfg: dict) -> Dict[str, VideoItem]:
    """全量扫描 myprojects 目录（仅首次启动时使用，后续由 main 做增量）。"""
    out: Dict[str, VideoItem] = {}
    mp_root = safe_join(we_path, "projects", "myprojects")
    if not os.path.isdir(mp_root):
        return out
    try:
        with os.scandir(mp_root) as entries:
            for entry in entries:
                if not entry.is_dir(follow_symlinks=False):
                    continue
                fn = entry.name
                if fn.startswith(".") or ".." in fn:
                    continue
                item = scan_single_myproject_item(we_path, we_cfg, fn)
                if item:
                    out[item.id] = item
    except Exception as e:
        print("[we_scan] myprojects 扫描异常：", e)
    return out


def _collect_raw_item_keys_from_folders(nodes: List[dict], out: Set[str]) -> None:
    for n in nodes or []:
        if not isinstance(n, dict):
            continue
        im = n.get("items") or {}
        if isinstance(im, dict):
            for k in im.keys():
                out.add(str(k))
        _collect_raw_item_keys_from_folders(n.get("subfolders") or [], out)


def _first_image_in_dir_flat(dirpath: str) -> str:
    try:
        for fn in sorted(os.listdir(dirpath)):
            p = safe_join(dirpath, fn)
            if os.path.isfile(p) and os.path.splitext(fn)[1].lower() in IMAGE_EXTS:
                return p
    except Exception:
        pass
    return ""


def _preview_for_standalone_video(video_path: str, projects_root: str) -> str:
    """在视频所在目录及向上若干层内找预览图（backup 等目录常见与 mp4 同夹）。"""
    proot = os.path.abspath(projects_root)
    d = os.path.dirname(video_path)
    for _ in range(10):
        ad = os.path.abspath(d)
        if not ad.startswith(proot):
            break
        im = _first_image_in_dir_flat(d)
        if im:
            return im
        parent = os.path.dirname(d)
        if parent == d:
            break
        d = parent
    return _first_image_under(os.path.dirname(video_path))


def _title_for_proj_video(abs_video: str, rel: str) -> str:
    base = os.path.splitext(os.path.basename(abs_video))[0]
    parent = os.path.basename(os.path.dirname(abs_video))
    if parent.isdigit() and len(parent) >= 8:
        return f"{parent} · {base}"
    return base or rel


def _video_metadata_from_project_json(abs_video: str) -> Optional[Tuple[str, str, str, str]]:
    """
    当视频文件与 project.json 同目录，且 json 的 file 指向该视频时，返回与创意工坊扫描一致的元数据：
    (title, preview_abs_path, rating, vtype)。
    preview 使用 json 的 preview 字段；若文件不存在则与同目录兜底图（与 myprojects 逻辑一致）。
    """
    id_dir = os.path.dirname(abs_video)
    pj = safe_join(id_dir, "project.json")
    if not os.path.isfile(pj):
        return None
    try:
        with open(pj, "r", encoding="utf-8") as f:
            pdata = json.load(f)
    except Exception:
        return None
    vtype = (pdata.get("type", "") or "").lower()
    if vtype and vtype != "video":
        return None
    video_file = (pdata.get("file", "") or "").strip()
    if not video_file:
        return None
    vf = video_file.replace("\\", "/")
    resolved = safe_join(id_dir, vf) if not os.path.isabs(video_file) else vf
    try:
        if os.path.normpath(resolved) != os.path.normpath(abs_video):
            return None
    except Exception:
        return None

    title = (pdata.get("title") or "").strip()
    if not title:
        title = os.path.splitext(os.path.basename(abs_video))[0]

    preview_file = (pdata.get("preview", "") or "").strip()
    preview_path = safe_join(id_dir, preview_file) if preview_file else ""
    if not (preview_path and os.path.isfile(preview_path)):
        preview_path = _first_image_under(id_dir)
    if not (preview_path and os.path.isfile(preview_path)):
        return None

    rating = (pdata.get("contentrating", "") or "") or ""
    vtype_out = ((pdata.get("type", "") or "video")).strip().lower() or "video"
    return (title, preview_path, rating, vtype_out)


def scan_config_linked_project_videos(we_path: str, we_cfg: dict) -> Dict[str, VideoItem]:
    """
    从 config.json 的 folders.items 中收集指向 WE projects/ 下视频文件的路径键
    （如 projects/backup/<id>/xxx.mp4，UNC //NAS/.../wallpaper_engine/projects/...），
    在容器内解析为 WE_PATH/projects/<rel>。与 SMB 主机名、盘符无关。
    """
    out: Dict[str, VideoItem] = {}
    folders_list = extract_folders_list(we_cfg)
    raw_keys: Set[str] = set()
    _collect_raw_item_keys_from_folders(folders_list, raw_keys)
    projects_root = safe_join(we_path, "projects")
    if not os.path.isdir(projects_root):
        return out

    for raw in raw_keys:
        s = str(raw).strip()
        if re.fullmatch(r"\d{10}", s):
            continue
        norm = s.replace("\\", "/")
        rel = extract_projects_relative_path(norm)
        if not rel or not _is_video_relpath(rel):
            continue
        seg0 = rel.split("/")[0].lower() if rel else ""
        if seg0 == "myprojects":
            continue
        abs_v = safe_join(projects_root, *rel.split("/"))
        if not os.path.isfile(abs_v):
            continue
        cid = canonical_id_for_projects_file_rel(rel)

        meta = _video_metadata_from_project_json(abs_v)
        if meta:
            title, preview, rating, vtype = meta
        else:
            preview = _preview_for_standalone_video(abs_v, projects_root)
            if not preview or not os.path.isfile(preview):
                continue
            title = _title_for_proj_video(abs_v, rel)
            rating = ""
            vtype = "video"

        mtime, size = 0.0, 0
        try:
            st = os.stat(abs_v, follow_symlinks=False)
            mtime = getattr(st, "st_mtime", 0.0)
            size = getattr(st, "st_size", 0)
        except Exception:
            pass
        if cid in out:
            ex = out[cid]
            if s != ex.we_config_key and s not in ex.we_config_key_aliases:
                ex.we_config_key_aliases.append(s)
            continue
        out[cid] = VideoItem(
            id=cid,
            title=title,
            preview_path=preview,
            video_path=abs_v,
            mtime=mtime,
            size=size,
            rating=rating or "",
            vtype=vtype or "video",
            we_config_key=s,
            we_config_key_aliases=[],
        )
    return out


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


def delete_we_projects_path_video(we_path: str, canonical_id: str, video_abs: str) -> bool:
    """删除 config 引用的 projects/ 下单个视频文件（如 backup 下的 mp4），路径必须在 WE projects/ 内。"""
    if not str(canonical_id or "").startswith("p:"):
        return False
    proot = os.path.abspath(safe_join(we_path, "projects"))
    vp = os.path.abspath(video_abs)
    try:
        if os.path.commonpath([proot, vp]) != proot:
            return False
    except ValueError:
        return False
    if not os.path.isfile(vp):
        return False
    try:
        os.remove(vp)
        return True
    except Exception:
        return False


def delete_myprojects_local_dir(we_path: str, canonical_id: str) -> bool:
    """删除 projects/myprojects/<name> 整个项目夹（canonical_id 形如 mp:<name>）。"""
    cid = str(canonical_id or "")
    if not cid.startswith("mp:"):
        return False
    folder = cid[3:]
    if not folder or any(c in folder for c in ("/", "\\")):
        return False
    base = os.path.abspath(safe_join(we_path, "projects", "myprojects"))
    root = os.path.abspath(safe_join(we_path, "projects", "myprojects", folder))
    try:
        if os.path.commonpath([base, root]) != base:
            return False
    except ValueError:
        return False
    if not os.path.isdir(root):
        return False
    shutil.rmtree(root, ignore_errors=False)
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

def _delete_folder_by_parts(node_list: List[dict], parts: List[str]) -> bool:
    """
    从 folders 树中删除指定路径的 folder 节点（不递归删除其中 items 的 id，只改结构）。
    parts 形如 ["A","B","C"] 对应 /A/B/C。
    返回是否删除了至少一个节点。
    """
    if not parts:
        return False
    name = parts[0]
    deleted = False
    # 最后一段：直接在当前层删除匹配的 folder
    if len(parts) == 1:
        i = 0
        while i < len(node_list):
            f = node_list[i]
            if isinstance(f, dict) and f.get("title") == name:
                node_list.pop(i)
                deleted = True
                continue
            i += 1
        return deleted

    # 还有后续路径：下钻到对应子节点
    for f in node_list:
        if not isinstance(f, dict):
            continue
        if f.get("title") != name:
            continue
        subs = f.get("subfolders") or []
        if _delete_folder_by_parts(subs, parts[1:]):
            deleted = True
            # 如果该 folder 已经没有子文件夹和 items，可选地清理掉
            if not subs and not (f.get("items") or {}):
                try:
                    node_list.remove(f)
                except ValueError:
                    pass
        break
    return deleted

def delete_folders(we_path: str, paths: List[str]) -> int:
    """
    从 config.json 的 folders 树中删除若干路径对应的 folder 节点。
    仅修改结构，不碰 items 对应的 id；由调用方决定是否删除实际视频文件。
    返回成功删除的 folder 数量。
    """
    norm_paths = []
    for p in paths or []:
        p = (p or "").strip()
        if not p or p == "/":
            continue
        parts = [seg for seg in p.split("/") if seg]
        if parts:
            norm_paths.append(parts)
    if not norm_paths:
        return 0

    with _WRITE_LOCK:
        cfg = load_we_config(we_path)
        container, key = _locate_folders_slot(cfg)
        folders = container.setdefault(key, [])

        removed = 0
        for parts in norm_paths:
            if _delete_folder_by_parts(folders, parts):
                removed += 1

        if removed:
            _write_config_atomic_with_backup(we_path, cfg)
        return removed

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

def _primary_config_keys_for_write(ids: List[str], id_map: Optional[Dict[str, VideoItem]]) -> List[str]:
    """移动/写入目标文件夹时，每条目只写一个主键（避免 WE 里出现重复引用）。"""
    out: List[str] = []
    seen: Set[str] = set()
    for i in ids:
        s = str(i)
        v = id_map.get(s) if id_map else None
        k = (getattr(v, "we_config_key", None) or "").strip() if v else ""
        key = k if k else s
        if key not in seen:
            seen.add(key)
            out.append(key)
    return out


def _all_config_keys_for_prune(ids: List[str], id_map: Optional[Dict[str, VideoItem]]) -> List[str]:
    """从树里移除时，主键 + 全部别名都要删掉。"""
    keys: List[str] = []
    seen: Set[str] = set()
    for i in ids:
        s = str(i)
        v = id_map.get(s) if id_map else None
        if v:
            pk = (getattr(v, "we_config_key", None) or "").strip()
            if pk and pk not in seen:
                seen.add(pk)
                keys.append(pk)
            for a in getattr(v, "we_config_key_aliases", None) or []:
                a = str(a).strip()
                if a and a not in seen:
                    seen.add(a)
                    keys.append(a)
        else:
            if s not in seen:
                seen.add(s)
                keys.append(s)
    return keys


def move_items(we_path: str, ids: List[str], dest_path: str, id_map: Optional[Dict[str, VideoItem]] = None) -> None:
    """
    将若干 id 移动到目标路径 dest_path。
    - dest_path="/" 表示移出所有文件夹（保留在主页）
    - 仅修改 folders.items；不写入/覆写其它任何键
    - id_map 用于把 mp:xxx 解析为 WE 使用的路径键（与 ?installdirectory 拼接）
    """
    ids = [str(i) for i in (ids or []) if str(i)]
    if not ids:
        return
    dest_path = (dest_path or "/").strip()
    dest_parts = [p for p in dest_path.split("/") if p]
    prune_keys = _all_config_keys_for_prune(ids, id_map)
    write_keys = _primary_config_keys_for_write(ids, id_map)

    with _WRITE_LOCK:
        cfg = load_we_config(we_path)
        container, key = _locate_folders_slot(cfg)
        folders = container.setdefault(key, [])

        # 1) 全树删掉这些条目（按 config 键匹配）
        _prune_ids(folders, prune_keys)

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
            for k in write_keys:
                items[str(k)] = 1

        _write_config_atomic_with_backup(we_path, cfg)
