"use client";
import { useTeamStream } from "@/components/app/useTeamStream";

/** Mounts the team SSE feed so the server-rendered list re-fetches on change. */
export function LiveRefresh() {
  useTeamStream();
  return null;
}
