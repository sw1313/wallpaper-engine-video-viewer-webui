FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    # ↓ 给 nvidia-container-toolkit 用：docker run --gpus all 时会把 NVIDIA 驱动注入进来
    NVIDIA_VISIBLE_DEVICES=all \
    NVIDIA_DRIVER_CAPABILITIES=compute,utility,video \
    # ↓ Intel iGPU 走 iHD 驱动；老的 i965 也兼容
    LIBVA_DRIVER_NAME=iHD

# ffmpeg：
#   - debian 自带的 ffmpeg 已经编进了 h264_nvenc / hevc_nvenc / h264_qsv / hevc_qsv / vaapi 编码器
#   - intel-media-va-driver: Intel iGPU 的 iHD VA-API 驱动（QSV 就走它）
#   - libva-drm2/libva2/vainfo: VA-API 运行时 + 诊断
#   - NVIDIA 这边不需要在镜像里装驱动，--gpus all 会把宿主的驱动 bind mount 进来
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ffmpeg \
        ca-certificates \
        intel-media-va-driver \
        libva-drm2 \
        libva2 \
        vainfo \
    && rm -rf /var/lib/apt/lists/*

# uvicorn[standard] 自带 uvloop + httptools + websockets，
# 不走 HTTPS 时 uvloop 没 SSL 瓶颈，单核能跑满 2.5G LAN。
RUN pip install --no-cache-dir \
    fastapi \
    "uvicorn[standard]" \
    jinja2 \
    pillow \
    pydantic

WORKDIR /app

COPY webui/app /app/app
RUN touch /app/app/__init__.py

EXPOSE 8066

# 纯明文 HTTP/1.1 + uvloop：浏览器对 LAN 短 RTT 下，6 路 keep-alive 连接
# 跟 HTTP/2 多 stream 复用吞吐差不多，而且省掉 TLS 加密的整个 CPU 开销。
# --no-access-log：高码率视频一次播放会发几百个 Range，access log 噪声太大；
#                  需要调试的话临时去掉即可。
CMD ["uvicorn", "app.main:app", \
     "--host", "0.0.0.0", \
     "--port", "8066", \
     "--proxy-headers", \
     "--workers", "1", \
     "--no-access-log"]
