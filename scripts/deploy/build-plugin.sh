#!/usr/bin/env bash
# =============================================================================
# CodePilot 插件构建脚本
# 用法: ./scripts/deploy/build-plugin.sh [--sign] [--publish]
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
PLUGIN_DIR="$ROOT_DIR/plugin"

# 默认参数
SIGN_PLUGIN=false
PUBLISH_PLUGIN=false

# 解析参数
while [[ $# -gt 0 ]]; do
    case "$1" in
        --sign) SIGN_PLUGIN=true; shift ;;
        --publish) PUBLISH_PLUGIN=true; shift ;;
        -h|--help)
            echo "用法: $0 [--sign] [--publish]"
            echo ""
            echo "选项:"
            echo "  --sign       对插件进行签名 (需要设置证书环境变量)"
            echo "  --publish    构建后发布到 JetBrains Marketplace"
            echo ""
            echo "签名所需环境变量:"
            echo "  CODEPILOT_PLUGIN_CERT_CHAIN  - 证书链文件路径"
            echo "  CODEPILOT_PLUGIN_CERT_KEY    - 私钥文件路径"
            echo "  CODEPILOT_PLUGIN_CERT_PASSWORD - 私钥密码"
            echo ""
            echo "发布所需环境变量:"
            echo "  JETBRAINS_MARKETPLACE_TOKEN  - JetBrains Marketplace 上传 token"
            exit 0
            ;;
        *) echo "未知参数: $1"; exit 1 ;;
    esac
done

echo "============================================"
echo " CodePilot Plugin Build"
echo "============================================"
echo " 项目目录: $PLUGIN_DIR"
echo " 签名插件: $SIGN_PLUGIN"
echo " 发布插件: $PUBLISH_PLUGIN"
echo "--------------------------------------------"

cd "$PLUGIN_DIR"

# 检查签名环境变量
if [[ "$SIGN_PLUGIN" == "true" ]]; then
    if [[ -z "${CODEPILOT_PLUGIN_CERT_CHAIN:-}" || -z "${CODEPILOT_PLUGIN_CERT_KEY:-}" ]]; then
        echo "ERROR: 签名需要设置 CODEPILOT_PLUGIN_CERT_CHAIN 和 CODEPILOT_PLUGIN_CERT_KEY 环境变量"
        exit 1
    fi
fi

echo "[1/5] 清理旧构建产物..."
./gradlew clean

echo "[2/5] 构建 WebUI (npm install + vite build)..."
if [[ -f "webui/package.json" ]]; then
    cd webui
    if command -v npm >/dev/null 2>&1; then
        npm install
        npm run build
        echo "  WebUI 构建完成: webui/dist/"
    else
        echo "  WARNING: npm not found, skipping WebUI build. JCEF panel will fallback to Swing."
    fi
    cd ..
else
    echo "  WARNING: webui/package.json not found, skipping WebUI build."
fi

echo "[3/5] 构建插件..."
./gradlew buildPlugin

# 签名
if [[ "$SIGN_PLUGIN" == "true" ]]; then
    echo "[4/5] 签名插件..."
    ./gradlew signPlugin
else
    echo "[4/5] 跳过签名 (使用 --sign 参数启用)"
fi

# 发布
if [[ "$PUBLISH_PLUGIN" == "true" ]]; then
    if [[ -z "${JETBRAINS_MARKETPLACE_TOKEN:-}" ]]; then
        echo "ERROR: 发布需要设置 JETBRAINS_MARKETPLACE_TOKEN 环境变量"
        exit 1
    fi
    echo "[5/5] 发布到 JetBrains Marketplace..."
    ./gradlew publishPlugin
else
    echo "[5/5] 跳过发布 (使用 --publish 参数启用)"
fi

# 输出构建产物
echo ""
echo "============================================"
echo " 构建产物:"
echo "============================================"
ls -lh build/distributions/*.zip 2>/dev/null || echo "  未找到 zip 产物"
echo ""
echo " 安装方式:"
echo "   IDE: Settings → Plugins → ⚙ → Install Plugin from Disk..."
echo "   选择上述 .zip 文件即可"
echo "============================================"