import type { Metadata } from "next";
import { Button } from "@/components/ui/Button";
import { describeUnsubscribe } from "@/services/unsubscribe";
import { unsubscribe } from "./actions";

/**
 * `noindex` because the URL *is* the credential — an indexed unsubscribe link
 * is a working unsubscribe link in a search result. `no-referrer` for the same
 * reason: nothing on this page links out today, but a `Referer` header is the
 * classic way a URL leaves the building.
 */
export const metadata: Metadata = {
  title: "Unsubscribe",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

/**
 * `GET /unsubscribe/:token` renders a page with a button and changes nothing.
 *
 * Corporate mail security products (Defender, Proofpoint, Mimecast) follow
 * every link in an incoming message to inspect it. If this GET unsubscribed, a
 * scanner would silently unsubscribe recipients who never touched the mail,
 * and the first symptom would be a customer asking why their list is
 * evaporating — by which time it has happened to everyone whose employer runs
 * a scanner. This is not hypothetical; it is the standard failure of one-click
 * unsubscribe implementations.
 *
 * So this component only reads. The write lives behind the button, in
 * `actions.ts`, and behind `POST /api/unsubscribe/:token` for mail clients
 * that implement RFC 8058. There is no redirect on this path, no server action
 * invoked during render, and no prefetch that could reach one.
 *
 * ## Three states, and what each one may say
 *
 * The page renders from current consent rather than from what the last POST
 * returned, which is what makes it **idempotent by construction**: someone who
 * unsubscribed a month ago sees the same confirmation as someone who pressed
 * the button a second ago.
 *
 * A link that does not work gets one generic message, and one is all it gets:
 * a forged signature and a deleted contact must be indistinguishable, or the
 * page becomes a way to ask which contact ids exist. It is deliberately more
 * honest than the machine-facing POST, which answers 200 to everything — a
 * person reading this can act on the truth (reply to the sender), whereas a
 * mail client shown an error only teaches its user to press the spam button.
 * The audience differs, so the answer differs; the outcome never leaks either
 * way.
 *
 * The status stays 200 in all three states. A 404 would be a machine-facing
 * signal on a human-facing page: it tells scanners and crawlers the sender's
 * links are broken, and it tells the reader nothing the words do not.
 */
export default async function UnsubscribePage(
  props: PageProps<"/unsubscribe/[token]">,
) {
  const { token } = await props.params;
  const { busy } = await props.searchParams;
  const target = await describeUnsubscribe(token);
  const sender = target?.senderName ?? "this sender";

  return (
    <main className="grid-hairlines flex min-h-dvh items-center justify-center p-6">
      <div className="glass-strong w-full max-w-md p-8">
        <p className="num-stamp">Unsubscribe</p>

        {target === null ? (
          <>
            <h1 className="mt-4 text-lg font-medium">
              This link didn&apos;t work.
            </h1>
            <p className="mt-2 text-sm text-white/65">
              It may have been copied incompletely, or the sender may have
              changed their setup since the message was sent. If you&apos;re
              still getting email you don&apos;t want, reply to the message and
              ask to be removed.
            </p>
          </>
        ) : target.subscribed ? (
          <>
            <h1 className="mt-4 text-lg font-medium">
              Unsubscribe {target.email}?
            </h1>
            <p className="mt-2 text-sm text-white/65">
              You&apos;ll stop receiving campaign email from {sender}. Account
              email — receipts, password resets and the like — is a separate
              list and is not affected.
            </p>
            {busy ? (
              <p className="mt-4 text-sm text-amber-300">
                That didn&apos;t go through — too many requests just now.
                You&apos;re still subscribed. Try again in a minute.
              </p>
            ) : (
              // Nothing has changed yet, and saying so is the visible half of
              // the GET/POST split: whoever opened this link — a person or the
              // scanner that got here first — has not unsubscribed anybody.
              <p className="mt-4 text-sm text-white/45">
                Nothing has changed yet.
              </p>
            )}
            {/* `unsubscribe` is bound, not called: a server action referenced
                here runs only when this form is submitted. */}
            <form action={unsubscribe.bind(null, token)} className="mt-6">
              <Button type="submit" size="lg" className="w-full">
                Unsubscribe
              </Button>
            </form>
          </>
        ) : (
          <>
            <h1 className="mt-4 text-lg font-medium">
              You&apos;re unsubscribed.
            </h1>
            <p className="mt-2 text-sm text-white/65">
              {target.email} won&apos;t receive campaign email from {sender} any
              more. Account email — receipts, password resets and the like — is
              a separate list and still works.
            </p>
          </>
        )}
      </div>
    </main>
  );
}
