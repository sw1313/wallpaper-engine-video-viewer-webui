# watched_api.py
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
import os, sqlite3, threading

DB_PATH = os.environ.get("WATCHED_DB", os.path.join("data", "watched.db"))
os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)

_lock = threading.Lock()

def get_conn():
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.execute("""
    CREATE TABLE IF NOT EXISTS watched (
        id TEXT PRIMARY KEY,
        watched INTEGER NOT NULL DEFAULT 1,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )""")
    return conn

router = APIRouter()

@router.get("/api/watched")
def api_get_watched(ids: str = ""):
    ids_list = [x.strip() for x in ids.split(",") if x.strip()]
    if not ids_list:
        return {"watched": []}
    q = ",".join("?" for _ in ids_list)
    with _lock:
        conn = get_conn()
        rows = conn.execute(f"SELECT id FROM watched WHERE watched=1 AND id IN ({q})", ids_list).fetchall()
        conn.close()
    return {"watched": [r[0] for r in rows]}

class WatchedSet(BaseModel):
    ids: list[str]
    watched: bool = True  # true=设为已播放；false=清除

@router.post("/api/watched")
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
    with _lock:
        conn = get_conn()
        conn.executemany(sql, data)
        conn.commit()
        conn.close()
    return {"ok": True, "count": len(ids)}