import { listenTeam } from "@/lib/notify";
import { requireTeam } from "@/lib/session";

export const dynamic = "force-dynamic";

const PING_MS = 25_000;

/**
 * SSE feed of the active team's changes (`event: change`, data = the
 * `notifyTeam` payload). The dashboard's `useTeamStream` refreshes on it.
 * A `: ping` comment every 25 s keeps proxies from closing the idle
 * connection; the LISTEN subscription is dropped when the client goes away.
 */
export async function GET(req: Request): Promise<Response> {
  const { team } = await requireTeam();
  const enc = new TextEncoder();
  let cleanup = async () => {};
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let open = true;
      const send = (chunk: string) => {
        if (!open) return;
        try {
          controller.enqueue(enc.encode(chunk));
        } catch {
          open = false;
        }
      };
      const unlisten = await listenTeam(team.id, (payload) =>
        send(`event: change\ndata: ${payload}\n\n`),
      );
      const ping = setInterval(() => send(": ping\n\n"), PING_MS);
      cleanup = async () => {
        if (!open) return;
        open = false;
        clearInterval(ping);
        await unlisten().catch(() => undefined);
        try {
          controller.close();
        } catch {
          // already closed by the client
        }
      };
      req.signal.addEventListener("abort", () => void cleanup(), {
        once: true,
      });
      send(": connected\n\n");
    },
    cancel() {
      void cleanup();
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      "x-accel-buffering": "no",
    },
  });
}
