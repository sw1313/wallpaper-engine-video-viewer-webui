# wallpaper-engine-video-viewer-webui
wallpaper-engine-video-viewer-webui, Docker deployment, mimicking the we path directory.   
1.网页内播放，支持文件夹批量播放，支持播放完成记录，电脑支持框选及快捷键多选播放  
2.适配手机浏览  
3.添加后台播放音频功能，仅用chrome安卓版测试，via之类无法正常工作  
  
# 部署教程

## 文件结构

```text
webui/
├─ app/
│  ├─ main.py
│  ├─ models.py
│  ├─ we_scan.py
│  ├─ watched_api.py
│  ├─ templates/
│  │  └─ index.html
│  └─ static/
│     ├─ style.css
│     └─ app.js
├─ Dockerfile
```

---

## 快速部署（可直接复制）

### 1. 进入程序目录

```bash
cd /volume1/docker/webui
```

### 2. 构建镜像

```bash
docker build -t wallpaper-webui:latest .
```

### 3. 运行容器（Linux / Synology 示例）

```bash
docker run -d \
  -p 8066:8066 \
  -e WORKSHOP_PATH=/data/workshop/content/431960 \
  -e WE_PATH=/data/wallpaper_engine \
  -v /path/to/workshop/content/431960:/data/workshop/content/431960:ro \
  -v /path/to/wallpaper_engine:/data/wallpaper_engine:ro \
  --name wallpaper-webui \
  wallpaper-webui:latest
```
没有做账号验证，请不要部署在外网环境中
