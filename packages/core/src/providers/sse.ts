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
      const { value, done } = await reader.read();
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
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
  }
}
