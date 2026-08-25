import { simpleParser, type AddressObject } from "mailparser";
import type { SMTPServerDataStream, SMTPServerSession } from "smtp-server";
import type { ErrorCode } from "@sendsprite/shared";
import { formatAddress } from "@/lib/email-address";
import { enqueue } from "@/jobs/enqueue";
import { createEmail } from "@/services/emails";

/** Stored on the session by `onAuth`; smtp-server types `user` as a string. */
export interface SmtpUser {
  teamId: string;
  apiKeyId: string;
  keyDomainId: string | null;
}

export class SmtpError extends Error {
  constructor(
    message: string,
    readonly responseCode: number,
  ) {
    super(message);
  }
}

/** `SendFailure.code` → SMTP reply code (permanent 5xx, temporary 4xx). */
const SMTP_CODE: Partial<Record<ErrorCode, number>> = {
  domain_not_verified: 550,
  suppressed_recipient: 550,
  forbidden: 550,
  validation_error: 501,
  daily_quota_exceeded: 452,
  monthly_quota_exceeded: 452,
  rate_limited: 452,
  unauthorized: 535,
};

/**
 * Only `X-*` headers are forwarded. The standard ones are already carried by
 * the parsed fields, and the reserved set (`date`, `message-id`,
 * `mime-version`, `content-type`, …) is set by the pipeline/SES and would be
 * rejected by the shared schema.
 */
const isCustomHeader = (key: string) => key.startsWith("x-");

const addresses = (a: AddressObject | AddressObject[] | undefined) =>
  (Array.isArray(a) ? a : a ? [a] : [])
    .flatMap((o) => o.value)
    .flatMap((v) => v.group ?? [v])
    .map((v) => v.address)
    .filter((x): x is string => Boolean(x));

/**
 * DATA → `createEmail` with `source: "smtp"`. Message headers become the
 * request fields the REST API takes, so every limit and refusal is shared:
 * a `SendFailure` is mapped to an SMTP reply and thrown as `SmtpError`.
 */
export async function handleInbound(
  stream: SMTPServerDataStream,
  session: SMTPServerSession,
): Promise<void> {
  const user = session.user as unknown as SmtpUser | undefined;
  if (!user) throw new SmtpError("Authentication required", 530);
  const parsed = await simpleParser(stream);
  // Set only once the stream has been consumed.
  if (stream.sizeExceeded) throw new SmtpError("Message too large", 552);

  const from = parsed.from?.value[0];
  if (!from?.address) throw new SmtpError("From header required", 501);
  if (!parsed.html && !parsed.text)
    throw new SmtpError("html or text body required", 501);
  const to = addresses(parsed.to);
  const headers: Record<string, string> = {};
  for (const { key, line } of parsed.headerLines) {
    if (!isCustomHeader(key)) continue;
    const i = line.indexOf(":");
    headers[line.slice(0, i)] = line
      .slice(i + 1)
      .replace(/\r?\n/g, " ")
      .trim();
  }
  // Inline (cid) images are kept as ordinary attachments.
  const attachments = parsed.attachments.map((a) => ({
    filename: a.filename ?? "attachment",
    contentType: a.contentType,
    content: a.content.toString("base64"),
  }));

  const r = await createEmail(
    {
      teamId: user.teamId,
      source: "smtp",
      apiKeyId: user.apiKeyId,
      actorUserId: null,
      keyDomainId: user.keyDomainId,
    },
    {
      from: formatAddress({ name: from.name || null, email: from.address }),
      // Header recipients when present, else the envelope (Bcc-only sends).
      to: to.length ? to : session.envelope.rcptTo.map((r) => r.address),
      cc: addresses(parsed.cc),
      replyTo: addresses(parsed.replyTo),
      subject: parsed.subject ?? "",
      html: parsed.html || undefined,
      text: parsed.text || undefined,
      headers,
      attachments,
    },
    { enqueue },
  );
  if (!r.ok) throw new SmtpError(r.error, SMTP_CODE[r.code] ?? 451);
}
