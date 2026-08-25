import { readFileSync } from "node:fs";
import type { EmailDetail, SendEmailInput } from "../../types";
import type { CommandContext } from "../index";
import { message } from "../output";

interface SendOptions {
  from: string;
  subject: string;
  to: string[];
  cc: string[];
  bcc: string[];
  replyTo: string[];
  text?: string;
  html?: string;
  htmlFile?: string;
  tag: Record<string, string>;
  schedule?: string;
  idempotencyKey?: string;
  json?: boolean;
}

/** `sendsprite emails send` and `sendsprite emails tail` */
export function registerEmails({
  program,
  client,
  write,
  writeError,
  run,
}: CommandContext) {
  const emails = program
    .command("emails")
    .description("Send and follow email")
    .exitOverride();

  emails
    .command("send")
    .description("Send one email")
    .requiredOption("--from <address>", "Sender, on a verified domain")
    .requiredOption("--subject <text>", "Subject line")
    .option("--to <address>", "Recipient (repeatable)", collect, [])
    .option("--cc <address>", "Cc (repeatable)", collect, [])
    .option("--bcc <address>", "Bcc (repeatable)", collect, [])
    .option("--reply-to <address>", "Reply-To (repeatable)", collect, [])
    .option("--text <body>", "Plain-text body")
    .option("--html <body>", "HTML body")
    .option("--html-file <path>", "Read the HTML body from a file")
    .option("--tag <key=value>", "Tag (repeatable)", collectTag, {})
    .option("--schedule <iso>", "Send at an ISO 8601 time in the future")
    .option("--idempotency-key <key>", "Replay-safe key for this send")
    .option("--json", "Print the raw response")
    .action(
      run(async (opts: SendOptions) => {
        const input = buildSendInput(opts);
        const sent = await client().emails.send(input);
        write(opts.json ? JSON.stringify(sent, null, 2) : `Queued ${sent.id}`);
      }),
    );

  emails
    .command("tail")
    .description("Stream email changes until interrupted")
    .option("--json", "Print one JSON object per change")
    .action(
      run(async (opts: { json?: boolean }) => {
        const api = client();
        // One chain rather than parallel lookups: the feed is chronological
        // and interleaved output would be unreadable. Every link is caught, so
        // a failed lookup never rejects `onChange` (which would end the
        // stream).
        let pending: Promise<void> = Promise.resolve();
        const handle = api.stream({
          onChange: (change) => {
            if (change.type !== "email" || change.id === undefined) return;
            const id = change.id;
            pending = pending
              .then(async () => {
                const email = await api.emails.get(id);
                write(opts.json ? JSON.stringify(email) : row(email));
              })
              .catch((cause: unknown) => {
                // Under `--json` stdout is a JSON-lines stream someone is
                // piping to `jq`; a plain-text error line would kill the pipe.
                if (opts.json) {
                  write(JSON.stringify({ id, error: message(cause) }));
                } else {
                  writeError(`${id}  error: ${message(cause)}`);
                }
              });
          },
        });
        // Ctrl-C ends the stream instead of killing the process mid-write. Go
        // through the EventEmitter view: `@types/node` declares no signal
        // overload for `process.removeListener`.
        const signals: NodeJS.EventEmitter = process;
        const onInterrupt = () => handle.close();
        signals.once("SIGINT", onInterrupt);
        try {
          await handle.done;
        } finally {
          // Even when the stream ended badly, rows already fetched belong on
          // stdout - dropping them loses events the operator saw arrive.
          await pending;
          signals.removeListener("SIGINT", onInterrupt);
        }
      }),
    );
}

const collect = (value: string, previous: string[]): string[] => [
  ...previous,
  value,
];

const collectTag = (
  value: string,
  previous: Record<string, string>,
): Record<string, string> => {
  const at = value.indexOf("=");
  if (at <= 0) {
    throw new Error(`Invalid --tag ${JSON.stringify(value)}: use key=value.`);
  }
  return { ...previous, [value.slice(0, at)]: value.slice(at + 1) };
};

/** Flags → `SendEmailInput`, with every unset field left off the wire body. */
function buildSendInput(opts: SendOptions): SendEmailInput {
  if (opts.to.length === 0) {
    throw new Error("Missing --to. Pass --to <address> at least once.");
  }
  const html =
    opts.html ??
    (opts.htmlFile === undefined
      ? undefined
      : readFileSync(opts.htmlFile, "utf8"));
  if (opts.text === undefined && html === undefined) {
    throw new Error("Nothing to send: pass --text, --html or --html-file.");
  }
  const input: SendEmailInput = {
    from: opts.from,
    to: opts.to,
    subject: opts.subject,
  };
  if (opts.cc.length > 0) input.cc = opts.cc;
  if (opts.bcc.length > 0) input.bcc = opts.bcc;
  if (opts.replyTo.length > 0) input.replyTo = opts.replyTo;
  if (html !== undefined) input.html = html;
  if (opts.text !== undefined) input.text = opts.text;
  if (Object.keys(opts.tag).length > 0) input.tags = opts.tag;
  if (opts.schedule !== undefined) input.scheduledAt = opts.schedule;
  if (opts.idempotencyKey !== undefined) {
    input.idempotencyKey = opts.idempotencyKey;
  }
  return input;
}

const row = (email: EmailDetail): string =>
  [
    email.id.padEnd(26),
    email.status.padEnd(10),
    email.to.join(", ").padEnd(28),
    email.subject,
  ]
    .join("  ")
    .trimEnd();
