"use client";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import { IconExternal } from "@/components/ui/icons";
import { startQuickCreate } from "../actions";
import { Alert, Notice } from "./shared";

type StatusBody = {
  connected: boolean;
  pendingToken: boolean;
  /** AWS called back; we are creating resources in the account right now. */
  inFlight: boolean;
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
 * link is rendered instead.
 *
 * Polling stops on exactly one of four things: the connection appears, the
 * server reports a recorded failure, the token is gone *and* no callback is
 * in flight, or the network stays down. That third condition is the fix for
 * "the one-click always expires": the callback burns the token before it
 * starts provisioning, so for the tens of seconds that provisioning takes,
 * "no token" and "not connected" were both true and the old code read them as
 * expiry. See `services/setup-tokens.ts`.
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
  /** True once AWS has called back, so the copy can stop saying "click Create stack". */
  const [provisioning, setProvisioning] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  // Resume polling if the owner comes back with a callback still outstanding.
  useEffect(() => {
    let cancelled = false;
    fetchStatus().then((s) => {
      if (cancelled || s.kind !== "ok") return;
      if (s.body.pendingToken || s.body.inFlight) {
        setProvisioning(s.body.inFlight);
        setPolling(true);
      } else if (s.body.lastFailure) setFailure(s.body.lastFailure.reason);
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
      setProvisioning(false);
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
        setProvisioning(false);
        router.refresh();
        return;
      }
      setProvisioning(body.inFlight);
      if (!body.pendingToken && !body.inFlight) {
        // Whether the link is still live is the server's call: /status reports
        // an unconsumed, unexpired token per the database clock, and a
        // consumed one whose callback is still running. Re-checking
        // `expiresAt` against `Date.now()` here compared a server timestamp to
        // the browser's, so any machine running fast was told the link had
        // expired while CloudFormation was still going.
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
      <div className="flex flex-wrap items-center gap-3">
        <Button
          onClick={open}
          loading={pending}
          disabled={!available || polling}
          icon={<IconExternal />}
        >
          Open AWS console
        </Button>
        {polling && (
          <span className="flex items-center gap-2 text-sm text-white/65">
            <Spinner size={14} />
            {provisioning
              ? "Setting up SES in your account…"
              : "Waiting for CloudFormation…"}
          </span>
        )}
      </div>
      {polling && (
        <p className="text-sm text-white/65">
          {provisioning ? (
            <>
              AWS has handed the keys back. We are creating the configuration
              set, the events topic and its subscription — this takes under a
              minute. Leave this page open.
            </>
          ) : (
            <>
              Click <strong>Create stack</strong> in the tab we opened and
              acknowledge the IAM capability checkbox. This page updates on its
              own.
            </>
          )}
        </p>
      )}
      {fallbackUrl && (
        <p className="text-sm text-white/65">
          Your browser blocked the popup.{" "}
          <a
            className="text-indigo-300 underline underline-offset-2"
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
