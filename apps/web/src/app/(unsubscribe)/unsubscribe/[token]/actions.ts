"use server";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { enqueue } from "@/jobs/enqueue";
import { requestMeta } from "@/lib/audit";
import { applyUnsubscribe } from "@/services/unsubscribe";

/**
 * The human half of the RFC 8058 pair: what the button on the page submits.
 *
 * This is a POST, like `/api/unsubscribe/:token`, and for the same reason —
 * **the GET that renders the page must never mutate.** Corporate mail security
 * products fetch every link in an incoming message before a person sees it, so
 * a GET that unsubscribed would quietly empty a customer's list on their
 * behalf.
 *
 * Unlike the API endpoint, this one keeps Next's own Server Action origin
 * check: a browser form is same-origin by definition, so there is no reason to
 * give up a protection that costs nothing here. The unprotected door is the
 * machine-facing route, where the spec leaves no alternative, and it is
 * commented as such where it lives.
 *
 * `token` is a bound argument rather than a hidden form field, so it is not
 * spelled out a second time in the page source; it is already in the URL, and
 * once is enough. Nothing in this file logs it.
 */
export async function unsubscribe(token: string): Promise<void> {
  const outcome = await applyUnsubscribe(token, {
    enqueue,
    meta: requestMeta(await headers()),
  });
  // POST → redirect → GET, so a reload never re-submits and the confirmation
  // is rendered by the same read-only page that showed the button. The page
  // reads consent from the database rather than from this outcome, which is
  // what makes an already-unsubscribed contact and a fresh one land on
  // identical wording.
  const path = `/unsubscribe/${encodeURIComponent(token)}`;
  // `?busy` is the one thing the page cannot re-derive: the write was refused
  // for load, not for consent, and the recipient needs to know their click did
  // not take. Silence here would be a person told nothing while still
  // subscribed.
  redirect(outcome === "rate_limited" ? `${path}?busy=1` : path);
}
