#!/usr/bin/env bash
# =============================================================================
# CodePilot K8s 部署脚本 (Helm)
# 用法: ./scripts/deploy/deploy-k8s.sh [--namespace <ns>] [--tag <tag>] [--values <file>]
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HELM_DIR="$SCRIPT_DIR/helm"

# 默认参数
NAMESPACE="codepilot"
RELEASE_NAME="codepilot"
IMAGE_TAG="1.0.0"
EXTRA_VALUES_FILE=""
DRY_RUN=false
ACTION="upgrade"

# 解析参数
while [[ $# -gt 0 ]]; do
    case "$1" in
        --namespace|-n) NAMESPACE="$2"; shift 2 ;;
        --tag) IMAGE_TAG="$2"; shift 2 ;;
        --release) RELEASE_NAME="$2"; shift 2 ;;
        --values|-f) EXTRA_VALUES_FILE="$2"; shift 2 ;;
        --dry-run) DRY_RUN=true; shift ;;
        --uninstall) ACTION="uninstall"; shift ;;
        --status) ACTION="status"; shift ;;
        -h|--help)
            echo "用法: $0 [OPTIONS]"
            echo ""
            echo "选项:"
            echo "  --namespace, -n <ns>    K8s 命名空间 (默认: codepilot)"
            echo "  --tag <tag>             镜像 tag (默认: 1.0.0)"
            echo "  --release <name>        Helm release 名称 (默认: codepilot)"
            echo "  --values, -f <file>     额外的 values 文件 (覆盖默认值)"
            echo "  --dry-run               仅渲染模板，不实际部署"
            echo "  --uninstall             卸载已部署的 release"
            echo "  --status                查看当前部署状态"
            echo ""
            echo "示例:"
            echo "  # 部署到 staging 环境"
            echo "  $0 --namespace staging --tag 1.2.0 -f my-staging-values.yaml"
            echo ""
            echo "  # 仅预览渲染结果"
            echo "  $0 --dry-run --tag 1.2.0"
            echo ""
            echo "需要替换的核心参数 (在 values.yaml 或 --values 文件中):"
            echo "  image.tag                 - 镜像版本"
            echo "  env.CODEPILOT_DB_URL      - PostgreSQL JDBC URL"
            echo "  env.CODEPILOT_DB_USER     - 数据库用户名"
            echo "  env.CODEPILOT_DB_PASSWORD  - 数据库密码"
            echo "  env.CODEPILOT_REDIS_URL   - Redis URL"
            echo "  env.CODEPILOT_LLM_BASE_URL - LLM 服务地址"
            echo "  env.CODEPILOT_LLM_API_KEY  - LLM API Key"
            echo "  env.CODEPILOT_JWT_SECRET   - JWT 签名密钥 (>=32字节)"
            echo "  env.CODEPILOT_HMAC_SECRET  - HMAC 签名密钥 (>=32字节)"
            exit 0
            ;;
        *) echo "未知参数: $1"; exit 1 ;;
    esac
done

# 检查依赖
command -v helm >/dev/null 2>&1 || { echo "ERROR: 需要安装 Helm (>= 3.12)"; exit 1; }
command -v kubectl >/dev/null 2>&1 || { echo "ERROR: 需要安装 kubectl"; exit 1; }

echo "============================================"
echo " CodePilot K8s Deploy (Helm)"
echo "============================================"
echo " 操作:     $ACTION"
echo " Release:  $RELEASE_NAME"
echo " 命名空间: $NAMESPACE"
echo " 镜像 Tag: $IMAGE_TAG"
[[ -n "$EXTRA_VALUES_FILE" ]] && echo " 额外Values: $EXTRA_VALUES_FILE"
echo " Dry Run:  $DRY_RUN"
echo "--------------------------------------------"

case "$ACTION" in
    upgrade)
        HELM_ARGS=(
            upgrade --install "$RELEASE_NAME" "$HELM_DIR"
            --namespace "$NAMESPACE" --create-namespace
            --set "image.tag=$IMAGE_TAG"
        )

        if [[ -n "$EXTRA_VALUES_FILE" ]]; then
            HELM_ARGS+=(-f "$EXTRA_VALUES_FILE")
        fi

        if [[ "$DRY_RUN" == "true" ]]; then
            HELM_ARGS+=(--dry-run --debug)
        fi

        echo "执行: helm ${HELM_ARGS[*]}"
        helm "${HELM_ARGS[@]}"

        if [[ "$DRY_RUN" == "false" ]]; then
            echo ""
            echo "等待部署就绪..."
            kubectl -n "$NAMESPACE" rollout status deployment/"$RELEASE_NAME" --timeout=120s || true
            echo ""
            echo "Pod 状态:"
            kubectl -n "$NAMESPACE" get pods -l "app.kubernetes.io/instance=$RELEASE_NAME"
        fi
        ;;

    uninstall)
        echo "卸载 release: $RELEASE_NAME"
        helm uninstall "$RELEASE_NAME" --namespace "$NAMESPACE"
        ;;

    status)
        echo "Helm Release 状态:"
        helm status "$RELEASE_NAME" --namespace "$NAMESPACE" 2>/dev/null || echo "  未找到 release: $RELEASE_NAME"
        echo ""
        echo "Pod 状态:"
        kubectl -n "$NAMESPACE" get pods -l "app.kubernetes.io/instance=$RELEASE_NAME" 2>/dev/null || echo "  未找到 pods"
        echo ""
        echo "Service:"
        kubectl -n "$NAMESPACE" get svc -l "app.kubernetes.io/instance=$RELEASE_NAME" 2>/dev/null || echo "  未找到 service"
        ;;
esac

echo ""
echo "============================================"
echo " 操作完成"
echo "============================================"