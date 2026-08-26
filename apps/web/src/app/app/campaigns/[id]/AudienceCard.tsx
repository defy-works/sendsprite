import type { AudiencePreview } from "@sendsprite/shared";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/Card";
import { Link } from "@/components/ui/Link";
import {
  SUPPRESSED_REASON,
  UNSUBSCRIBED_REASON,
  audienceBreakdown,
  formatCount,
  people,
} from "../send";

/**
 * Who this campaign will reach, and who it will not.
 *
 * A server component: it renders four numbers that came off one aggregate and
 * needs no state. The arithmetic behind it lives in `send.ts` where a test can
 * hold it to being right — see {@link audienceBreakdown} for why `excluded` is
 * `contacts - eligible` and not the sum of the two reasons.
 *
 * The card exists because "1 000 contacts, 940 will receive this" is a support
 * ticket waiting to happen. Nobody has to accept the missing 60 on faith: both
 * reasons are named, both are explained in the customer's terms, and the
 * overlap between them is stated rather than left to be discovered as an
 * apparent contradiction.
 */
export function AudienceCard({
  audience,
  bookId,
  bookName,
}: {
  /** `null` when the campaign's contact book has been deleted. */
  audience: AudiencePreview | null;
  bookId: string;
  bookName: string | null;
}) {
  if (!audience || bookName === null)
    return (
      <Card>
        <CardHeader>
          <CardTitle>Audience</CardTitle>
        </CardHeader>
        <CardBody>
          <p className="text-sm text-amber-300">
            The contact book this campaign was drawn from has been deleted, so
            there is no audience to count. Pick another book in the settings
            above before sending.
          </p>
        </CardBody>
      </Card>
    );

  const a = audienceBreakdown(audience);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Audience</CardTitle>
        <Link
          href={`/app/contacts/${bookId}`}
          className="text-xs text-white/60 no-underline hover:text-white"
        >
          {bookName} →
        </Link>
      </CardHeader>
      <CardBody className="flex flex-col gap-4">
        <div>
          <p className="text-3xl font-medium tabular-nums">
            {formatCount(a.eligible)}
          </p>
          <p className="text-sm text-white/65">
            {a.eligible === 1 ? "person receives" : "people receive"} this
            campaign, of {formatCount(a.contacts)} in {bookName}.
          </p>
        </div>

        {/* Four views of one population, not four buckets that sum to it:
            `eligible` is a subset of `subscribed`, and `suppressed` overlaps
            both. Laid out as a list of facts about the same book rather than
            a total with parts, because a column of numbers invites adding
            them up and these do not add up. */}
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 border-t border-white/8 pt-4 text-sm">
          <div>
            <dt className="text-xs tracking-wide text-white/45 uppercase">
              Contacts
            </dt>
            <dd className="tabular-nums">{formatCount(a.contacts)}</dd>
          </div>
          <div>
            <dt className="text-xs tracking-wide text-white/45 uppercase">
              Subscribed
            </dt>
            <dd className="tabular-nums">{formatCount(a.subscribed)}</dd>
          </div>
          <div>
            <dt className="text-xs tracking-wide text-white/45 uppercase">
              Suppressed
            </dt>
            <dd className="tabular-nums">{formatCount(a.suppressed)}</dd>
          </div>
          <div>
            <dt className="text-xs tracking-wide text-white/45 uppercase">
              Eligible
            </dt>
            <dd className="tabular-nums text-indigo-300">
              {formatCount(a.eligible)}
            </dd>
          </div>
        </dl>

        {a.excluded > 0 && (
          <div className="flex flex-col gap-3 border-t border-white/8 pt-4">
            <p className="text-sm text-white/75">
              {people(a.excluded)} in this book will not receive it:
            </p>
            {a.unsubscribed > 0 && (
              <p className="text-xs text-white/55">
                <span className="text-white/80">
                  {formatCount(a.unsubscribed)} unsubscribed.
                </span>{" "}
                {UNSUBSCRIBED_REASON}
              </p>
            )}
            {a.suppressed > 0 && (
              <p className="text-xs text-white/55">
                <span className="text-white/80">
                  {formatCount(a.suppressed)} suppressed.
                </span>{" "}
                {SUPPRESSED_REASON}{" "}
                <Link href="/app/suppressions" className="text-white/70">
                  Suppression list
                </Link>
              </p>
            )}
            {/* Said out loud, because otherwise the two lines above appear to
                over-count: someone who unsubscribed *and* then bounced is on
                both, and counted once in the total. */}
            {a.both > 0 && (
              <p className="text-xs text-white/45">
                {people(a.both)} are both unsubscribed and suppressed, and are
                counted once in the {formatCount(a.excluded)}.
              </p>
            )}
          </div>
        )}

        {a.eligible === 0 && (
          <p className="text-sm text-amber-300">
            Nobody in this book can receive this campaign right now. Sending it
            would mail no one.
          </p>
        )}

        <p className="text-xs text-white/45">
          Counted when this page loaded. The audience is read again as the send
          walks the book, so a contact who unsubscribes in between is dropped
          before they are mailed.
        </p>
      </CardBody>
    </Card>
  );
}
