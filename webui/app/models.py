# app/models.py
from pydantic import BaseModel
from typing import List, Optional

class FolderOut(BaseModel):
    title: str
    count: int

class VideoOut(BaseModel):
    id: str
    title: str
    mtime: float
    size: int
    rating: str
    preview_url: str
    video_url: str
    workshop_url: str

class ScanResponse(BaseModel):
    breadcrumb: List[str]
    folders: List[FolderOut]
    videos: List[VideoOut]
    page: int
    total_pages: int
    total_items: int

class DeleteRequest(BaseModel):
    ids: List[str]

class PlaylistRequest(BaseModel):
    ids: List[str]