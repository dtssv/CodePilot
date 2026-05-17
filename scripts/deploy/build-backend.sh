#!/usr/bin/env bash
# =============================================================================
# CodePilot 后端构建脚本
# 用法: ./scripts/deploy/build-backend.sh [--skip-test] [--docker] [--tag <image_tag>]
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
BACKEND_DIR="$ROOT_DIR/backend"

# 默认参数
SKIP_TEST=false
BUILD_DOCKER=false
IMAGE_TAG="latest"
IMAGE_REPO="ghcr.io/codepilot/codepilot-backend"

# 解析参数
while [[ $# -gt 0 ]]; do
    case "$1" in
        --skip-test) SKIP_TEST=true; shift ;;
        --docker) BUILD_DOCKER=true; shift ;;
        --tag) IMAGE_TAG="$2"; shift 2 ;;
        --repo) IMAGE_REPO="$2"; shift 2 ;;
        -h|--help)
            echo "用法: $0 [--skip-test] [--docker] [--tag <tag>] [--repo <repo>]"
            echo ""
            echo "选项:"
            echo "  --skip-test   跳过单元测试"
            echo "  --docker      构建后额外打 Docker 镜像"
            echo "  --tag <tag>   Docker 镜像 tag (默认: latest)"
            echo "  --repo <repo> Docker 镜像仓库 (默认: ghcr.io/codepilot/codepilot-backend)"
            exit 0
            ;;
        *) echo "未知参数: $1"; exit 1 ;;
    esac
done

echo "============================================"
echo " CodePilot Backend Build"
echo "============================================"
echo " 项目目录: $BACKEND_DIR"
echo " 跳过测试: $SKIP_TEST"
echo " 构建Docker: $BUILD_DOCKER"
[[ "$BUILD_DOCKER" == "true" ]] && echo " 镜像: $IMAGE_REPO:$IMAGE_TAG"
echo "--------------------------------------------"

# 进入后端目录
cd "$BACKEND_DIR"

# 构建命令
GRADLE_ARGS="clean build"
if [[ "$SKIP_TEST" == "true" ]]; then
    GRADLE_ARGS="$GRADLE_ARGS -x test"
fi

echo "[1/3] 执行 Gradle 构建..."
./gradlew $GRADLE_ARGS

echo "[2/3] 构建产物:"
JAR_FILE=$(find codePilot-bootstrap/build/libs -name "*.jar" ! -name "*-plain.jar" | head -1)
if [[ -z "$JAR_FILE" ]]; then
    echo "ERROR: 未找到构建产物 JAR 文件"
    exit 1
fi
echo "  JAR: $JAR_FILE ($(du -h "$JAR_FILE" | cut -f1))"

# Docker 构建
if [[ "$BUILD_DOCKER" == "true" ]]; then
    echo "[3/3] 构建 Docker 镜像: $IMAGE_REPO:$IMAGE_TAG"
    docker build \
        -f "$SCRIPT_DIR/Dockerfile" \
        -t "$IMAGE_REPO:$IMAGE_TAG" \
        "$ROOT_DIR"
    echo "  镜像大小: $(docker image inspect "$IMAGE_REPO:$IMAGE_TAG" --format='{{.Size}}' | numfmt --to=iec 2>/dev/null || echo 'N/A')"
else
    echo "[3/3] 跳过 Docker 构建 (使用 --docker 参数启用)"
fi

echo "============================================"
echo " 构建完成!"
echo "============================================"