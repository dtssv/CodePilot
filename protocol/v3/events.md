# CodePilot Harness Protocol v3 — Events

> Source of truth: `protocol/v3/events.schema.json` (JSON Schema Draft-07).
> All harness session logs (`.codepilot/events.jsonl`) MUST conform to this schema.

## Format

- **Transport**: NDJSON — one JSON object per line, UTF-8, no BOM.
- **Line structure**: `{"type": "<event_type>", "seq": <int>, "ts": <epoch_ms>, ...}`
- **`seq`** is monotonic within a session file and assigned by `SessionStore.append`. New sessions start at 0. Replay must preserve `seq` ordering.
- **`ts`** is Unix epoch milliseconds (`System.currentTimeMillis()`).

## Event types

| `type`                    | Emitted by              | Notes |
| ------------------------- | ----------------------- | ----- |
| `run_started`             | `AgentHarness.run`      | First event in any session. Carries `session_id` + `goal`. |
| `user_message_added`      | `AgentHarness.run`      | User input or an injected follow-up (e.g. a `StopDirective.Continue.reason`). |
| `assistant_message_added` | `AgentHarness.run`      | One per model turn; `text` is the concatenation of `TextDelta`s, `tool_calls` is the parallel list of `AssistantToolCall`. |
| `tool_result_added`       | `AgentHarness.run`      | One per executed tool call; `ok` is `ToolOutput.ok`; `output` is the (truncated) stdout/stderr. |
| `permission_decision_recorded` | `AgentHarness.run` | Records the `Verdict` (allow/ask/deny) for a tool call. |
| `compaction_applied`      | `Compactor.maybeCompact` | Inserted before the compacted tail; `dropped_messages` is how many were summarized. |
| `run_finished`            | `AgentHarness.run`      | Terminal event. `status` ∈ {`completed`, `max_steps_reached`, `error`}. |

## Lifecycle

```
run_started
├── user_message_added (goal)
├── assistant_message_added
│   ├── tool_result_added (per call)
│   ├── permission_decision_recorded (if Ask)
│   └── (loop)
├── compaction_applied (optional, when budget exceeded)
└── run_finished
```

## Replay & rewind

- **Replay**: `EventSourcedSession.replayAll()` reads all events in order and rebuilds the in-memory projection. Never mutates the file.
- **Rewind**: `EventSourcedSession.rewindTo(seqExclusive)` truncates the file after `seqExclusive` and replays. Used by the IDE adapter for "undo last turn".
- **Fork**: copy the file up to `seqExclusive` into a new session file and continue from there.

## Backward compatibility

- Adding a new event type is a **minor** version bump (v3 → v3.1). Old readers MUST skip unknown `type` values (the `oneOf` in the schema allows extra branches).
- Adding a new field to an existing event type is a **minor** bump. Readers MUST use `ignoreUnknownKeys = true`.
- Renaming or removing a field or event type is a **major** bump (v3 → v4) and requires migration tooling.

## Validation

- Both the `plugin` and `backend` Gradle builds register a `validateEventsJson` task that runs `events.schema.json` against a golden corpus of NDJSON fixtures.
- A CI failure on `validateEventsJson` means a harness-core change broke wire-format compatibility — fix the schema or the emitter, do not silently bump the version.
