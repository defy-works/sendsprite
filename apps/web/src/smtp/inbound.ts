import { PassThrough } from "node:stream";
import { simpleParser, type AddressObject } from "mailparser";
import type { SMTPServerDataStream, SMTPServerSession } from "smtp-server";
import type { ErrorCode } from "@sendsprite/shared";
import { formatAddress, normaliseEmail } from "@/lib/email-address";
import { enqueue } from "@/jobs/enqueue";
import { createEmail } from "@/services/emails";

/** Set on the session by `onAuth` (smtp-server's own `user` is a string). */
export interface SmtpUser {
  teamId: string;
  apiKeyId: string;
  keyDomainId: string | null;
  permission: "full" | "sending_only";
}
declare module "smtp-server" {
  interface SMTPServerSession {
    smtpUser?: SmtpUser;
  }
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
 * Bounded copy of the DATA stream for the parser. smtp-server flags
 * `sizeExceeded` as bytes arrive; from that chunk on nothing more is handed
 * to the parser, the input is drained (`resume`) so the client's DATA ends
 * and the 552 can be sent, and `body` is destroyed so the parser stops. The
 * parser therefore never holds more than the size limit.
 */
export function boundedBody(stream: SMTPServerDataStream): {
  body: PassThrough;
  exceeded: Promise<never>;
} {
  const body = new PassThrough();
  let rejectExceeded!: (e: Error) => void;
  const exceeded = new Promise<never>((_, rej) => (rejectExceeded = rej));
  exceeded.catch(() => undefined);
  const onChunk = (chunk: Buffer) => {
    if (stream.sizeExceeded) {
      stream.off("data", onChunk);
      const err = new SmtpError("Message too large", 552);
      body.destroy(err);
      rejectExceeded(err);
      stream.resume();
      return;
    }
    if (!body.write(chunk)) {
      stream.pause();
      body.once("drain", () => stream.resume());
    }
  };
  stream.on("data", onChunk);
  stream.once("end", () => body.end());
  stream.once("error", (e) => body.destroy(e));
  return { body, exceeded };
}

/**
 * DATA → `createEmail` with `source: "smtp"`. Message headers become the
 * request fields the REST API takes, so every limit and refusal is shared:
 * a `SendFailure` is mapped to an SMTP reply and thrown as `SmtpError`.
 */
export async function handleInbound(
  stream: SMTPServerDataStream,
  session: SMTPServerSession,
): Promise<void> {
  const user = session.smtpUser;
  if (!user) throw new SmtpError("Authentication required", 530);
  const { body, exceeded } = boundedBody(stream);
  const parsed = await Promise.race([simpleParser(body), exceeded]);

  const from = parsed.from?.value[0];
  if (!from?.address) throw new SmtpError("From header required", 501);
  if (!parsed.html && !parsed.text)
    throw new SmtpError("html or text body required", 501);
  // The envelope (RCPT TO) is what gets delivered — never a header address
  // the client did not also name in RCPT TO (a relayed message can carry a
  // `To:` of someone the sender is only quoting). Headers only decide which
  // envelope recipients are visible as To/Cc; the rest are Bcc.
  const envelope = [
    ...new Set(session.envelope.rcptTo.map((r) => normaliseEmail(r.address))),
  ];
  const headerTo = new Set(addresses(parsed.to).map(normaliseEmail));
  const headerCc = new Set(addresses(parsed.cc).map(normaliseEmail));
  const cc = envelope.filter((e) => headerCc.has(e) && !headerTo.has(e));
  let to = envelope.filter((e) => headerTo.has(e));
  // No usable To header (Bcc-only sends): every non-Cc recipient is To.
  if (!to.length) to = envelope.filter((e) => !headerCc.has(e));
  if (!to.length) to = envelope;
  const visible = new Set([...to, ...cc]);
  const bcc = envelope.filter((e) => !visible.has(e));
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
      permission: user.permission,
    },
    {
      from: formatAddress({ name: from.name || null, email: from.address }),
      to,
      cc,
      bcc,
      replyTo: addresses(parsed.replyTo),
      subject: parsed.subject || "(no subject)",
      html: parsed.html || undefined,
      text: parsed.text || undefined,
      headers,
      attachments,
    },
    { enqueue },
  );
  if (!r.ok) throw new SmtpError(r.error, SMTP_CODE[r.code] ?? 451);
}
