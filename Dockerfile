FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

COPY webui/app /app/app

# 安装依赖和 ffmpeg
RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg && \
    pip install --no-cache-dir fastapi uvicorn[standard] jinja2 pillow && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# 运行时通过环境变量告诉容器真实路径（在 docker-compose 里挂载）
ENV WORKSHOP_PATH=/data/workshop/content/431960
ENV WE_PATH=/data/wallpaper_engine

EXPOSE 8066
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8066"]
