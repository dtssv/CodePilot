// Minimal SSE (text/event-stream) parser over a ReadableStream<Uint8Array>.
// Yields decoded `data: ...` payloads. Honours `event:`, multi-line data,
// keep-alive comments and SSE terminators.

export interface SseFrame {
  event: string;
  data: string;
}

const decoder = new TextDecoder("utf-8");

export async function* parseSse(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal
): AsyncIterable<SseFrame> {
  const reader = stream.getReader();
  let buffer = "";
  let currentEvent = "message";
  let dataLines: string[] = [];

 // Abort must interrupt a blocked `reader.read` immediately — not only
 // between chunks. The model often stalls mid-generation (slow token, or no
 // first token yet); if we only checked the flag at the top of the loop, a
 // cancel would sit parked inside `await reader.read` until the next chunk
 // happened to arrive, so the "stop" button appeared dead. We race each read
 // against an abort promise and cancel the reader the moment the signal fires.
  let abortReject: ((e: unknown) => void) | null = null;
  const abortPromise = new Promise<never>((_, reject) => {
    abortReject = reject;
  });
 // Never let this promise surface as an unhandled rejection: when the normal
 // read path wins the race (or the stream ends), nothing awaits abortPromise,
 // so a later reject would otherwise be reported as unhandled.
  abortPromise.catch(() => {});
  const onAbort = (): void => {
    abortReject?.(new DOMException("aborted", "AbortError"));
    void reader.cancel().catch(() => {});
  };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }

  try {
    while (true) {
      if (signal?.aborted) {
        try {
          await reader.cancel();
        } catch {
 /* ignore */
        }
        return;
      }
      let value: Uint8Array | undefined;
      let done = false;
      try {
 // Whichever settles first: the next chunk, or an abort.
        const r = await Promise.race([reader.read(), abortPromise]);
        value = r.value;
        done = r.done;
      } catch {
 // Abort fired while blocked on read — stop cleanly.
        return;
      }
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

 // Process complete lines.
      let idx: number;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        let line = buffer.slice(0, idx);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        buffer = buffer.slice(idx + 1);
        if (line === "") {
 // Dispatch the event.
          if (dataLines.length > 0) {
            yield { event: currentEvent, data: dataLines.join("\n") };
          }
          currentEvent = "message";
          dataLines = [];
          continue;
        }
        if (line.startsWith(":")) {
 // Comment, ignore.
          continue;
        }
        const colon = line.indexOf(":");
        if (colon < 0) continue;
        const field = line.slice(0, colon);
        let valuePart = line.slice(colon + 1);
        if (valuePart.startsWith(" ")) valuePart = valuePart.slice(1);
        if (field === "event") {
          currentEvent = valuePart;
        } else if (field === "data") {
          dataLines.push(valuePart);
        } else if (field === "id" || field === "retry") {
 // Not used.
        }
      }
    }
 // Flush any trailing event without a final blank line.
    if (dataLines.length > 0) {
      yield { event: currentEvent, data: dataLines.join("\n") };
    }
  } finally {
    if (signal) signal.removeEventListener("abort", onAbort);
    try {
      reader.releaseLock();
    } catch {
 /* ignore */
    }
  }
}
