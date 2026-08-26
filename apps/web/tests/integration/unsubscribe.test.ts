import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { count, eq } from "drizzle-orm";
import { startPg } from "./_pg";
import { auditLog, contactBooks, contacts, suppressions } from "@/db/schema";

// Webhook fan-out enqueues through pg-boss; stub the bridge.
vi.mock("@/jobs/enqueue", () => ({ enqueue: vi.fn(async () => "") }));

const SECRET = "u".repeat(40);
const OTHER_SECRET = "v".repeat(40);
const CAMPAIGN = "cmp_1";

let pg: Awaited<ReturnType<typeof startPg>>;
let sign: (contactId: string, campaignId: string, secret: string) => string;

beforeAll(async () => {
  pg = await startPg();
  process.env.APP_SECRET = SECRET;
  process.env.APP_URL = "https://mail.acme.com";
  (await import("@/env.schema")).resetEnvCache();
  sign = (await import("@sendsprite/shared/node")).signUnsubscribeToken;
  await pg.db.execute(
    `insert into "organization"(id,name,slug,created_at) values ('org_1','Acme','acme',now())`,
  );
  await pg.db
    .insert(contactBooks)
    .values({ id: "cb_1", teamId: "org_1", name: "News" });
});

afterAll(async () => {
  await pg.stop();
});

/** A fresh subscribed contact, so no test depends on another's leftovers. */
let seq = 0;
async function newContact() {
  const id = `ct_${++seq}`;
  await pg.db.insert(contacts).values({
    id,
    bookId: "cb_1",
    teamId: "org_1",
    email: `p${seq}@x.io`,
    subscribed: true,
  });
  return { id, token: sign(id, CAMPAIGN, SECRET) };
}

const row = async (id: string) =>
  (await pg.db.select().from(contacts).where(eq(contacts.id, id)))[0]!;

const suppressionCount = async () =>
  Number((await pg.db.select({ n: count() }).from(suppressions))[0]?.n ?? 0);

const ctx = (token: string) => ({ params: Promise.resolve({ token }) });

/** POST the RFC 8058 endpoint. `ip` is what the limiter keys on. */
async function post(token: string, ip?: string) {
  const { POST } = await import("@/app/api/unsubscribe/[token]/route");
  return POST(
    new Request(`https://mail.acme.com/api/unsubscribe/${token}`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        ...(ip ? { "x-real-ip": ip } : {}),
      },
      body: "List-Unsubscribe=One-Click",
    }),
    ctx(token),
  );
}

/** Render the page the way a GET does, and flatten it to its visible words. */
async function render(
  token: string,
  searchParams: Record<string, string> = {},
) {
  const { default: Page } =
    await import("@/app/(unsubscribe)/unsubscribe/[token]/page");
  const el = await Page({
    params: Promise.resolve({ token }),
    searchParams: Promise.resolve(searchParams),
  } as never);
  return flatten(el).replace(/\s+/g, " ").trim();
}

/**
 * Text nodes keep their own spacing (JSX preserves it), elements are padded so
 * two adjacent paragraphs do not run into one word. The caller collapses runs.
 */
function flatten(node: unknown): string {
  if (node === null || node === undefined || typeof node === "boolean")
    return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(flatten).join("");
  const props = (node as { props?: { children?: unknown } }).props;
  return props ? ` ${flatten(props.children)} ` : "";
}

beforeEach(async () => {
  const { resetUnsubscribeLimitsForTests } =
    await import("@/services/unsubscribe");
  resetUnsubscribeLimitsForTests();
});

