import { describe, expect, it } from "vitest";
import {
  ErrorCode,
  Peer,
  RpcError,
  type JsonRpcId,
  type RpcTransport,
} from "../src/rpc.js";

/**
 * A pair of in-memory line transports. Lines written to `a` become readable
 * from `b` and vice versa. Each peer gets its own transport.
 */
function makeTransportPair(): {
  aToB: RpcTransport;
  bToA: RpcTransport;
} {
  const aBuffer: string[] = [];
  const bBuffer: string[] = [];
  let aWaiter: ((line: string | null) => void) | null = null;
  let bWaiter: ((line: string | null) => void) | null = null;
  let aClosed = false;
  let bClosed = false;

  return {
    aToB: {
      write: (line) => {
        if (bClosed) throw new Error("b closed");
        if (bWaiter) {
          const w = bWaiter;
          bWaiter = null;
          w(line.replace(/\n$/, ""));
        } else {
          bBuffer.push(line.replace(/\n$/, ""));
        }
      },
      readLine: () => {
        if (aClosed) return Promise.resolve(null);
        if (aBuffer.length > 0) return Promise.resolve(aBuffer.shift()!);
        return new Promise((resolve) => (aWaiter = resolve));
      },
      close: () => {
        aClosed = true;
        if (aWaiter) {
          const w = aWaiter;
          aWaiter = null;
          w(null);
        }
      },
    },
    bToA: {
      write: (line) => {
        if (aClosed) throw new Error("a closed");
        if (aWaiter) {
          const w = aWaiter;
          aWaiter = null;
          w(line.replace(/\n$/, ""));
        } else {
          aBuffer.push(line.replace(/\n$/, ""));
        }
      },
      readLine: () => {
        if (bClosed) return Promise.resolve(null);
        if (bBuffer.length > 0) return Promise.resolve(bBuffer.shift()!);
        return new Promise((resolve) => (bWaiter = resolve));
      },
      close: () => {
        bClosed = true;
        if (bWaiter) {
          const w = bWaiter;
          bWaiter = null;
          w(null);
        }
      },
    },
  };
}

async function settled() {
  // Yield twice so queued microtasks (handleLine) drain.
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

describe("rpc / Peer", () => {
  it("handles a successful request/response round-trip", async () => {
    const { aToB, bToA } = makeTransportPair();
    const a = new Peer({ transport: aToB, debug: false });
    const b = new Peer({ transport: bToA, debug: false });

    b.onRequest("echo", (params: { v: number }) => ({ doubled: params.v * 2 }));

    const res = await a.request<{ v: number }, { doubled: number }>("echo", { v: 21 });
    expect(res).toEqual({ doubled: 42 });

    await a.close();
    await b.close();
  });

  it("propagates server-side errors as RpcError", async () => {
    const { aToB, bToA } = makeTransportPair();
    const a = new Peer({ transport: aToB, debug: false });
    const b = new Peer({ transport: bToA, debug: false });

    b.onRequest("boom", () => {
      throw new RpcError(ErrorCode.InternalError, "kaboom");
    });

    await expect(a.request("boom")).rejects.toMatchObject({
      code: ErrorCode.InternalError,
      message: "kaboom",
    });

    await a.close();
    await b.close();
  });

  it("replies with MethodNotFound for unknown methods", async () => {
    const { aToB, bToA } = makeTransportPair();
    const a = new Peer({ transport: aToB, debug: false });
    const b = new Peer({ transport: bToA, debug: false });

    await expect(a.request("missing")).rejects.toMatchObject({
      code: ErrorCode.MethodNotFound,
    });

    await a.close();
    await b.close();
  });

  it("delivers a notification (no reply)", async () => {
    const { aToB, bToA } = makeTransportPair();
    const a = new Peer({ transport: aToB, debug: false });
    const b = new Peer({ transport: bToA, debug: false });

    const seen: unknown[] = [];
    b.onNotification("ping", (params) => {
      seen.push(params);
    });

    await a.notify("ping", { hello: "world" });
    await settled();
    expect(seen).toEqual([{ hello: "world" }]);

    await a.close();
    await b.close();
  });

  it("supports server→client reverse requests", async () => {
    const { aToB, bToA } = makeTransportPair();
    // a acts as "server", b as "client" for this round-trip.
    const a = new Peer({ transport: aToB, debug: false });
    const b = new Peer({ transport: bToA, debug: false });

    // Client (b) responds to the reverse request.
    b.onRequest<{ q: string }, string>("ask", ({ q }) => `answer:${q}`);
    // Server (a) issues it.
    const ans = await a.request<{ q: string }, string>("ask", { q: "hi" });
    expect(ans).toBe("answer:hi");

    await a.close();
    await b.close();
  });

  it("assigns unique ids so concurrent requests don't collide", async () => {
    const { aToB, bToA } = makeTransportPair();
    const a = new Peer({ transport: aToB, debug: false });
    const b = new Peer({ transport: bToA, debug: false });

    const seenIds: JsonRpcId[] = [];
    b.onRequest("id", (params: { v: number }) => {
      seenIds.push(params.v as unknown as JsonRpcId);
      return { ok: true, v: params.v };
    });

    const results = await Promise.all(
      [1, 2, 3, 4, 5].map((v) =>
        a.request<{ v: number }, { ok: boolean; v: number }>("id", { v }),
      ),
    );
    expect(results.map((r) => r.v)).toEqual([1, 2, 3, 4, 5]);
    await a.close();
    await b.close();
  });

  it("rejects parse errors with code -32700", async () => {
    const { aToB, bToA } = makeTransportPair();
    // Only construct the *server-side* peer; the test injects a malformed
    // line directly into its incoming buffer and reads the resulting error
    // envelope. We don't construct the client peer so we don't race with its
    // reader.
    const b = new Peer({ transport: bToA, debug: false });

    // Push a malformed line into b's read side (aToB.write → bBuffer).
    aToB.write("not json at all\n");
    await settled();
    // The peer emits a parse-error envelope via bToA.write → aBuffer. Read
    // from a's incoming side (aToB.readLine → aBuffer).
    const reply = await aToB.readLine();
    const parsed = JSON.parse(reply!);
    expect(parsed.jsonrpc).toBe("2.0");
    expect(parsed.id).toBeNull();
    expect(parsed.error.code).toBe(ErrorCode.ParseError);

    await b.close();
  });

  it("rejects all pending requests when the peer closes", async () => {
    const { aToB, bToA } = makeTransportPair();
    // Only construct peer a; nobody on the other side will ever read, so the
    // pending request can never get a response — exactly the "remote died
    // mid-request" condition we want to exercise.
    const a = new Peer({ transport: aToB, debug: false });
    // Eat any incoming lines on bToA so they don't pile up; do not start a
    // peer on the other side.
    void bToA;

    const req = a.request("noop");
    await settled();
    // Closing a must reject the still-outstanding request.
    await a.close();
    await expect(req).rejects.toMatchObject({ code: ErrorCode.InternalError });
  });

  it("rejects pending requests when the transport returns null (peer disconnected)", async () => {
    const { aToB, bToA } = makeTransportPair();
    // Same one-sided setup. We never start a peer on b's side, so the
    // request sits in flight. Closing a's incoming socket means the read loop
    // resolves null on its next readLine, triggering transport-closed
    // rejection.
    const a = new Peer({ transport: aToB, debug: false });
    void bToA;

    const req = a.request("noop");
    await settled();
    aToB.close?.();
    await expect(req).rejects.toMatchObject({ code: ErrorCode.InternalError });

    await a.close();
  });
});