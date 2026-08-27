"use client";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

const DEBOUNCE_MS = 500;

/**
 * Re-renders the current server component tree whenever the team's SSE
 * feed (`/api/stream`) reports a change. Bursts (a batch send, a webhook
 * fan-out) collapse into one refresh. EventSource reconnects on its own.
 */
export function useTeamStream() {
  const router = useRouter();
  useEffect(() => {
    const es = new EventSource("/api/stream");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onChange = () => {
      clearTimeout(timer);
      timer = setTimeout(() => router.refresh(), DEBOUNCE_MS);
    };
    es.addEventListener("change", onChange);
    return () => {
      clearTimeout(timer);
      es.close();
    };
  }, [router]);
}
