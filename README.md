# Wallpaper Engine 视频浏览 WebUI

在浏览器里浏览和播放 Wallpaper Engine 创意工坊视频。后端按 Wallpaper Engine 的 `config.json` 和 Workshop 目录扫描资源，前端提供目录浏览、全屏播放、随机播放、断点续播、后台音频保活和移动端动态壁纸模式。

当前视频播放走 **后端 HLS 切片 + HLS.js**：第一次播放时由 `ffmpeg` 把原视频 remux 成 `m3u8 + ts` 段，浏览器之后按段加载，seek 到未缓存位置也会重新拉对应切片。常见 H.264/AAC MP4 走 `-c copy`，不重新编码；只有 copy 失败时才按配置 fallback 到 NVENC/QSV/CPU 转码。

## 功能概览

- **目录浏览**：按 Wallpaper Engine 文件夹层级展示，支持面包屑、搜索、排序、分页/无限滚动。
- **播放列表**：支持当前目录、文件夹递归、多选、未完成项目播放，以及带历史降权的随机播放。
- **断点续播**：服务端 SQLite 保存进度；播放超过阈值后自动标记已看并清除进度。
- **移动端后台音频**：手机切到后台/锁屏后用独立音频流保持播放，支持 MediaSession 通知栏控制和进度条同步；桌面浏览器保持视频播放模式。
- **HLS 视频播放**：Chrome/Edge/Firefox/Android 使用 HLS.js；Safari/iOS 使用原生 HLS；极端情况下回退原 MP4。
- **媒体修复**：支持 faststart 无损重封装、按需 repair/reencode 缓存，不直接覆盖 Steam Workshop 原始文件的转码缓存。
- **资源管理**：支持标记已看/未看、移动项目到文件夹、新建/删除文件夹、删除本地项目/Workshop 项目。
- **移动端手势**：双指右滑返回；双指双击锁定/解锁触摸操作，适合壁纸 WebView 防误触。

## 移动端动态壁纸

