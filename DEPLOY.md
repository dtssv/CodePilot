# CodePilot 部署手册

本手册包含四种部署形态：**本地开发调试**、**非 Docker 裸机部署**、**Docker Compose 部署** 和 **Kubernetes 部署**。
涵盖后端服务和 IntelliJ 插件的完整构建与部署流程。

---

## 目录

1. [前置条件](#1-前置条件)
2. [环境变量与参数说明](#2-环境变量与参数说明)
3. [本地开发调试](#3-本地开发调试)
4. [非 Docker 裸机部署](#4-非-docker-裸机部署)
5. [Docker Compose 部署](#5-docker-compose-部署)
6. [Kubernetes 部署](#6-kubernetes-部署)
7. [插件构建与分发](#7-插件构建与分发)
8. [部署脚本一览](#8-部署脚本一览)
9. [健康检查与可观测](#9-健康检查与可观测)
10. [安全清单](#10-安全清单)
11. [故障排查](#11-故障排查)

---

## 1. 前置条件

| 项 | 版本 | 用途 |
|---|---|---|
| JDK | Temurin 21 LTS | 后端编译与运行 |
| Gradle | 8.10+ (wrapper 自带) | 构建系统 |
| Docker / Docker Desktop | ≥ 24 | 容器化部署 |
| Docker Compose | v2+ | 本地开发 / 单机生产 |
| PostgreSQL | 16+ (含 pgvector 扩展) | 数据存储 |
| Redis | 7+ | 缓存与会话 |
| Helm | ≥ 3.12 | K8s 场景 |
| kubectl | 与集群版本匹配 | K8s 场景 |
| IntelliJ IDEA | 2024.2+ | 插件开发与调试 |
| Kotlin | 2.0+ (Gradle 管理) | 插件编译 |

---

## 2. 环境变量与参数说明

所有环境变量定义在 [`scripts/deploy/prod.env.template`](scripts/deploy/prod.env.template)。
复制后按实际值修改。**所有 `*_SECRET` 必须 ≥ 32 字节随机字符串**。

### 必填参数

| 变量 | 含义 | 示例 |
|---|---|---|
| `CODEPILOT_DB_URL` | PostgreSQL JDBC URL | `jdbc:postgresql://db:5432/codepilot` |
| `CODEPILOT_DB_USER` | 数据库用户名 | `codepilot` |
| `CODEPILOT_DB_PASSWORD` | 数据库密码 | (随机) |
| `CODEPILOT_REDIS_URL` | Redis URL | `redis://redis:6379` |
| `CODEPILOT_LLM_BASE_URL` | LLM 上游地址 (OpenAI 协议) | `https://api.openai.com/v1` |
| `CODEPILOT_LLM_API_KEY` | LLM API Key | `sk-xxx` |
| `CODEPILOT_LLM_DEFAULT_MODEL` | 默认模型 | `gpt-4o-mini` |
| `CODEPILOT_JWT_SECRET` | JWT 签名密钥 | (≥32 字节随机) |
| `CODEPILOT_HMAC_SECRET` | HMAC 签名密钥 | (≥32 字节随机) |

### SSO 认证 (三选一)

| 方式 | 关键变量 | 适用场景 |
|---|---|---|
| OIDC | `CODEPILOT_OIDC_ISSUER`, `_JWKS_URI`, `_CLIENT_ID`, `_CLIENT_SECRET` | 生产推荐 |
| 企业 SSO 桥 | `CODEPILOT_SSO_BRIDGE_SECRET` | 已有企业登录系统 |
| Dev 登录 | `CODEPILOT_SSO_DEV_ENABLED=true`, `_DEV_TOKEN` | 仅本地开发 |

### 可选参数

| 变量 | 含义 | 默认值 |
|---|---|---|
| `CODEPILOT_DB_POOL_MAX` | HikariCP 最大连接数 | 40 |
| `CODEPILOT_PORT` | 监听端口 | 8080 |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OpenTelemetry Collector | (空=不启用) |

---

## 3. 本地开发调试

### 3.1 后端本地调试

```bash
# Step 1: 启动依赖服务 (Postgres + Redis + MinIO + OTel)
docker compose -f scripts/deploy/docker-compose.dev.yml up -d

# Step 2: 配置环境变量
cd backend
cp .env.example .env
# 编辑 .env，本地开发只需保持默认值，启用 Dev SSO:
#   CODEPILOT_SSO_DEV_ENABLED=true
#   CODEPILOT_SSO_DEV_TOKEN=dev-test-token

# Step 3: 加载环境变量并启动后端
set -a && source .env && set +a
./gradlew :codePilot-bootstrap:bootRun

# Step 4: 验证
curl -s http://localhost:8080/actuator/health
curl -s http://localhost:8080/v1/version
open http://localhost:8080/swagger-ui.html
```

> Flyway 在启动时自动应用 `scripts/db/V*.sql` 数据库迁移。

### 3.2 插件本地调试

```bash
cd plugin

# 在沙箱 IDE 中运行插件
./gradlew runIde

# 在沙箱 IDE 中:
#   1. Settings → Tools → CodePilot → 设置 Base URL 为 http://localhost:8080
#   2. 打开 CodePilot Chat Panel
#   3. 使用 Dev SSO 登录
```

### 3.3 WebUI 本地调试

```bash
cd plugin/webui
npm install
npm run dev
# 访问 http://localhost:5173
```

### 3.4 常用 Gradle 命令

| 命令 | 说明 |
|---|---|
| `./gradlew :codePilot-bootstrap:bootRun` | 启动后端 |
| `./gradlew clean build` | 完整构建 (含测试) |
| `./gradlew clean build -x test` | 构建 (跳过测试) |
| `./gradlew :codePilot-bootstrap:bootJar` | 仅打包 JAR |
| `cd plugin && ./gradlew runIde` | 沙箱调试插件 |
| `cd plugin && ./gradlew buildPlugin` | 构建插件 zip |

---

## 4. 非 Docker 裸机部署

适用于不使用容器的传统服务器部署，以 systemd 管理服务。

### 4.1 前提

- 目标服务器已安装 JDK 21+
- PostgreSQL 16+ (含 pgvector) 已就绪，可连接
- Redis 7+ 已就绪，可连接

### 4.2 构建

```bash
# 在构建机上
./scripts/deploy/build-backend.sh --skip-test
# 产物: backend/codePilot-bootstrap/build/libs/codePilot-backend.jar
```

### 4.3 部署

```bash
# 将 JAR 和部署脚本传到目标服务器后执行:
sudo ./scripts/deploy/install-bare.sh \
    --jar /path/to/codePilot-backend.jar \
    --env-file /path/to/prod.env

# 或者不指定 env-file，脚本会自动复制模板:
sudo ./scripts/deploy/install-bare.sh --jar /path/to/codePilot-backend.jar
# 然后手动编辑: sudo vim /opt/codepilot/conf/codepilot.env
```

### 4.4 服务管理

```bash
# 启动
sudo systemctl start codepilot

# 停止
sudo systemctl stop codepilot

# 重启 (更新 JAR 后)
sudo cp new-codePilot-backend.jar /opt/codepilot/bin/codepilot.jar
sudo systemctl restart codepilot

# 查看日志
sudo journalctl -u codepilot -f

# 查看状态
sudo systemctl status codepilot
```

### 4.5 install-bare.sh 做了什么

1. 创建系统用户 `codepilot`
2. 创建目录 `/opt/codepilot/{bin,conf,logs}`
3. 复制 JAR 到 `/opt/codepilot/bin/codepilot.jar`
4. 复制环境变量文件到 `/opt/codepilot/conf/codepilot.env` (权限 600)
5. 注册 systemd 服务并设为开机自启

### 4.6 Nginx 反向代理配置 (推荐)

```nginx
upstream codepilot_backend {
    server 127.0.0.1:8080;
}

server {
    listen 443 ssl http2;
    server_name api.codepilot.example.com;

    ssl_certificate     /etc/ssl/certs/codepilot.pem;
    ssl_certificate_key /etc/ssl/private/codepilot-key.pem;

    # SSE 长连接支持
    proxy_read_timeout 120s;
    proxy_buffering off;

    location / {
        proxy_pass http://codepilot_backend;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # SSE 支持
        proxy_set_header Connection '';
        proxy_http_version 1.1;
        chunked_transfer_encoding off;
    }
}
```

---

## 5. Docker Compose 部署

### 5.1 构建镜像

```bash
# 方式一: 使用构建脚本
./scripts/deploy/build-backend.sh --docker --tag 1.0.0

# 方式二: 直接 docker build
docker build -f scripts/deploy/Dockerfile -t ghcr.io/codepilot/codepilot-backend:1.0.0 .
```

### 5.2 准备配置

```bash
cd scripts/deploy
cp prod.env.template prod.env
vim prod.env   # 填入真实值
```

### 5.3 启动

```bash
# 使用生产 compose 文件
docker compose -f scripts/deploy/docker-compose.prod.yml \
    --env-file scripts/deploy/prod.env up -d

# 验证
docker compose -f scripts/deploy/docker-compose.prod.yml ps
curl -s http://localhost:8080/actuator/health
curl -s http://localhost:8080/v1/version
```

### 5.4 docker-compose.prod.yml 说明

```yaml
services:
  app:          # 后端应用, 依赖 postgres 和 redis 健康检查通过后启动
  postgres:     # PostgreSQL 16 + pgvector, 数据持久化到 volume
  redis:        # Redis 7, 数据持久化到 volume
```

### 5.5 日常运维

```bash
# 查看日志
docker compose -f scripts/deploy/docker-compose.prod.yml logs -f app

# 更新镜像后重启
docker compose -f scripts/deploy/docker-compose.prod.yml pull app
docker compose -f scripts/deploy/docker-compose.prod.yml up -d app

# 停止所有服务
docker compose -f scripts/deploy/docker-compose.prod.yml down

# 停止并清理数据 (危险!)
docker compose -f scripts/deploy/docker-compose.prod.yml down -v
```

---

## 6. Kubernetes 部署

### 6.1 前提

- 已配置好 kubectl 连接到目标集群
- 已安装 Helm ≥ 3.12
- 镜像已推送到集群可访问的镜像仓库
- 外部 PostgreSQL 和 Redis 已就绪 (不建议在 K8s 内运行有状态服务)

### 6.2 构建并推送镜像

```bash
# 构建
./scripts/deploy/build-backend.sh --docker --tag 1.0.0

# 推送到镜像仓库
docker tag ghcr.io/codepilot/codepilot-backend:1.0.0 your-registry.com/codepilot-backend:1.0.0
docker push your-registry.com/codepilot-backend:1.0.0
```

### 6.3 准备 values 文件

创建环境专属的 values 覆盖文件:

```yaml
# values-prod.yaml
image:
  repository: your-registry.com/codepilot-backend
  tag: "1.0.0"

replicaCount: 3

ingress:
  enabled: true
  className: nginx
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt
    nginx.ingress.kubernetes.io/proxy-read-timeout: "120"
    nginx.ingress.kubernetes.io/proxy-buffering: "off"
  hosts:
    - host: api.codepilot.example.com
      paths:
        - path: /
          pathType: Prefix
  tls:
    - secretName: codepilot-tls
      hosts:
        - api.codepilot.example.com

env:
  CODEPILOT_DB_URL: "jdbc:postgresql://pg-cluster.internal:5432/codepilot"
  CODEPILOT_DB_USER: "codepilot"
  CODEPILOT_DB_PASSWORD: "YOUR_DB_PASSWORD"
  CODEPILOT_REDIS_URL: "redis://redis-cluster.internal:6379"
  CODEPILOT_LLM_BASE_URL: "https://api.openai.com/v1"
  CODEPILOT_LLM_API_KEY: "sk-YOUR_KEY"
  CODEPILOT_LLM_DEFAULT_MODEL: "gpt-4o-mini"
  CODEPILOT_JWT_SECRET: "YOUR_JWT_SECRET_32_BYTES"
  CODEPILOT_HMAC_SECRET: "YOUR_HMAC_SECRET_32_BYTES"

resources:
  requests:
    cpu: "1"
    memory: "2Gi"
  limits:
    cpu: "4"
    memory: "4Gi"

autoscaling:
  enabled: true
  minReplicas: 3
  maxReplicas: 10
  targetCPUUtilizationPercentage: 65
```

### 6.4 部署

```bash
# 使用部署脚本
./scripts/deploy/deploy-k8s.sh --tag 1.0.0 -f values-prod.yaml

# 或直接使用 Helm
helm upgrade --install codepilot scripts/deploy/helm \
    --namespace codepilot --create-namespace \
    --set image.tag=1.0.0 \
    -f values-prod.yaml
```

### 6.5 deploy-k8s.sh 用法

```bash
# 部署/更新
./scripts/deploy/deploy-k8s.sh --tag 1.2.0 -f values-prod.yaml

# 预览渲染 (不实际部署)
./scripts/deploy/deploy-k8s.sh --dry-run --tag 1.2.0

# 查看状态
./scripts/deploy/deploy-k8s.sh --status

# 卸载
./scripts/deploy/deploy-k8s.sh --uninstall

# 指定命名空间
./scripts/deploy/deploy-k8s.sh --namespace staging --tag 1.2.0-rc1
```

### 6.6 Helm Chart 架构

```
scripts/deploy/helm/
├── Chart.yaml              # Chart 元信息
├── values.yaml             # 默认配置值
└── templates/
    ├── _helpers.tpl        # 模板辅助函数
    ├── deployment.yaml     # Deployment (滚动更新、探针、资源限制)
    ├── service.yaml        # ClusterIP Service
    ├── hpa.yaml            # HPA 水平自动伸缩
    ├── pdb.yaml            # PodDisruptionBudget
    └── secret.yaml         # 环境变量 Secret
```

### 6.7 K8s 最佳实践

- 使用外部托管数据库 (Aurora / RDS / Cloud SQL)，不在 K8s 内部署有状态服务
- 滚动更新: `maxSurge=25% maxUnavailable=0`，避免 SSE 长连接被同时切断
- `terminationGracePeriodSeconds=60` 给在飞流足够清理时间
- 使用 `PodDisruptionBudget minAvailable=1`
- 密钥通过 Sealed Secrets / Vault / External Secrets Operator 注入
- 反向代理关闭 buffer，增大 proxy_read_timeout (SSE 需要)

---

## 7. 插件构建与分发

### 7.1 构建

```bash
# 使用构建脚本
./scripts/deploy/build-plugin.sh

# 产物: plugin/build/distributions/codePilot-<version>.zip
```

### 7.2 签名 (可选，发布到 Marketplace 推荐)

```bash
export CODEPILOT_PLUGIN_CERT_CHAIN=/path/to/cert-chain.pem
export CODEPILOT_PLUGIN_CERT_KEY=/path/to/private-key.pem
export CODEPILOT_PLUGIN_CERT_PASSWORD=your-cert-password

./scripts/deploy/build-plugin.sh --sign
```

### 7.3 分发渠道

| 渠道 | 说明 | 操作 |
|---|---|---|
| JetBrains Marketplace | 公开发布 | 上传 zip; 或 `--publish` 自动发布 |
| 企业自托管 | 内网插件仓库 | 将 zip 放到内网静态站 → IDE 添加 Custom Plugin Repository |
| 自更新通道 | 后端管理 | 插件调用 `/v1/plugin/manifest` 检查新版本 |

### 7.4 企业自托管仓库

1. 将 zip 文件托管到内网 HTTP 服务 (如 Nginx):
   ```
   https://plugins.internal.example.com/codePilot-1.0.0.zip
   ```

2. 创建 `updatePlugins.xml`:
   ```xml
   <?xml version="1.0" encoding="UTF-8"?>
   <plugins>
     <plugin id="io.codepilot.intellij" url="https://plugins.internal.example.com/codePilot-1.0.0.zip" version="1.0.0">
       <idea-version since-build="232"/>
       <description>CodePilot AI coding assistant</description>
     </plugin>
   </plugins>
   ```

3. 用户在 IDE 中: `Settings → Plugins → ⚙ → Manage Plugin Repositories` 添加 XML URL

---

## 8. 部署脚本一览

| 脚本 | 用途 | 使用场景 |
|---|---|---|
| [`scripts/deploy/build-backend.sh`](scripts/deploy/build-backend.sh) | 后端构建 (Gradle + 可选 Docker) | 所有部署方式 |
| [`scripts/deploy/build-plugin.sh`](scripts/deploy/build-plugin.sh) | 插件构建 (签名/发布) | 插件分发 |
| [`scripts/deploy/install-bare.sh`](scripts/deploy/install-bare.sh) | 裸机部署 (systemd 服务) | 非 Docker 部署 |
| [`scripts/deploy/deploy-k8s.sh`](scripts/deploy/deploy-k8s.sh) | K8s Helm 部署 | Kubernetes 部署 |
| [`scripts/deploy/prod.env.template`](scripts/deploy/prod.env.template) | 生产环境变量模板 | 所有部署方式 |
| [`scripts/deploy/docker-compose.dev.yml`](scripts/deploy/docker-compose.dev.yml) | 本地开发依赖 | 本地调试 |
| [`scripts/deploy/docker-compose.prod.yml`](scripts/deploy/docker-compose.prod.yml) | 生产 Docker Compose | Docker 部署 |
| [`scripts/deploy/Dockerfile`](scripts/deploy/Dockerfile) | 后端 Docker 镜像定义 | Docker/K8s 部署 |

---

## 9. 健康检查与可观测

| 信号 | 端点/来源 | 备注 |
|---|---|---|
| 存活探针 | `/actuator/health/liveness` | 5xx 后由编排重启 |
| 就绪探针 | `/actuator/health/readiness` | 启动后才接收流量 |
| 综合健康 | `/actuator/health` | 包含所有组件状态 |
| Prometheus 指标 | `/actuator/prometheus` | `codepilot_*` 自定义指标 |
| 分布式追踪 | OTLP → `OTEL_EXPORTER_OTLP_ENDPOINT` | 按 traceId 透传 |
| 日志 | stdout JSON | 收集到 Loki / ELK |
| 版本信息 | `/v1/version` | 快速确认部署版本 |

---

## 10. 安全清单

部署前必须确认:

- [ ] 所有 `*_SECRET` 由 KMS / Sealed Secrets / Vault 提供；不在镜像或仓库中
- [ ] HTTPS 卸载在负载均衡 (mTLS 可选)
- [ ] JWT/HMAC 密钥位长度 ≥ 256 bit
- [ ] 限流：网关每用户 60 req/min、每设备 30 并发流
- [ ] 生产环境 `CODEPILOT_SSO_DEV_ENABLED=false`
- [ ] 生产 DB 与 Redis 仅允许 VPC 内部访问
- [ ] 定期轮换密钥；泄露时立即更换
- [ ] `prod.env` 文件权限 600，不提交到 Git

---

## 11. 故障排查

| 症状 | 排查方法 |
|---|---|
| 启动报 `env variable * is required` | 缺少必填环境变量；按 §2 补齐 |
| Flyway 报版本冲突 | 不要修改已发版的 `V*` 文件；新增 `V(n+1)__*` |
| SSE 客户端 5 秒后断开 | 检查反向代理 `proxy_read_timeout ≥ 120s` 并关闭 buffer |
| 插件无法连后端 | 用 `/v1/version` 自检；检查 Base URL 配置 |
| Docker 容器 OOM | 增大 `deploy.resources.limits.memory` |
| K8s Pod CrashLoopBackOff | `kubectl logs` 查看启动日志；通常是环境变量缺失 |
| 数据库连接超时 | 检查网络策略/安全组；确认 DB 允许来源 IP |

---

更多接口契约见 [`docs/05-接口文档.md`](docs/05-接口文档.md)；后端模块设计见 [`docs/03-后端设计.md`](docs/03-后端设计.md)；插件设计见 [`docs/02-插件端设计.md`](docs/02-插件端设计.md)。