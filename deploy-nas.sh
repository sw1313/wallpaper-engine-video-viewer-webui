#!/usr/bin/env bash
# 用法：GPU_MODE=cpu|nvidia|intel|both ./deploy-nas.sh
# 配置写在 ${APP_DIR}/runtime.env，改完 docker restart 即可，不必在群晖 GUI 改环境变量
set -euo pipefail

GPU_MODE="${GPU_MODE:-both}"
IMAGE="${IMAGE:-wallpaper-webui:latest}"
NAME="${NAME:-wallpaper-webui}"
PORT="${PORT:-8066}"

APP_DIR="${APP_DIR:-/volume1/docker/wallpaper-webui}"
WE_PATH="${WE_PATH:-/volume1/steam/SteamLibrary/steamapps/common/wallpaper_engine}"
WORKSHOP_PATH="${WORKSHOP_PATH:-/volume1/steam/SteamLibrary/steamapps/workshop/content/431960}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "==> 构建镜像 ${IMAGE}"
docker build -t "${IMAGE}" "${SCRIPT_DIR}"

echo "==> 同步代码到 ${APP_DIR}"
mkdir -p "${APP_DIR}"
rsync -a --delete \
  --exclude '.git' --exclude 'data/' --exclude '__pycache__/' \
  --exclude 'preview_cache/' --exclude 'hls_cache/' \
  --exclude 'steam_config.json' --exclude 'docker.env' --exclude 'runtime.env' \
  "${SCRIPT_DIR}/" "${APP_DIR}/"

if [[ ! -f "${APP_DIR}/runtime.env" ]]; then
  cp "${APP_DIR}/runtime.env.example" "${APP_DIR}/runtime.env"
  echo "==> 已创建 ${APP_DIR}/runtime.env（请按需编辑）"
fi

case "${GPU_MODE}" in
  cpu)
    HLS_FALLBACK=libx264
    ;;
  nvidia|intel|both)
    HLS_FALLBACK=auto
    ;;
  *)
    echo "GPU_MODE 必须是 cpu | nvidia | intel | both"
    exit 1
    ;;
esac

# 按 GPU_MODE 更新 runtime.env 里的 HLS_TRANSCODE_FALLBACK
if grep -q '^HLS_TRANSCODE_FALLBACK=' "${APP_DIR}/runtime.env"; then
  sed -i "s/^HLS_TRANSCODE_FALLBACK=.*/HLS_TRANSCODE_FALLBACK=${HLS_FALLBACK}/" "${APP_DIR}/runtime.env"
else
  echo "HLS_TRANSCODE_FALLBACK=${HLS_FALLBACK}" >> "${APP_DIR}/runtime.env"
fi

GPU_ARGS=()
case "${GPU_MODE}" in
  nvidia)
    GPU_ARGS+=(--gpus all)
    ;;
  intel)
    GPU_ARGS+=(--device /dev/dri:/dev/dri)
    ;;
  both)
    GPU_ARGS+=(--gpus all --device /dev/dri:/dev/dri)
    ;;
esac

echo "==> GPU_MODE=${GPU_MODE} HLS_TRANSCODE_FALLBACK=${HLS_FALLBACK}"
docker rm -f "${NAME}" 2>/dev/null || true

ENV_NVIDIA=()
if [[ "${GPU_MODE}" == "nvidia" || "${GPU_MODE}" == "both" ]]; then
  # 必须在 docker run 时传入，runtime.env 对 nvidia 设备挂载无效
  ENV_NVIDIA=(
    -e NVIDIA_VISIBLE_DEVICES=all
    -e NVIDIA_DRIVER_CAPABILITIES=compute,video,utility
  )
fi

docker run -d \
  --name "${NAME}" \
  --restart unless-stopped \
  -p "${PORT}:8066" \
  "${GPU_ARGS[@]}" \
  "${ENV_NVIDIA[@]}" \
  -v "${APP_DIR}:/app/app" \
  -v "${WE_PATH}:/data/wallpaper_engine" \
  -v "${WORKSHOP_PATH}:/data/workshop/content/431960" \
  "${IMAGE}"

echo "==> 完成 http://<NAS-IP>:${PORT}/"
echo "==> 改配置：编辑 ${APP_DIR}/runtime.env 后 docker restart ${NAME}"
