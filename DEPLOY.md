# DEPLOY.md — CodePilot 部署手册

本手册包含三种部署形态：**本地开发**、**单机生产**（Docker Compose）和 **Kubernetes**。
最小目标：一条命令拉起依赖、构建镜像、启动应用，并通过 `/actuator/health` 与 `/v1/version` 验证存活。

---

## 1. 前置条件

| 项 | 版本 |
|---|---|
| JDK | Temurin 21 LTS |
| Docker / Docker Desktop | ≥ 24 |
| PostgreSQL | 16+（含 pgvector 扩展） |
| Redis | 7+ |
| Helm（仅 K8s 场景） | ≥ 3.12 |
| IntelliJ IDEA（仅插件开发） | 2024.2+ |

## 2. 环境变量

复制 [`backend/.env.example`](backend/.env.example) 到 `backend/.env`，按真实值修改。**所有 `*_SECRET` 必须 ≥ 32 字节随机字符串**；空值或默认值会让后端启动时显式失败。

| 变量 | 含义 | 是否必填 |
|---|---|---|
| `CODEPILOT_DB_URL` / `_USER` / `_PASSWORD` | Postgres JDBC | ✓ |
| `CODEPILOT_REDIS_URL` | Redis URL | ✓ |
| `CODEPILOT_LLM_BASE_URL` / `_API_KEY` / `_DEFAULT_MODEL` | LLM 上游（OpenAI 协议） | ✓ |
| `CODEPILOT_JWT_SECRET` / `CODEPILOT_HMAC_SECRET` | 鉴权与签名密钥 | ✓ |
| `CODEPILOT_SSO_SECRET` | SSO 桥接共享密钥（用于校验外部下发的 bootstrap token） | ✓ |
| `CODEPILOT_DB_POOL_MAX` | HikariCP 最大连接数 | ✗（默认 40） |
| `CODEPILOT_PORT` | 监听端口 | ✗（默认 8080） |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OpenTelemetry collector | ✗ |

## 3. 本地开发

```bash
# 3.1 启动依赖
docker compose -f scripts/deploy/docker-compose.dev.yml up -d
# Postgres :5432  Redis :6379  MinIO :9000/:9001  OTel :4317

# 3.2 构建并跑后端
cd backend
cp .env.example .env && vim .env   # 填值
set -a && source .env && set +a
./gradlew :codePilot-bootstrap:bootRun

# 3.3 验证
curl -s http://localhost:8080/actuator/health
curl -s http://localhost:8080/v1/version
open http://localhost:8080/swagger-ui.html
```

> Flyway 在启动时自动应用 `scripts/db/V*.sql`（已被构建打入 jar 内的 `classpath:db/migration`）。

## 4. 单机生产部署（Docker Compose）

最小生产示例：

```yaml
# scripts/deploy/docker-compose.prod.yml
name: codepilot-prod
services:
  app:
    image: ghcr.io/codepilot/codepilot-backend:1.0.0
    restart: always
    env_file: ./prod.env
    ports: ["8080:8080"]
    depends_on:
      - postgres
      - redis
    deploy:
      resources:
        limits: { cpus: '2.0', memory: 2G }
  postgres:
    image: pgvector/pgvector:pg16
    restart: always
    env_file: ./prod.env
    volumes: [ "pgdata:/var/lib/postgresql/data" ]
  redis:
    image: redis:7-alpine
    restart: always
    volumes: [ "redisdata:/data" ]
volumes:
  pgdata: {}
  redisdata: {}
```

```bash
# 构建镜像
docker build -f scripts/deploy/Dockerfile -t ghcr.io/codepilot/codepilot-backend:1.0.0 .

# 启动
docker compose -f scripts/deploy/docker-compose.prod.yml --env-file scripts/deploy/prod.env up -d
```

## 5. Kubernetes（Helm 模板，骨架）

```bash
# Helm values 见 scripts/deploy/helm/values.yaml
helm upgrade --install codepilot scripts/deploy/helm \
  --namespace codepilot --create-namespace \
  --set image.tag=1.0.0 \
  --set-file env.JWT_SECRET=secrets/jwt.txt
```

K8s 注意事项：
- 使用 `Deployment`（多副本）+ `HPA`（CPU/Memory + 自定义指标 `codepilot_inflight`）。
- 滚动更新策略 `maxSurge=25% maxUnavailable=0`，避免 SSE 长连接被同时切断。
- `terminationGracePeriodSeconds=60` 给在飞流足够清理时间。
- 探针：
  - `readinessProbe`: `/actuator/health/readiness`
  - `livenessProbe`:  `/actuator/health/liveness`
- 使用 `PodDisruptionBudget minAvailable=1`。
- DB 通过外部托管（Aurora / RDS / Cloud SQL）；不在 K8s 内部署有状态。

## 6. 数据库初始化

详见 [scripts/db/README.md](scripts/db/README.md)：
- 唯一变更入口是 `scripts/db/V*.sql`；
- 启动时由 Flyway 自动迁移；
- CI 用 Testcontainers 验证迁移可重复。

## 7. 插件部署

- 构建产物：`plugin/build/distributions/codePilot-<ver>.zip`。
- 分发渠道：
  1. **JetBrains Marketplace**：上传 zip 即可；
  2. **企业自托管**：把 zip 暴露在内网静态站点，IDE 中 `Settings → Plugins → ⚙ → Manage Plugin Repositories…` 添加 URL；
  3. **自更新通道**：插件启动时调用 `/v1/plugin/manifest`（详见接口文档 §10.5）。

## 8. 健康与可观测

| 信号 | 来源 | 备注 |
|---|---|---|
| 存活探针 | `/actuator/health/liveness` | 5xx 后由编排重启 |
| 就绪探针 | `/actuator/health/readiness` | 启动后才接收流量 |
| Prometheus 指标 | `/actuator/prometheus` | `codepilot_*` 自定义指标 |
| 分布式追踪 | OTLP → `OTEL_EXPORTER_OTLP_ENDPOINT` | 默认按 `traceId` 透传 |
| 日志 | stdout JSON | 收集到 Loki / ELK |

## 9. 安全清单（部署前必看）

- [ ] 所有 `*_SECRET` 由 KMS / Sealed Secrets / Vault 提供；不在镜像或仓库中。
- [ ] HTTPS 卸载在负载均衡（mTLS 可选）。
- [ ] `nimbus-jose-jwt` 的密钥位长度 ≥ 256 bit。
- [ ] 限流：网关每用户 60 req/min、每设备 30 并发流。
- [ ] 启用 `SystemPromptLeakFilter` 前后置（见后端 §11.1）。
- [ ] 生产 DB 与 Redis 仅允许 VPC 内部访问。

## 10. 故障排查

| 症状 | 排查 |
|---|---|
| 启动报 `env variable * is required` | 缺少必填环境变量；按 §2 补齐。 |
| Flyway 报版本冲突 | 不要修改已发版的 `V*` 文件；新增 `V(n+1)__*`。 |
| SSE 客户端 5 秒后断开 | 检查反向代理（如 nginx）的 `proxy_read_timeout` ≥ 120s 并关闭 buffer。 |
| 插件无法连后端 | 用 `/v1/version` 自检；若 IDE 卡死，参见 [插件设计 §15](docs/02-插件端设计.md) 强制状态重置。 |

---

更多接口契约见 [`docs/05-接口文档.md`](docs/05-接口文档.md)；后端模块设计见 [`docs/03-后端设计.md`](docs/03-后端设计.md)。