# Wallpaper Engine 视频浏览 WebUI

在浏览器里浏览和播放 Wallpaper Engine 创意工坊视频。后端按 Wallpaper Engine 的 `config.json` 和 Workshop 目录扫描资源，前端提供目录浏览、全屏播放、随机播放、断点续播、后台音频保活和移动端动态壁纸模式。

当前视频播放以 **HLS 为默认路径**（`HLS.js` / Safari 原生 HLS）：首次播放时由 `ffmpeg` 把原视频 remux 或转码成 `m3u8 + ts` 段，浏览器按段加载。常见 H.264/AAC MP4 在条件允许时走 `-c copy`；超大文件、高码率或长 GOP 源会自动跳过 copy，改走带强制关键帧的转码，避免浏览器 MSE OOM。

## 功能概览

- **目录浏览**：按 Wallpaper Engine 文件夹层级展示，支持面包屑、搜索、排序、分页/无限滚动。
- **播放列表**：支持当前目录、文件夹递归、多选、未完成项目播放，以及带历史降权的随机播放。
- **断点续播**：服务端 SQLite 保存进度；播放超过阈值后自动标记已看并清除进度。
- **移动端后台音频**：手机切到后台/锁屏后用独立音频流保持播放，支持 MediaSession 通知栏控制和进度条同步；桌面浏览器保持视频播放模式。
- **智能播放协商**：点击播放时前端上报浏览器能力（MSE、编解码、`deviceMemory`、`performance.memory`），后端 `/api/playback/negotiate` 返回 HLS / 原生 HLS / Direct Play 策略及动态缓冲参数。
- **HLS 视频播放**：Chrome/Edge/Firefox/Android 优先 HLS.js；Safari/iOS 走原生 HLS；HLS 致命失败时回退 MP4 Range。
- **MSE 内存预算**：按 Chrome JS 堆与设备内存估算 SourceBuffer 上限（桌面约 ≤192MB），`bufferAppendError` 时自动收缩并记住；`bufferFullError` 视为正常满缓冲，不 reload。
- **自定义播放器控件**：隐藏浏览器原生 controls，使用服务端探测时长绘制进度条，支持播放/暂停、上一曲/下一曲、音量、静音、画中画、全屏、倍速和移动端横竖屏切换。
- **触屏友好 UI**：深色毛玻璃主题、路径按钮、自定义排序下拉、标题悬浮提示、半透明分级角标和移动端居中播放按钮。
- **媒体修复**：支持 faststart 无损重封装、按需 repair/reencode 缓存，不直接覆盖 Steam Workshop 原始文件的转码缓存。
- **资源管理**：支持标记已看/未看、移动视频/文件夹、新建/删除文件夹、删除本地项目/Workshop 项目。
- **拖拽到文件夹**：从缩略图或 Alt+浮动窗标题栏拖到文件夹 tile；文件夹按路径整体移入（写入 WE `config.json` 的 `folders` 树，不 flatten 视频）；拖到 `…` 表示移到上一层；**双击 Esc** 撤销上一次移动（10 分钟内有效）。
- **浮动预览窗**：Alt+点击视频 tile 打开内嵌小窗；标题栏 `⋯` 等同右键菜单。
- **搜索筛选**：空格分词且全部包含；`a:词` 仅上传者、`t:词` 仅标题、`=词` 全字/整词匹配（可组合，如 `a:=foo t:bar`）。
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

## 示例配置与部署脚本

仓库根目录提供可直接复制的示例文件（**不要**把含密钥的 `runtime.env` / `steam_config.json` 提交进 Git）：

| 文件 | 说明 |
| --- | --- |
| [`runtime.env.example`](runtime.env.example) | **群晖/NAS 推荐**：复制为挂载目录下的 `runtime.env`，改完 `docker restart wallpaper-webui` 即可 |
| [`docker.env.example`](docker.env.example) | `docker compose` 的 `env_file` 参考 |
| [`steam_config.example.json`](steam_config.example.json) | Steam Web API Key 模板（复制为 `steam_config.json`） |
| [`deploy-nas.sh`](deploy-nas.sh) | 群晖上一键构建镜像、rsync 代码、按 GPU 模式启动容器 |

`runtime.env` 读取路径：容器内 `/app/app/runtime.env`（即宿主机挂载目录，例如 `/volume1/docker/wallpaper-webui/runtime.env`）。

