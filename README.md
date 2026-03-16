# Wallpaper Engine 视频浏览 WebUI

在浏览器中浏览、播放 Wallpaper Engine 创意工坊视频，目录结构对齐本地 WE 路径，支持后台音频与锁屏/通知栏控制。

## 功能概览

- **目录浏览**：按文件夹层级浏览，支持面包屑与搜索
- **视频播放**：全屏播放、播放列表、进度记忆（watched）
- **后台音频**：切到后台/锁屏后继续播放音频，MediaSession 锁屏与通知栏控制（播放/暂停/上一曲/下一曲/进度条）
- **移动端手势**（手机/平板）：
  - **双指右滑**：返回上一级（目录内返回上一目录；播放器内退出播放并返回来源目录）
  - **双指双击**：锁定/解锁所有触摸操作（防误触，无图标；锁定后仍可用双指右滑或再次双指双击解锁）

## 移动端动态壁纸

可配合 [Lively Wallpapers-With Website](https://play.google.com/store/apps/details?id=com.nuko.livewebwallpaper)（Android）将本 WebUI 的页面设为桌面动态壁纸，从而**无需使用官方 Wallpaper Engine 手动转换壁纸格式、无需官方手机版壁纸引擎、无需在手机本地存储壁纸文件**，即可在手机上使用视频格式的动态壁纸（由服务端流式提供）。

## 环境与配置

| 环境变量 | 说明 | 默认 |
|---------|------|------|
| `WORKSHOP_PATH` | 创意工坊目录 | `/data/workshop/content/431960` |
| `WE_PATH` | Wallpaper Engine 安装/资源根路径 | `/data/wallpaper_engine` |
| `AUDIO_CACHE_DIR` | 抽取音频缓存目录 | `{DATA_DIR}/audio_cache` |
| `VIDEO_CACHE_DIR` | 视频转码缓存目录 | `{DATA_DIR}/video_cache` |
| `WATCHED_DB` | 已播放记录数据库路径 | `{DATA_DIR}/watched.db` |
| `AUDIO_CACHE_MAX_AGE_DAYS` | 音频缓存保留天数 | `14` |
| `AUDIO_CACHE_MAX_TOTAL_MB` | 音频缓存总大小上限（MB） | `4096` |

## 运行

```bash
# 安装依赖后（见项目 requirements 或 pyproject）
uvicorn app.main:app --host 0.0.0.0 --port 8000
```

按需设置 `WORKSHOP_PATH`、`WE_PATH` 等环境变量；数据目录（含 `data/`、`audio_cache`、`video_cache`、`watched.db`）会自动创建。

## 部署（Docker 示例）

```bash
docker build -t wallpaper-webui:latest .
docker run -d \
  -p 8000:8000 \
  -e WORKSHOP_PATH=/data/workshop/content/431960 \
  -e WE_PATH=/data/wallpaper_engine \
  -v /path/to/workshop:/data/workshop/content/431960:ro \
  -v /path/to/wallpaper_engine:/data/wallpaper_engine:ro \
  --name wallpaper-webui \
  wallpaper-webui:latest
```

## 技术说明

- **后端**：FastAPI，提供目录扫描、视频/音频流、转码与缓存、watched API、keepalive 等
- **前端**：单页应用，全屏播放器；切后台时切换为纯音频播放并保活（stall 检测与静默重启），MediaSession 与进度条同步
- **音频**：后台使用独立音频流（`/media/audio/{id}`），时间轴与视频对齐；服务端可对抽取音频做时间戳校验并在需要时转码归零

## 其他

- 取消订阅/移动路径等需配合油猴脚本（如 `wallpaper-engine-video-deduplication.js`）使用，建议在非 Steam 下载场景下操作以避免校验问题。
