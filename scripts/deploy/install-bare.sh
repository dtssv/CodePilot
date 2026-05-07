#!/usr/bin/env bash
# =============================================================================
# CodePilot 非 Docker 裸机部署脚本
# 适用于直接在物理机或虚拟机上以 systemd 服务方式运行后端
# 用法: sudo ./scripts/deploy/install-bare.sh [--env-file <path>] [--jar <path>]
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

# 默认参数
ENV_FILE=""
JAR_FILE=""
INSTALL_DIR="/opt/codepilot"
SERVICE_USER="codepilot"
SERVICE_NAME="codepilot"

# 解析参数
while [[ $# -gt 0 ]]; do
    case "$1" in
        --env-file) ENV_FILE="$2"; shift 2 ;;
        --jar) JAR_FILE="$2"; shift 2 ;;
        --install-dir) INSTALL_DIR="$2"; shift 2 ;;
        -h|--help)
            echo "用法: sudo $0 [--env-file <path>] [--jar <path>] [--install-dir <dir>]"
            echo ""
            echo "选项:"
            echo "  --env-file <path>    环境变量文件 (默认: 从 prod.env.template 复制)"
            echo "  --jar <path>         后端 JAR 文件路径 (默认: 自动查找构建产物)"
            echo "  --install-dir <dir>  安装目录 (默认: /opt/codepilot)"
            echo ""
            echo "前提条件:"
            echo "  - JDK 21+ 已安装"
            echo "  - PostgreSQL 16+ (含 pgvector 扩展) 已就绪"
            echo "  - Redis 7+ 已就绪"
            echo "  - 以 root 或 sudo 执行"
            exit 0
            ;;
        *) echo "未知参数: $1"; exit 1 ;;
    esac
done

# 检查 root 权限
if [[ $EUID -ne 0 ]]; then
    echo "ERROR: 请使用 sudo 或 root 用户执行此脚本"
    exit 1
fi

# 查找 JAR
if [[ -z "$JAR_FILE" ]]; then
    JAR_FILE=$(find "$ROOT_DIR/backend/codePilot-bootstrap/build/libs" -name "*.jar" ! -name "*-plain.jar" 2>/dev/null | head -1)
    if [[ -z "$JAR_FILE" ]]; then
        echo "ERROR: 未找到 JAR 文件，请先执行 build-backend.sh 或使用 --jar 参数指定"
        exit 1
    fi
fi

echo "============================================"
echo " CodePilot 裸机部署"
echo "============================================"
echo " JAR 文件: $JAR_FILE"
echo " 安装目录: $INSTALL_DIR"
echo " 服务用户: $SERVICE_USER"
echo "--------------------------------------------"

# 1. 创建系统用户
echo "[1/5] 创建系统用户 $SERVICE_USER ..."
id "$SERVICE_USER" &>/dev/null || useradd --system --home-dir "$INSTALL_DIR" --shell /sbin/nologin "$SERVICE_USER"

# 2. 创建目录结构
echo "[2/5] 创建目录结构..."
mkdir -p "$INSTALL_DIR"/{bin,conf,logs}

# 3. 复制 JAR 与环境变量
echo "[3/5] 部署应用文件..."
cp "$JAR_FILE" "$INSTALL_DIR/bin/codepilot.jar"

if [[ -n "$ENV_FILE" && -f "$ENV_FILE" ]]; then
    cp "$ENV_FILE" "$INSTALL_DIR/conf/codepilot.env"
elif [[ ! -f "$INSTALL_DIR/conf/codepilot.env" ]]; then
    cp "$SCRIPT_DIR/prod.env.template" "$INSTALL_DIR/conf/codepilot.env"
    echo "  ⚠  已复制 prod.env.template → $INSTALL_DIR/conf/codepilot.env"
    echo "     请编辑该文件填入真实配置值!"
fi

chown -R "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR"
chmod 600 "$INSTALL_DIR/conf/codepilot.env"

# 4. 安装 systemd 服务
echo "[4/5] 安装 systemd 服务..."
cat > /etc/systemd/system/${SERVICE_NAME}.service <<EOF
[Unit]
Description=CodePilot Backend Service
Documentation=https://github.com/codePilot/CodePilot
After=network-online.target postgresql.service redis.service
Wants=network-online.target

[Service]
Type=simple
User=${SERVICE_USER}
Group=${SERVICE_USER}
WorkingDirectory=${INSTALL_DIR}
EnvironmentFile=${INSTALL_DIR}/conf/codepilot.env
ExecStart=/usr/bin/java \\
    -XX:+UseG1GC \\
    -XX:MaxRAMPercentage=75.0 \\
    -Dfile.encoding=UTF-8 \\
    -Djava.security.egd=file:/dev/./urandom \\
    -jar ${INSTALL_DIR}/bin/codepilot.jar
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=${SERVICE_NAME}
LimitNOFILE=65536
TimeoutStopSec=60

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "$SERVICE_NAME"

# 5. 提示
echo "[5/5] 安装完成!"
echo ""
echo "============================================"
echo " 部署完成 — 后续操作"
echo "============================================"
echo ""
echo " 1. 编辑配置文件 (如未提供 --env-file):"
echo "    sudo vim $INSTALL_DIR/conf/codepilot.env"
echo ""
echo " 2. 启动服务:"
echo "    sudo systemctl start $SERVICE_NAME"
echo ""
echo " 3. 查看状态/日志:"
echo "    sudo systemctl status $SERVICE_NAME"
echo "    sudo journalctl -u $SERVICE_NAME -f"
echo ""
echo " 4. 验证:"
echo "    curl http://localhost:8080/actuator/health"
echo "    curl http://localhost:8080/v1/version"
echo ""
echo " 5. 停止/重启:"
echo "    sudo systemctl stop $SERVICE_NAME"
echo "    sudo systemctl restart $SERVICE_NAME"
echo "============================================"