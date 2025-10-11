# wallpaper-engine-video-viewer-webui
wallpaper-engine-video-viewer-webui, Docker deployment, mimicking the we path directory.  
由项目https://github.com/sw1313/wallpaper-engine-video-viewer修改  
1.网页内播放，支持文件夹批量播放，电脑支持框选及快捷键多选播放  
2.适配手机浏览  
  
部署教程
文件树：
webui/
├─ app/
│  ├─ main.py
│  ├─ models.py
│  ├─ we_scan.py
│  ├─ templates/
│  │  └─ index.html
│  └─ static/
│     ├─ style.css
│     └─ app.js
├─ Dockerfile

进入程序文件夹：
cd /volume1/docker/webui

创建镜像：
docker build -t wallpaper-webui:latest .

部署容器：
docker run -d -p 8066:8066 \
  -e WORKSHOP_PATH=/data/workshop/content/431960 \
  -e WE_PATH=/data/wallpaper_engine \
  -v /volume1/steam/SteamLibrary/steamapps/workshop/content/431960:/data/workshop/content/431960 \
  -v /volume1/steam/SteamLibrary/steamapps/common/wallpaper_engine:/data/wallpaper_engine:ro \
  --restart unless-stopped \
  --name wallpaper-webui wallpaper-webui:latest


Windows用户注意：可能需要调整一些配置。