```bash
# 群晖 SSH 或任务计划（在仓库目录执行）
cp runtime.env.example runtime.env   # 首次
GPU_MODE=both ./deploy-nas.sh        # cpu | nvidia | intel | both
```

Compose 叠加 GPU（可选）：

```bash
docker compose -f docker-compose.yml -f docker-compose.gpu.yml up -d
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

注意：常见 MP4 在 copy 可行时会优先 remux，这时不会占用 GPU。超大/高码率/长 GOP 源会跳过 copy 并 fallback 到 `nvenc`、`qsv` 或 `libx264`。

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
| `HLS_SEGMENT_SEC` | HLS 每段目标时长，实际会按 GOP 对齐 | `2` |
| `HLS_CACHE_MAX_TOTAL_GB` | HLS 缓存总大小上限，超过后按 LRU 清理 | `20` |
| `HLS_CACHE_MAX_AGE_DAYS` | HLS 缓存最长保留天数 | `30` |
| `HLS_TRANSCODE_FALLBACK` | `copy` 失败后的转码策略 | `auto` |
| `HLS_START_WAIT_SEC` | 请求目标分片时等待 ffmpeg 产出该分片的最长秒数 | `90` |
| `HLS_PLAYLIST_PRIME_SEGMENTS` | 首次请求 playlist 时预热等待的分片数量，设为 `0` 可关闭 | `3` |
| `HLS_PLAYLIST_PRIME_WAIT_SEC` | 首次请求 playlist 时预热等待的最长秒数，超时不终止后台切片 | `6` |
| `HLS_ENCODE_AHEAD_SEC` | ffmpeg 编码进度超前播放头超过此秒数时暂停 job | `60` |
| `HLS_COPY_MAX_SOURCE_BYTES` | 超过此大小的源文件视为 copy risky | `2147483648` |
| `HLS_COPY_MAX_BITRATE_BPS` | 超过此码率视为 copy risky | `30000000` |
| `HLS_HUGE_FILE_BYTES` | 超大文件阈值（用于缓冲策略） | `8589934592` |
| `HLS_MAX_REASONABLE_SEGMENT_BYTES` | 单 TS 段超过此大小视为异常并触发重切 | `134217728` |
| `DIRECT_PLAY_CHUNK_BYTES` | Direct Play MP4 Range 响应块大小 | `131072` |
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

### 1. 播放协商（`/api/playback/negotiate`）

点击播放时，前端采集并上报：

- 是否支持 MSE、是否移动端
- `canPlayType` 探测的 H.264/AAC 支持情况
- `navigator.deviceMemory`、`performance.memory`（Chrome）
- 当前播放位置（用于 ffmpeg 编码节流）

后端结合源文件 `ffprobe` 元数据返回：

| 方法 | 条件 | 行为 |
| --- | --- | --- |
| `hls_js` | 支持 MSE（PC/Android Chrome 等） | HLS.js + 动态 `maxBufferSize` / `maxBufferLength` |
| `native_hls` | 不支持 MSE（iOS Safari） | `<video src=m3u8>`，系统托管缓冲 |
| `direct_play` | 仅作 HLS 失败兜底 | MP4 Range + HEAD 预热 |

### 2. HLS 按需切片

1. 前端请求 `/media/hls/{id}/playlist.m3u8`。
2. 后端检查 `data/hls_cache/{id}`，按需启动 ffmpeg job 生成 `seg_*.ts`。
3. **copy risky**（≥2GB 或 ≥30Mbps 或长 GOP）时跳过 `-c copy`，直接转码并强制关键帧，防止单段 GB 级 TS 撑爆 MSE。
4. 播放进度上报时，若 ffmpeg 编码进度超前播放头超过 `HLS_ENCODE_AHEAD_SEC`，会 kill job 防止临时目录膨胀。
5. HLS.js 按 negotiate 下发的内存预算缓冲；Safari 走原生 HLS。

### 3. Direct Play 兜底

HLS 致命失败时回退 `/media/video/{id}`：

- 支持 `GET` + `HEAD`，Range 块默认 128KB（`DIRECT_PLAY_CHUNK_BYTES`）
- 点击时 HEAD + `Range: bytes=0-0` 预热连接

播放器 UI 不直接信任 HLS/MSE 的动态 `duration`，而是优先使用后端 `ffprobe` 探测出的主视频流时长。自定义缓存条只显示当前播放点所在的连续缓冲段。全屏请求在用户点击后的同步阶段立即发起，避免 HLS attach 耗时导致手势过期。

## 主要接口

- `GET /api/scan`：目录扫描、排序、搜索、分页。搜索参数 `q` 支持 `a:`/`t:`/`=` 字段与全字匹配（见功能概览）。
- `GET /api/folder_videos`：获取当前文件夹递归视频列表，用于文件夹播放/随机播放。
- `GET /api/watched` / `POST /api/watched`：批量读取和写入已看状态。
- `GET /api/progress` / `POST /api/progress` / `POST /api/progress/clear`：播放进度读写。
- `POST /api/playback/negotiate`：播放能力协商，返回 HLS/Direct Play 策略与缓冲配置。
- `POST /api/move`：移动视频 `ids` 和/或文件夹 `folder_paths` 到 `dest_path`（`/`=主页）；**只改 WE `config.json` 的 folders 结构，不移动磁盘文件**。
- `POST /api/folder/create` / `POST /api/folder/delete`：新建/删除文件夹节点。
- `POST /api/faststart/{id}`：就地无损 faststart 重封装。
- `POST /api/repair/{id}?mode=auto|copy|reencode`：媒体修复或写入视频缓存。
- `GET /media/hls/{id}/info`：HLS 源信息（时长、码率、copy risky 等）。
- `GET /media/hls/{id}/debug`：HLS 缓存与 ffmpeg job 诊断。
- `GET /media/hls/{id}/playlist.m3u8`：生成/返回 HLS 播放列表。
- `GET /media/hls/{id}/seg_NNNNN.ts`：返回 HLS 切片。
- `GET|HEAD /media/video/{id}`：原始视频或修复缓存视频的 Range 文件响应。
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

第一次请求 HLS playlist 会预启动切片并短暂等待前几个分片。H.264/AAC MP4 在 copy 可行时通常只是 remux；若 copy risky 会触发转码，首次更慢但会缓存结果。第二次播放同一视频应直接命中缓存。

如果希望首次进入更快返回、少等预热，可调小或关闭：

```bash
-e HLS_PLAYLIST_PRIME_SEGMENTS=0
```

### 大文件播放 OOM 或闪屏

- 默认优先 HLS，超大/高码率文件会跳过 copy remux。
- 前端 MSE 预算桌面约 ≤192MB，由 `deviceMemory` + `performance.memory` 估算。
- Console 可看 `[hls] MSE budget: ... maxBufferSize: ...`。
- 若曾误学错误预算，执行 `sessionStorage.removeItem('mse_budget_learned_v2')` 后硬刷新。
- `bufferFullError` 是正常满缓冲，不应导致闪屏；若仍闪屏请检查是否频繁 reload。

### 进度条时长或缓存显示不对

前端进度条使用 `/media/hls/{id}/info` 返回的服务端探测时长。seek 到未缓存位置后，缓存条只代表目标点附近实际可连续播放的 buffer。

### 没看到 GPU 占用

copy 可行时不会用 GPU。只有 fallback 到 `nvenc` 或 `qsv` 才会看到显卡占用。

### `Unable to find group render`

不用加 `--group-add render`。当前镜像默认 root 运行，通常 `--device /dev/dri:/dev/dri` 就够了。

### HLS 缓存太大

调小：

```bash
-e HLS_CACHE_MAX_TOTAL_GB=10
-e HLS_CACHE_MAX_AGE_DAYS=7
```

缓存目录默认在 `/app/app/data/hls_cache`。删除该目录不会影响原视频，只会导致下次播放重新切片。

## 注意事项

- **移动文件夹/视频**会写 Wallpaper Engine 的 `config.json`（`folders` 树）；不会移动 Workshop 磁盘上的视频文件。误拖后可双击 Esc 撤销（10 分钟内）。
- 删除、faststart 修复等会触及本地或 Workshop 文件，请确认卷挂载和权限。
- `faststart` 是就地覆盖原视频；`repair?mode=reencode` 会写入 `VIDEO_CACHE_DIR`，不会覆盖 Workshop 原文件。
- 不建议同时让 Steam 正在下载/校验同一批 Workshop 文件时执行删除或修复操作。
