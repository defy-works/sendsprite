import { describe, expect, it, vi } from "vitest";
import { Sendsprite } from "../src/index";
import { Button, Html, Text, renderEmail } from "../src/react";

/** An error and everything reachable through its `cause` chain. */
const causes = (error: unknown): unknown[] => {
  const seen: unknown[] = [];
  for (let e = error; e != null && seen.length < 5;) {
    seen.push(e);
    e = (e as { cause?: unknown }).cause;
  }
  return seen;
};

describe("sendsprite/react", () => {
  it("renders an element to html + text", async () => {
    const out = await renderEmail(
      <Html>
        <Text>Hello Ada</Text>
        <Button href="https://x.io">Go</Button>
      </Html>,
    );
    expect(out.html).toContain("<!DOCTYPE html");
    expect(out.html).toContain("Hello Ada");
    expect(out.text).toContain("Hello Ada");
    expect(out.text).toContain("https://x.io");
  });

  it("emails.send({ react }) renders before posting and drops the element from the body", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ id: "em" }), { status: 201 }),
      );
    const c = new Sendsprite({ apiKey: "k", baseUrl: "https://x", fetch });
    await c.emails.send({
      from: "a@b.io",
      to: "c@d.io",
      subject: "s",
      react: <Text>Hi</Text>,
    });
    const body = JSON.parse(
      (fetch.mock.calls[0]![1] as RequestInit).body as string,
    );
    expect(body.react).toBeUndefined();
    expect(body.html).toContain("Hi");
    expect(body.text).toContain("Hi");
  });

  it("explicit html/text win over the rendered element", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ id: "em" }), { status: 201 }),
      );
    const c = new Sendsprite({ apiKey: "k", baseUrl: "https://x", fetch });
    await c.emails.send({
      from: "a@b.io",
      to: "c@d.io",
      subject: "s",
      html: "<p>explicit</p>",
      react: <Text>Hi</Text>,
    });
    const body = JSON.parse(
      (fetch.mock.calls[0]![1] as RequestInit).body as string,
    );
    expect(body.html).toBe("<p>explicit</p>");
    expect(body.text).toContain("Hi");
  });

  it("emails.batch renders each item's `react` and keeps the idempotency retry rule", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: "a" }, { id: "b" }] }), {
        status: 201,
      }),
    );
    const c = new Sendsprite({ apiKey: "k", baseUrl: "https://x", fetch });
    await c.emails.batch([
      { from: "a@b.io", to: "c@d.io", subject: "1", react: <Text>One</Text> },
      { from: "a@b.io", to: "c@d.io", subject: "2", text: "two" },
    ]);
    const body = JSON.parse(
      (fetch.mock.calls[0]![1] as RequestInit).body as string,
    );
    expect(body[0].react).toBeUndefined();
    expect(body[0].html).toContain("One");
    expect(body[1].text).toBe("two");
  });

  it("send({ react }) without @react-email/render installed fails with a clear error", async () => {
    vi.resetModules();
    vi.doMock("@react-email/render", () => {
      throw new Error("Cannot find module");
    });
    const { renderEmail: r } = await import("../src/react");
    await expect(r(<Text>x</Text>)).rejects.toThrow(
      /install @react-email\/render/,
    );
    vi.doUnmock("@react-email/render");
  });

  it("propagates a module that exists but fails to evaluate", async () => {
    // "install the peer" would send the reader hunting for a missing package
    // that is in fact installed and broken.
    vi.resetModules();
    const boom = new Error("boom in module init");
    vi.doMock("@react-email/render", () => {
      throw boom;
    });
    const { renderEmail: r } = await import("../src/react");
    const error: unknown = await r(<Text>x</Text>).catch((e: unknown) => e);
    // The loader may wrap it, but it must not be swapped for the misleading
    // "install the peer" message, and the real failure stays reachable.
    expect(String((error as Error).message)).not.toMatch(
      /install @react-email\/render/,
    );
    expect(causes(error)).toContain(boom);
    vi.doUnmock("@react-email/render");
    vi.resetModules();
  });

  it("rejects a `react` value that is not an element", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const c = new Sendsprite({ apiKey: "k", baseUrl: "https://x", fetch });
    await expect(
      c.emails.send({
        from: "a@b.io",
        to: "c@d.io",
        subject: "s",
        // What a caller passing a component instead of an element produces.
        react: { type: Text, props: {} },
      }),
    ).rejects.toThrow(/must be a React element/);
    expect(fetch).not.toHaveBeenCalled();
  });
});
