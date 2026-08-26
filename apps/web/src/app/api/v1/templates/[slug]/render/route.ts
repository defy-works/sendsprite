import { MAX_VARIABLES_JSON_CHARS } from "@sendsprite/shared";
import { fail, ok, serviceFailure, withApiKey } from "@/lib/api-response";
import { renderStoredTemplate } from "@/services/templates";

export const dynamic = "force-dynamic";

/**
 * Largest render body accepted.
 *
 * The variables themselves are bounded by the contract at
 * `MAX_VARIABLES_JSON_CHARS` (64 KB) once serialised, which is at most ~192 KB
 * of UTF-8, so 256 KB is every payload the contract can accept plus the
 * envelope and any pretty-printing, and nothing else. Declaring it here rather
 * than inheriting `MAX_BODY_BYTES` matters: that cap is 25 MB because a send
 * carries base64 attachments, and a hundred times the largest legal body is
 * not a limit — this endpoint has no attachments and no reason to buffer one.
 */
const MAX_RENDER_BYTES = 256 * 1024;

const overCap = () =>
  fail(
    "payload_too_large",
    `Request body must be at most ${MAX_RENDER_BYTES} bytes; variables may be at most ${MAX_VARIABLES_JSON_CHARS} characters once serialised. Send longer per-recipient content as html.`,
  );

/**
 * `POST /templates/:slug/render` — a dry run.
 *
 * Nothing is sent, nothing is stored, and the escaping is exactly what a send
 * would produce: this route and `POST /emails` both go through
 * `renderStoredTemplate`, so a preview cannot disagree with the mail.
 *
 * It answers with the rendered `subject`, `html` and `text` and nothing else.
 * Not the stored row (that is `GET /templates/:slug`), and not the variables
 * the caller just sent — echoing an input back is bytes the caller already
 * has, and it is the one part of this exchange that may carry a customer's
 * personal data.
 *
 * The body is read as text and capped before it is parsed, and `variables` is
 * handed to the service unparsed: the service is the single seam in front of
 * the renderer and re-checks the caps for its other callers anyway, so
 * validating them a second time here would only give one mistake two error
 * shapes depending on which layer noticed it first.
 *
 * A `full` key only (`../route.ts` explains why).
 */
export const POST = withApiKey(
  async (req, auth, ctx) => {
    const { slug } = await ctx.params;
    // From `content-length` first, so a declared over-size body is refused
    // without being buffered; then from the bytes, because a chunked request
    // declares no length at all.
    if (Number(req.headers.get("content-length")) > MAX_RENDER_BYTES)
      return overCap();
    const raw = await req.text();
    if (Buffer.byteLength(raw) > MAX_RENDER_BYTES) return overCap();

    let body: unknown = {};
    if (raw.trim())
      try {
        body = JSON.parse(raw);
      } catch {
        return fail("validation_error", "Body must be JSON.");
      }
    if (typeof body !== "object" || body === null || Array.isArray(body))
      return fail(
        "validation_error",
        'Body must be a JSON object: {"variables": { … }}.',
      );

    const res = await renderStoredTemplate(
      auth.team.id,
      slug ?? "",
      (body as { variables?: unknown }).variables ?? {},
    );
    if (!res.ok) return serviceFailure(res);
    return ok(res.data);
  },
  { permission: "full" },
);