可配合 [Lively Wallpapers-With Website](https://play.google.com/store/apps/details?id=com.nuko.livewebwallpaper) 等 Android Web 壁纸应用，把本 WebUI 页面设为桌面动态壁纸。这样无需使用官方 Wallpaper Engine 转换壁纸格式，也无需在手机本地保存视频文件。

壁纸模式通过 URL 参数控制：

- `?wallpaper=1`：离开桌面时静音，时间轴继续推进。
- `?wallpaper=2`：离开桌面时暂停，回到桌面后恢复。

示例：

```text
http://你的NAS:8066/?wallpaper=1
```

## Docker 部署

先在项目目录重新构建镜像：

```bash
docker build -t wallpaper-webui:latest .
```

NAS 示例，包含 NVIDIA 独显和 Intel 核显透传：

```bash
docker rm -f wallpaper-webui

docker run -d \
  --name wallpaper-webui \
  -p 8066:8066 \
  --gpus all \
  --device /dev/dri:/dev/dri \
  -v /path/to/wallpaper_engine:/data/wallpaper_engine:rw \
  -v /path/to/workshop/content/431960:/data/workshop/content/431960:rw \
  -v /path/to/wallpaper-webui-data:/app/app:rw \
  -e HLS_TRANSCODE_FALLBACK=auto \
  --restart unless-stopped \
  wallpaper-webui:latest
```

说明：

- `--gpus all` 用于 NVIDIA NVENC fallback。需要宿主机 Docker 已支持 NVIDIA runtime。
- `--device /dev/dri:/dev/dri` 用于 Intel iGPU QSV fallback。
- 默认容器内以 root 运行，一般不需要 `--group-add video` 或 `--group-add render`。如果改成非 root 用户再考虑按宿主机 GID 追加权限。
- `wallpaper_engine` 和 `workshop` 建议挂 `rw`，否则移动、删除、faststart 修复等写操作无法工作。只浏览播放时可改 `ro`。
- `/app/app` 建议挂到持久化目录，里面会保存 `data/`、SQLite、音频缓存、HLS 切片缓存和修复缓存。

访问：

```text
http://你的NAS:8066/
```

## GPU 验证

进入容器检查 NVIDIA：

```bash
docker exec wallpaper-webui nvidia-smi
```

检查 Intel VAAPI/QSV：

```bash
docker exec wallpaper-webui vainfo
```

检查 ffmpeg 硬件编码器：

```bash
docker exec wallpaper-webui sh -lc 'ffmpeg -hide_banner -encoders 2>/dev/null | grep -E "nvenc|qsv|vaapi"'
```

注意：常见 MP4 会优先走 `-c copy`，这时不会占用 GPU。只有视频/音频编码无法直接放进 HLS TS 容器时，才会触发 `nvenc`、`qsv` 或 `libx264` fallback。

## 本地运行

需要 Python 3.11+ 和系统 `ffmpeg`：

```bash
pip install fastapi "uvicorn[standard]" jinja2 pillow pydantic
uvicorn app.main:app --host 0.0.0.0 --port 8066 --proxy-headers --no-access-log
```

本地以包方式运行时，当前目录需要能作为 `app` 包被导入；Docker 里会把项目复制到 `/app/app` 并创建 `__init__.py`。

## 环境变量

| 环境变量 | 说明 | 默认值 |
| --- | --- | --- |
| `WORKSHOP_PATH` | Steam Workshop `431960` 目录 | `/data/workshop/content/431960` |
| `WE_PATH` | Wallpaper Engine 安装/资源根目录 | `/data/wallpaper_engine` |
| `WATCHED_DB` | 已看和播放进度 SQLite 路径 | `{DATA_DIR}/watched.db` |
| `AUDIO_CACHE_DIR` | 后台音频抽取缓存目录 | `{DATA_DIR}/audio_cache` |
| `AUDIO_CACHE_MAX_AGE_DAYS` | 音频缓存保留天数 | `14` |
| `AUDIO_CACHE_MAX_TOTAL_MB` | 音频缓存总大小上限 | `4096` |
| `VIDEO_CACHE_DIR` | repair/reencode 视频缓存目录 | `{DATA_DIR}/video_cache` |
| `HLS_CACHE_DIR` | HLS 切片缓存目录 | `{DATA_DIR}/hls_cache` |
| `HLS_SEGMENT_SEC` | HLS 每段目标时长，实际会按 GOP 对齐 | `6` |
| `HLS_CACHE_MAX_TOTAL_GB` | HLS 缓存总大小上限，超过后按 LRU 清理 | `20` |
| `HLS_CACHE_MAX_AGE_DAYS` | HLS 缓存最长保留天数 | `30` |
| `HLS_TRANSCODE_FALLBACK` | `copy` 失败后的转码策略 | `auto` |
| `HLS_START_WAIT_SEC` | 请求目标分片时等待 ffmpeg 产出该分片的最长秒数 | `90` |
| `HLS_PLAYLIST_PRIME_SEGMENTS` | 首次请求 playlist 时预热等待的分片数量，设为 `0` 可关闭 | `3` |
| `HLS_PLAYLIST_PRIME_WAIT_SEC` | 首次请求 playlist 时预热等待的最长秒数，超时不终止后台切片 | `6` |
| `PROGRESS_COMPLETE_RATIO` | 超过总时长多少比例视为看完 | `0.90` |
| `PROGRESS_START_RATIO` | 小于总时长多少比例不保存进度 | `0.05` |
| `PROGRESS_MIN_POSITION_SEC` | 保存进度的最低秒数 | `5` |
| `PREWARM_MAX_BYTES` | 原 MP4 Range 路径的 page cache 预热上限 | `2147483648` |

`HLS_TRANSCODE_FALLBACK` 可选值：

| 值 | 行为 |
| --- | --- |
| `auto` | `copy -> nvenc -> qsv -> libx264` |
| `nvenc` | `copy -> NVIDIA NVENC` |
| `qsv` | `copy -> Intel QSV` |
| `libx264` | `copy -> CPU libx264` |
| `none` | 只尝试 `copy`，失败直接报错 |

## 播放链路

视频播放入口仍是前端生成的 `/media/video/{id}`，但现代浏览器会被自动切到 HLS：

1. 前端把 `/media/video/{id}` 转成 `/media/hls/{id}/playlist.m3u8`。
2. 后端首次请求 playlist 时检查 `data/hls_cache/{id}`，并预启动 HLS 切片任务。
3. 缓存不存在或源文件更新后，后端用 `ffmpeg` 生成 `playlist.m3u8` 和 `seg_*.ts`，默认会短暂等待前几个分片完成再返回。
4. HLS.js 按需拉取切片，并保留较长前向缓冲；Safari/iOS 走原生 HLS。
5. 如果 HLS 完全不可用，前端回退到 `/media/video/{id}` 原生 MP4 Range 播放。

第一次播放某个大文件可能会等几秒到几十秒，取决于磁盘速度和是否触发转码。之后同一视频会直接命中 HLS 缓存。

## 主要接口

- `GET /api/scan`：目录扫描、排序、搜索、分页。
- `GET /api/folder_videos`：获取当前文件夹递归视频列表，用于文件夹播放/随机播放。
- `GET /api/watched` / `POST /api/watched`：批量读取和写入已看状态。
- `GET /api/progress` / `POST /api/progress` / `POST /api/progress/clear`：播放进度读写。
- `POST /api/faststart/{id}`：就地无损 faststart 重封装。
- `POST /api/repair/{id}?mode=auto|copy|reencode`：媒体修复或写入视频缓存。
- `GET /media/hls/{id}/playlist.m3u8`：生成/返回 HLS 播放列表。
- `GET /media/hls/{id}/seg_NNNNN.ts`：返回 HLS 切片。
- `GET /media/video/{id}`：原始视频或修复缓存视频的 Range 文件响应。
- `GET /media/audio/{id}`：后台播放用音频流。
- `GET /media/preview/{id}`：封面/预览图。
- `GET /api/diag`：扫描诊断信息。

## 常见问题

### 扫描不到视频

打开页面后如果列表为空，前端会调用 `/api/diag` 显示路径检查。重点确认：

- `WE_PATH` 是否指向 Wallpaper Engine 根目录，并且里面有 `config.json`。
- `WORKSHOP_PATH` 是否指向 `steamapps/workshop/content/431960`。
- Docker 卷挂载路径是否写反，容器内路径必须和环境变量一致。

### 第一次播放很慢

第一次请求 HLS playlist 会预启动切片并短暂等待前几个分片。H.264/AAC MP4 通常只是 remux，主要耗时是磁盘读取；如果 copy 失败并触发转码，会更慢但会缓存结果。第二次播放同一视频应直接命中缓存。

如果希望首次进入更快返回、少等预热，可调小或关闭：

```bash
-e HLS_PLAYLIST_PRIME_SEGMENTS=0
```

### 没看到 GPU 占用

这是正常的。`-c copy` 不需要 GPU。只有 fallback 到 `nvenc` 或 `qsv` 才会看到显卡占用。

### `Unable to find group render`

不用加 `--group-add render`。当前镜像默认 root 运行，通常 `--device /dev/dri:/dev/dri` 就够了。只有改成非 root 运行并遇到权限错误时，再按宿主机实际 GID 处理。

### HLS 缓存太大

调小：

```bash
-e HLS_CACHE_MAX_TOTAL_GB=10
-e HLS_CACHE_MAX_AGE_DAYS=7
```

缓存目录默认在 `/app/app/data/hls_cache`。删除该目录不会影响原视频，只会导致下次播放重新切片。

## 注意事项

- 删除、移动、文件夹修改会写 Wallpaper Engine 配置或删除本地文件，请确认卷挂载和权限。
- `faststart` 是就地覆盖原视频；`repair?mode=reencode` 会写入 `VIDEO_CACHE_DIR`，不会覆盖 Workshop 原文件。
- 不建议同时让 Steam 正在下载/校验同一批 Workshop 文件时执行删除或修复操作。
