import { listenTeam } from "@/lib/notify";

const PING_MS = 25_000;

/**
 * SSE response for a team's change feed (`event: change`, data = the
 * `notifyTeam` payload); served to the dashboard by api/stream and to API
 * keys by api/v1/stream. A `: ping` comment every 25 s keeps proxies from
 * closing the idle connection. Cleanup (ping timer, LISTEN subscription,
 * stream close) runs exactly once, on client abort, stream cancel, or a
 * failed write; an abort that lands while the LISTEN is still being set up
 * is honoured too.
 */
export function teamChangeStream(
  teamId: string,
  signal: AbortSignal,
): Response {
  const enc = new TextEncoder();
  let cleaned = false;
  let ping: ReturnType<typeof setInterval> | undefined;
  let unlisten: (() => Promise<void>) | undefined;
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    clearInterval(ping);
    await unlisten?.().catch(() => undefined);
    try {
      controller?.close();
    } catch {
      // already closed by the client
    }
  };
  const send = (chunk: string) => {
    if (cleaned) return;
    try {
      controller?.enqueue(enc.encode(chunk));
    } catch {
      void cleanup();
    }
  };
  const stream = new ReadableStream<Uint8Array>({
    async start(c) {
      controller = c;
      signal.addEventListener("abort", () => void cleanup(), { once: true });
      const sub = await listenTeam(teamId, (payload) =>
        send(`event: change\ndata: ${payload}\n\n`),
      );
      // The abort may have fired while LISTEN was being set up: `cleanup`
      // already ran with `unlisten` unset, so drop the subscription here.
      if (cleaned) {
        await sub().catch(() => undefined);
        return;
      }
      unlisten = sub;
      ping = setInterval(() => send(": ping\n\n"), PING_MS);
      send(": connected\n\n");
    },
    cancel: cleanup,
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      "x-accel-buffering": "no",
    },
  });
}
