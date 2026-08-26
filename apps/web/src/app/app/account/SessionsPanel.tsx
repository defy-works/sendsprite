"use client";
import { useEffect, useState, useTransition } from "react";
import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Skeleton } from "@/components/ui/Skeleton";
import { IconLogOut } from "@/components/ui/icons";
import { useConfirm } from "@/components/ui/confirm";
import { useToast } from "@/components/ui/toast";
import { authClient } from "@/lib/auth-client";

interface Row {
  id: string;
  token: string;
  createdAt: Date;
  expiresAt: Date;
  ipAddress?: string | null;
  userAgent?: string | null;
}

/**
 * A user agent is a paragraph; this is the two facts anyone reads off it.
 *
 * Order matters: Edge and Opera both put "Chrome" in their string, and Chrome
 * puts "Safari" in its own, so the specific names have to be tested first or
 * every browser on earth reports as Chrome or Safari.
 */
function describe(ua: string | null | undefined): string {
  if (!ua) return "Unknown device";
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /OPR\//.test(ua)
      ? "Opera"
      : /Firefox\//.test(ua)
        ? "Firefox"
        : /Chrome\//.test(ua)
          ? "Chrome"
          : /Safari\//.test(ua)
            ? "Safari"
            : "Browser";
  const os = /Windows/.test(ua)
    ? "Windows"
    : /Android/.test(ua)
      ? "Android"
      : /iPhone|iPad|iOS/.test(ua)
        ? "iOS"
        : /Mac OS X|Macintosh/.test(ua)
          ? "macOS"
          : /Linux/.test(ua)
            ? "Linux"
            : "Unknown OS";
  return `${browser} on ${os}`;
}

const when = (d: Date) =>
  new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(d));

export function SessionsPanel({ currentToken }: { currentToken: string }) {
  const confirm = useConfirm();
  const toast = useToast();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const load = async () => {
    const res = await authClient.listSessions();
    if (res.error)
      return setError(res.error.message ?? "Could not list your sessions.");
    setRows(res.data as Row[]);
  };

  useEffect(() => {
    void load();
    // Once, on mount: sessions do not change while this page is open unless
    // this panel is what changed them, and those paths reload explicitly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const revokeOthers = async () => {
    const ok = await confirm({
      title: "Sign out everywhere else?",
      body: "Every browser and device other than this one is signed out immediately. This one stays signed in.",
      confirmLabel: "Sign out others",
      tone: "danger",
    });
    if (!ok) return;
    start(async () => {
      setError(null);
      const res = await authClient.revokeOtherSessions();
      if (res.error)
        return setError(res.error.message ?? "Could not sign the others out.");
      toast({ tone: "success", title: "Other sessions signed out" });
      await load();
    });
  };

  const revoke = async (r: Row) => {
    const ok = await confirm({
      title: `Sign out ${describe(r.userAgent)}?`,
      body: "That device has to sign in again to reach this account.",
      confirmLabel: "Sign it out",
      tone: "danger",
    });
    if (!ok) return;
    start(async () => {
      setError(null);
      const res = await authClient.revokeSession({ token: r.token });
      if (res.error)
        return setError(res.error.message ?? "Could not sign it out.");
      toast({ tone: "success", title: "Signed out" });
      await load();
    });
  };

  if (rows === null && error === null)
    return (
      <div className="flex flex-col gap-2">
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
      </div>
    );

  const others = (rows ?? []).filter((r) => r.token !== currentToken);

  return (
    <div className="flex flex-col gap-4">
      <ul className="flex flex-col gap-2">
        {(rows ?? []).map((r) => {
          const isCurrent = r.token === currentToken;
          return (
            <li
              key={r.id}
              className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-md border border-white/8 bg-white/3 px-3.5 py-3"
            >
              <div className="min-w-48 flex-1">
                <p className="flex items-center gap-2 text-sm">
                  {describe(r.userAgent)}
                  {isCurrent && <Badge variant="success">This device</Badge>}
                </p>
                <p className="text-xs text-white/50">
                  {r.ipAddress ? `${r.ipAddress} · ` : ""}Signed in{" "}
                  {when(r.createdAt)} · expires {when(r.expiresAt)}
                </p>
              </div>
              {!isCurrent && (
                <Button
                  size="sm"
                  variant="subtle"
                  disabled={pending}
                  onClick={() => void revoke(r)}
                >
                  Sign out
                </Button>
              )}
            </li>
          );
        })}
      </ul>
      {others.length > 0 && (
        <div>
          <Button
            variant="dangerSubtle"
            icon={<IconLogOut />}
            loading={pending}
            onClick={() => void revokeOthers()}
          >
            Sign out everywhere else ({others.length})
          </Button>
        </div>
      )}
      {others.length === 0 && rows !== null && (
        <p className="text-sm text-white/55">
          This is the only device signed in to your account.
        </p>
      )}
      {error && <Alert>{error}</Alert>}
    </div>
  );
}
