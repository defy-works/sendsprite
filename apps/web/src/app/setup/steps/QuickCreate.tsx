"use client";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import { startQuickCreate } from "../actions";
import { Alert, Notice } from "./shared";

type StatusBody = {
  connected: boolean;
  pendingToken: boolean;
  lastFailure?: { at: string; reason: string } | null;
};
type StatusFetch =
  | { kind: "ok"; body: StatusBody }
  | { kind: "unauthorized" }
  | { kind: "failed" };

const POLL_MS = 3000;
/** Consecutive failed polls before giving up (~1 min at POLL_MS). */
const MAX_FAILURES = 20;

/**
 * Shown when the token is gone before the callback landed. It deliberately
 * does not say "open a new one" on its own: if the stack is still creating,
 * its callback will be refused, and the template treats a non-2xx as FAILED —
 * so the stack rolls itself back and deletes the IAM user. Starting a second
 * stack on top of that one collides on the stack name.
 */
const EXPIRED =
  "The one-click link expired before AWS called back. If the stack is still " +
  "creating, let it finish — it will roll back and clean itself up — then " +
  "open a new link.";

/**
 * One-click flow. The popup is opened synchronously on click (before the
 * server action resolves) so popup blockers let it through; the URL is
 * assigned once the token is issued. If the popup was still blocked, the
 * link is rendered instead. Status is polled until the callback lands, the
 * token expires, the session dies, or the network stays down.
 */
export function QuickCreate({
  region,
  available,
}: {
  region: string;
  available: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [fallbackUrl, setFallbackUrl] = useState<string | null>(null);
  const [polling, setPolling] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  // Resume polling if the owner comes back with a callback still outstanding.
  useEffect(() => {
    let cancelled = false;
    fetchStatus().then((s) => {
      if (cancelled || s.kind !== "ok") return;
      if (s.body.pendingToken) setPolling(true);
      else if (s.body.lastFailure) setFailure(s.body.lastFailure.reason);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!polling) return;
    let stopped = false;
    let failures = 0;
    const stop = (msg: string | null) => {
      setPolling(false);
      setFailure(msg);
    };
    const tick = async () => {
      const s = await fetchStatus();
      if (stopped) return;
      if (s.kind === "unauthorized")
        return stop("Session expired — reload the page.");
      if (s.kind === "failed") {
        if (++failures >= MAX_FAILURES)
          stop("Could not reach the server; reload the page and try again.");
        return;
      }
      failures = 0;
      const { body } = s;
      if (body.connected) {
        setPolling(false);
        router.refresh();
      } else if (!body.pendingToken) {
        // Whether the token is still live is the server's call: /status only
        // reports one that is unconsumed AND unexpired per the database clock.
        // Re-checking `expiresAt` against Date.now() here compared a server
        // timestamp to the browser's clock, so any machine running ahead was
        // told the link had expired while CloudFormation was still running.
        stop(body.lastFailure?.reason ?? EXPIRED);
      }
    };
    const id = setInterval(() => void tick(), POLL_MS);
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, [polling, router]);

  const open = () => {
    setError(null);
    setFailure(null);
    setFallbackUrl(null);
    const w = window.open("", "_blank");
    if (w) w.opener = null;
    const fd = new FormData();
    fd.set("region", region);
    start(async () => {
      const res = await startQuickCreate(fd);
      if (!res.ok) {
        w?.close();
        setError(res.error);
        return;
      }
      if (w) w.location.href = res.data.url;
      else setFallbackUrl(res.data.url);
      setPolling(true);
    });
  };

  return (
    <div className="flex flex-col gap-3">
      {!available && (
        <Notice>
          One-click connect needs a public https APP_URL; use manual keys
          locally.
        </Notice>
      )}
      <div className="flex items-center gap-3">
        <Button onClick={open} disabled={!available || pending || polling}>
          {pending ? "Preparing…" : "Open AWS console"}
        </Button>
        {polling && (
          <span className="flex items-center gap-2 text-sm text-white/65">
            <Spinner size={14} /> Waiting for CloudFormation…
          </span>
        )}
      </div>
      {polling && (
        <p className="text-sm text-white/65">
          Click <strong>Create stack</strong> in the tab we opened and
          acknowledge the IAM capability checkbox. This page updates on its own.
        </p>
      )}
      {fallbackUrl && (
        <p className="text-sm text-white/65">
          Your browser blocked the popup.{" "}
          <a
            className="text-indigo-300 underline"
            href={fallbackUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            Open the AWS console
          </a>
          .
        </p>
      )}
      {error && <Alert>{error}</Alert>}
      {failure && <Alert>{failure}</Alert>}
    </div>
  );
}

async function fetchStatus(): Promise<StatusFetch> {
  try {
    const r = await fetch("/api/setup/aws/status", { cache: "no-store" });
    if (r.status === 401) return { kind: "unauthorized" };
    if (!r.ok) return { kind: "failed" };
    return { kind: "ok", body: (await r.json()) as StatusBody };
  } catch {
    return { kind: "failed" };
  }
}