describe("unsubscribe", () => {
  it("GET does not unsubscribe — it only renders the confirmation", async () => {
    const { id, token } = await newContact();
    const before = await row(id);

    // The page a recipient (and every corporate link scanner) lands on.
    const page = await render(token);
    expect(page).toContain("Unsubscribe p1@x.io?");
    expect(page).toContain("Nothing has changed yet");

    // ...and the scanner path that follows the `List-Unsubscribe` header.
    const { GET } = await import("@/app/api/unsubscribe/[token]/route");
    const redirect = await GET(
      new Request(`https://mail.acme.com/api/unsubscribe/${token}`),
      ctx(token),
    );
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get("location")).toBe(`/unsubscribe/${token}`);

    // The assertion this whole task exists for.
    const after = await row(id);
    expect(after.subscribed).toBe(true);
    expect(after.unsubscribedAt).toBeNull();
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
    // A read leaves no audit trail either — nothing happened.
    expect(
      await pg.db
        .select()
        .from(auditLog)
        .where(eq(auditLog.actorUserId, `unsubscribe:${CAMPAIGN}`)),
    ).toHaveLength(0);
  });

  it("POST unsubscribes and is idempotent", async () => {
    const { id, token } = await newContact();

    const first = await post(token);
    expect(first.status).toBe(200);
    expect(await row(id)).toMatchObject({ subscribed: false });
    expect((await row(id)).unsubscribedAt).not.toBeNull();

    // A link clicked twice is not an error: same status, same body, and the
    // page still shows the confirmation rather than a failure.
    const second = await post(token);
    expect(second.status).toBe(200);
    expect(await second.text()).toBe(await first.clone().text());
    expect((await row(id)).subscribed).toBe(false);
    expect(await render(token)).toContain("unsubscribed");
    expect(await render(token)).toContain("p2@x.io");
  });

  it("a token signed with another secret changes nothing", async () => {
    const { id } = await newContact();
    const forged = sign(id, CAMPAIGN, OTHER_SECRET);

    const res = await post(forged);
    expect(res.status).toBe(200); // never an error to a mail client
    expect((await row(id)).subscribed).toBe(true);
    expect(await render(forged)).toContain("This link didn't work");
  });

  it("an invalid token and an unknown contact give the same generic message", async () => {
    // Valid signature, contact long gone — versus a string that was never a
    // token at all. If these two answered differently the endpoint would be a
    // way to ask which contact ids exist.
    const unknown = sign("ct_gone", CAMPAIGN, SECRET);
    const garbage = "not-a-token";

    expect(await render(unknown)).toBe(await render(garbage));
    expect(await render(unknown)).toContain("This link didn't work");

    const a = await post(unknown);
    const b = await post(garbage);
    const bodyA = await a.text();
    expect(a.status).toBe(b.status);
    expect(bodyA).toBe(await b.text());
    expect([...a.headers].sort()).toEqual([...b.headers].sort());

    // And neither is distinguishable from a successful removal, from outside.
    const { id, token } = await newContact();
    const good = await post(token);
    expect(good.status).toBe(a.status);
    expect(await good.text()).toBe(bodyA);
    expect((await row(id)).subscribed).toBe(false);
  });

  it("unsubscribing writes no suppression row", async () => {
    // Phase 6 Decision 3 on a new surface: leaving a newsletter must not stop
    // that person's password resets.
    const { id, token } = await newContact();
    const before = await suppressionCount();
    expect((await post(token)).status).toBe(200);
    expect((await row(id)).subscribed).toBe(false);
    expect(await suppressionCount()).toBe(before);
  });

  it("records the reason as the campaign it came from", async () => {
    // No `campaigns` row exists in this file at all, which is the point: a
    // campaign deleted after it sent must not break the links already sitting
    // in people's inboxes.
    const { id, token } = await newContact();
    await post(token);
    expect((await row(id)).unsubscribeReason).toBe(`campaign:${CAMPAIGN}`);
    const audit = await pg.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.actorUserId, `unsubscribe:${CAMPAIGN}`));
    expect(audit.length).toBeGreaterThan(0);
    expect(audit[0]).toMatchObject({
      teamId: "org_1",
      action: "contacts.unsubscribe",
    });
    // The audit row names the campaign, never the token.
    expect(JSON.stringify(audit)).not.toContain(token);
  });

  it("rate-limits one client looping against the write, and says so honestly", async () => {
    const { id, token } = await newContact();
    const ip = "203.0.113.7";
    let limited: Response | undefined;
    for (let i = 0; i < 40 && !limited; i++) {
      const res = await post(token, ip);
      if (res.status === 429) limited = res;
    }
    expect(limited).toBeDefined();
    expect(limited!.headers.get("retry-after")).toBe("60");
    // The unsubscribe itself still landed on the first, unlimited call: a
    // limiter in front of a consent action must never swallow the consent.
    expect((await row(id)).subscribed).toBe(false);

    // Another client is unaffected, and a request with no client identity is
    // not limited at all (see the comment on `takeUnsubscribeToken`).
    expect((await post(token, "203.0.113.8")).status).toBe(200);
    expect((await post(token)).status).toBe(200);
  });

  it("hands the fan-out a header pair that actually accepts a POST", async () => {
    const { unsubscribeLinks } = await import("@/services/unsubscribe");
    const links = unsubscribeLinks("ct_1", CAMPAIGN);
    expect(links.pageUrl).toMatch(
      /^https:\/\/mail\.acme\.com\/unsubscribe\/[A-Za-z0-9_-]+$/,
    );
    expect(links.headers["List-Unsubscribe-Post"]).toBe(
      "List-Unsubscribe=One-Click",
    );
    // The header URL must be the route that exports POST, not the page: a
    // `page.tsx` segment cannot also export a handler, so pointing the header
    // at the page would answer 405 to Gmail's native button.
    const header = links.headers["List-Unsubscribe"];
    expect(header).toMatch(
      /^<https:\/\/mail\.acme\.com\/api\/unsubscribe\/[A-Za-z0-9_-]+>$/,
    );
    const token = header.slice(1, -1).split("/").pop()!;
    expect((await post(token)).status).toBe(200);
  });
});
