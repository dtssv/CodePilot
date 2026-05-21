# Graph engine — cluster deployment & scale

## Stateless vs sticky resources

| Component | Storage | Cluster note |
|-----------|---------|----------------|
| `GraphCheckpointStore` | Redis | Safe — any replica can resume |
| `ToolResultBus` | In-JVM futures + Redis pub/sub | Tool HTTP may hit another replica; Redis bridges to the worker awaiting the result |
| `StopSignalBus` | Redis pub/sub | Stop reaches the replica holding the SSE stream |
| `GraphSseHelper` session sinks | In-JVM only | Run must stay on one replica until complete (see queue + lease) |
| `McpToolExecutor` session cache | In-JVM | Re-registered at intake on the worker executing the run |
| Graph `OverAllState` during `invoke` | In-JVM heap | Not migrated mid-flight; checkpoint only at interrupts |

## Required production settings

1. **Redis** — tool results, stop signals, checkpoints, run event bus, admission counters.
2. **DB-backed conversation queue** — `codepilot.conversation.queue.persistence=db` and `enabled=true` (or `auto`) so each run is claimed by one worker (`ConversationRunWorker` lease).
3. **Admission control** — `codepilot.conversation.admission.enabled=true` (default) rejects or delays runs before the DB queue grows without bound.
4. **Do not bypass the queue** for AGENT/graph mode in multi-replica deployments.
5. **Tune per pod**: `codepilot.graph.scheduler-thread-cap`, `codepilot.conversation.admission.max-worker-concurrent`.
6. **MySQL / Redis pools** — size for `(replicas × worker concurrent)` + API overhead, not registered user count.

## Admission control (server + client)

### Server

| Layer | Behavior |
|-------|----------|
| `ConversationRunAdmissionFilter` | Read-only Redis check → **HTTP 429** + `Retry-After` before SSE opens (`42902` queue full) |
| `ConversationQueuedOrchestrator` | Atomic Redis **enqueue** increment; rolls back on DB insert failure |
| `ConversationRunWorker` | Per-pod **semaphore** (`max-worker-concurrent`); `onRunStarted` / `onRunFinished` moves queued→running counters |
| `GET /v1/conversation/runs/admission` | Plugin probe: `{ admit, retryAfterSec, globalQueued, … }` |

Config (`application.yml` → `codepilot.conversation.admission`):

| Key | Default | Meaning |
|-----|---------|---------|
| `max-global-queued` | 5000 | Cluster-wide queued cap |
| `max-global-running` | 800 | Cluster-wide executing cap |
| `max-user-queued` | 8 | Per-user queued cap |
| `max-user-running` | 2 | Per-user executing cap |
| `max-worker-concurrent` | 32 | Graph executions per pod |
| `retry-after-seconds` | 30 | Suggested client backoff |

### Plugin (client-side back-pressure)

1. **Before** `POST /v1/conversation/run` (agent mode): poll `/v1/conversation/runs/admission` with exponential wait (`ConversationRunAdmission.waitForCapacity`, up to ~90s).
2. On **HTTP 429** / `42902`: re-queue the message locally, show `server_backoff`, sleep `Retry-After`, then retry (max 8 attempts) — **does not** hammer the server queue.
3. Local **message queue** (`pendingUserMessages`) still serializes multiple user sends per panel.

Gateway limits (unchanged): per-minute rate limit, per-session lock, per-device concurrent streams.

## DB queue + lease — what it guarantees

| Guarantee | Mechanism |
|-----------|-----------|
| One worker per run | `tryClaim` + `lease_until` |
| Crash recovery | Reclaimer + lease expiry (`reclaim-batch-size` per tick) |
| SSE attach on any replica | `conversation_run_events` + Redis `ConversationRunEventBus` |
| No duplicate graph on same session | `SessionLockFilter` + `RunLifecycleRegistry` → `StopSignalBus` |

**Does not guarantee:** unlimited throughput. It guarantees **correctness** and **fair scheduling** under load.

## Capacity planning (extreme spike)

Let:

- `P` = number of backend pods  
- `W` = `max-worker-concurrent` per pod  
- `T` = average agent run duration (seconds)  

**Steady throughput** ≈ `(P × W) / T` completed runs per second. Example: `P=50`, `W=32`, `T=90` → ~18 runs/s → clearing 100k queued runs ≈ **90+ minutes** (plus LLM/DB limits).

**Bottlenecks (in order):**

1. LLM provider rate / AppKey concurrency  
2. `conversation_run_events` write rate  
3. Redis pub/sub fan-out  
4. Graph CPU (usually after the above)

**Registered users ≠ concurrent runs.** Size for **peak simultaneous agent runs**, not total accounts.

## 100k+ users — realistic posture

| Scenario | Approach |
|----------|----------|
| Normal traffic | Queue + lease + horizontal pods |
| Launch / flash crowd | Admission 429 + **plugin wait**; optional product message “排队中” |
| True 10k simultaneous agent | Impossible on single stack without tiered product (async jobs, batch overnight, enterprise pool) |

## Graceful deploy

- `DeployDrainService` + `/actuator/drain` reject new runs (`503` + `Retry-After`).
- In-flight runs → `interrupted`; reclaimer resumes within `interrupted-reclaim-max-age`.

## Related code

- `ConversationRunAdmissionService`, `ConversationRunAdmissionFilter`
- `ConversationQueuedOrchestrator`, `ConversationRunWorker`
- Plugin: `ConversationRunAdmission.kt`, `CefChatPanel.handleStreamRateLimited`
