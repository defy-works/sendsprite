import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import { createServer } from "../src/server";

const fake = () => ({
  emails: {
    send: vi.fn().mockResolvedValue({ id: "em_1" }),
    get: vi.fn().mockResolvedValue({
      id: "em_1",
      status: "delivered",
      to: ["c@d.io"],
      subject: "s",
      sentAt: "2026-08-25T10:00:00.000Z",
      lastError: null,
      // Fifteen events: only the last ten reach the model.
      events: Array.from({ length: 15 }, (_, i) => ({
        id: `ev_${i}`,
        type: "delivered",
        occurredAt: `t${i}`,
        payload: {},
      })),
    }),
    list: vi.fn().mockResolvedValue({
      data: [
        {
          id: "em_1",
          status: "sent",
          to: ["c@d.io"],
          subject: "s",
          createdAt: "t",
        },
      ],
      nextCursor: null,
    }),
  },
  domains: {
    list: vi.fn().mockResolvedValue({
      data: [{ id: "d1", name: "mail.x.io", status: "verified" }],
      nextCursor: null,
    }),
  },
  stats: vi.fn().mockResolvedValue({
    sent: { today: 1, d7: 2, d30: 3 },
    rates: { delivered: 1, bounced: 0, complained: 0 },
    alerts: [],
  }),
});

async function connect(client = fake()) {
  const server = createServer(client as never);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const c = new Client({ name: "test", version: "0" });
  await c.connect(b);
  return { c, client };
}

describe("@sendsprite/mcp", () => {
  it("lists the six tools", async () => {
    const { c } = await connect();
    const names = (await c.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "get_email_status",
      "get_send_stats",
      "list_domains",
      "list_emails",
      "search_emails",
      "send_email",
    ]);
  });

  it("advertises an object input schema and a description for every tool", async () => {
    const { c } = await connect();
    for (const tool of (await c.listTools()).tools) {
      expect(tool.description, tool.name).toBeTruthy();
      expect(tool.inputSchema.type, tool.name).toBe("object");
    }
  });

  it("describes send_email's required fields in its input schema", async () => {
    const { c } = await connect();
    const send = (await c.listTools()).tools.find(
      (t) => t.name === "send_email",
    );
    expect(send?.inputSchema.required).toEqual(
      expect.arrayContaining(["from", "to"]),
    );
    // `subject` is described but not required: a `template` carries its own.
    expect(send?.inputSchema.required).not.toContain("subject");
    expect(Object.keys(send?.inputSchema.properties ?? {})).toEqual(
      expect.arrayContaining([
        "subject",
        "html",
        "text",
        "template",
        "variables",
        "attachments",
        "scheduledAt",
      ]),
    );
  });

  it("send_email validates input and calls the SDK", async () => {
    const { c, client } = await connect();
    const r = await c.callTool({
      name: "send_email",
      arguments: { from: "a@b.io", to: ["c@d.io"], subject: "s", text: "t" },
    });
    expect(client.emails.send).toHaveBeenCalledWith(
      expect.objectContaining({ subject: "s" }),
    );
    expect(r.structuredContent).toEqual({ id: "em_1" });
    const bad = await c.callTool({
      name: "send_email",
      arguments: { from: "a@b.io" },
    });
    expect(bad.isError).toBe(true);
  });

  it("send_email rejects a body with neither html, text nor template", async () => {
    const { c, client } = await connect();
    const r = await c.callTool({
      name: "send_email",
      arguments: { from: "a@b.io", to: ["c@d.io"], subject: "s" },
    });
    expect(r.isError).toBe(true);
    expect(client.emails.send).not.toHaveBeenCalled();
  });

  it("send_email accepts a template with no subject and refuses neither", async () => {
    const { c, client } = await connect();
    // A template carries its own subject, so the tool must not demand one.
    const withTemplate = await c.callTool({
      name: "send_email",
      arguments: {
        from: "a@b.io",
        to: ["c@d.io"],
        template: "welcome",
        variables: { name: "Ada" },
      },
    });
    expect(withTemplate.isError).toBeFalsy();
    expect(client.emails.send).toHaveBeenCalledWith(
      expect.objectContaining({ template: "welcome" }),
    );
    // Neither a subject nor a template is the refine's job, and it must reach
    // the caller as an ordinary tool error rather than a protocol failure.
    const neither = await c.callTool({
      name: "send_email",
      arguments: { from: "a@b.io", to: ["c@d.io"], text: "t" },
    });
    expect(neither.isError).toBe(true);
    expect(client.emails.send).toHaveBeenCalledTimes(1);
  });

  it("get_email_status returns status + recent events", async () => {
    const { c } = await connect();
    const r = await c.callTool({
      name: "get_email_status",
      arguments: { id: "em_1" },
    });
    expect(r.structuredContent).toMatchObject({
      id: "em_1",
      status: "delivered",
    });
    // Newest last, capped at ten so a long timeline cannot flood the context.
    const { events } = r.structuredContent as {
      events: { occurredAt: string }[];
    };
    expect(events).toHaveLength(10);
    expect(events.at(-1)?.occurredAt).toBe("t14");
  });

  it("list_emails passes pagination through and returns the cursor", async () => {
    const { c, client } = await connect();
    const r = await c.callTool({
      name: "list_emails",
      arguments: { limit: 10, cursor: "cur", status: "sent" },
    });
    expect(client.emails.list).toHaveBeenCalledWith({
      limit: 10,
      cursor: "cur",
      status: "sent",
    });
    expect(r.structuredContent).toMatchObject({ nextCursor: null });
  });

  it("search_emails maps query fields onto the list filters", async () => {
    const { c, client } = await connect();
    await c.callTool({
      name: "search_emails",
      arguments: { to: "c@d.io", status: "sent", limit: 5 },
    });
    expect(client.emails.list).toHaveBeenCalledWith({
      to: "c@d.io",
      status: "sent",
      limit: 5,
    });
  });

  it("list_domains and get_send_stats need no arguments", async () => {
    const { c, client } = await connect();
    const domains = await c.callTool({ name: "list_domains", arguments: {} });
    expect(client.domains.list).toHaveBeenCalled();
    expect(domains.structuredContent).toMatchObject({
      data: [{ name: "mail.x.io" }],
    });

    const stats = await c.callTool({ name: "get_send_stats", arguments: {} });
    expect(client.stats).toHaveBeenCalled();
    expect(stats.structuredContent).toMatchObject({
      sent: { today: 1, d7: 2, d30: 3 },
    });
  });

  it("SDK errors become isError tool results, not protocol errors", async () => {
    const client = fake();
    client.emails.get.mockRejectedValue(
      Object.assign(new Error("nope"), {
        name: "SendspriteError",
        code: "not_found",
        status: 404,
      }),
    );
    const { c } = await connect(client);
    const r = await c.callTool({
      name: "get_email_status",
      arguments: { id: "x" },
    });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.content)).toContain("not_found");
  });

  // One rejecting call per tool: no tool may let an API failure escape as a
  // protocol error, which would end the session instead of informing the model.
  it.each([
    ["send_email", { from: "a@b.io", to: ["c@d.io"], subject: "s", text: "t" }],
    ["get_email_status", { id: "em_1" }],
    ["list_emails", {}],
    ["search_emails", { to: "c@d.io" }],
    ["list_domains", {}],
    ["get_send_stats", {}],
  ])("%s reports a rejected call as an isError result", async (name, args) => {
    const client = fake();
    const boom = Object.assign(new Error("upstream is down"), {
      name: "SendspriteError",
      code: "rate_limited",
      status: 429,
    });
    client.emails.send.mockRejectedValue(boom);
    client.emails.get.mockRejectedValue(boom);
    client.emails.list.mockRejectedValue(boom);
    client.domains.list.mockRejectedValue(boom);
    client.stats.mockRejectedValue(boom);

    const { c } = await connect(client);
    const r = await c.callTool({ name, arguments: args });
    expect(r.isError, name).toBe(true);
    expect(JSON.stringify(r.content), name).toContain("rate_limited");
  });

  it("reports a non-Sendsprite failure without inventing a code", async () => {
    const client = fake();
    client.stats.mockRejectedValue(new TypeError("fetch failed"));
    const { c } = await connect(client);
    const r = await c.callTool({ name: "get_send_stats", arguments: {} });
    expect(r.isError).toBe(true);
    const text = JSON.stringify(r.content);
    expect(text).toContain("fetch failed");
    expect(text).toContain("internal_error");
  });

  it("every tool result carries a text block for clients without structured output", async () => {
    const { c } = await connect();
    const r = await c.callTool({ name: "get_send_stats", arguments: {} });
    const [block] = r.content as { type: string; text: string }[];
    expect(block?.type).toBe("text");
    expect(JSON.parse(block!.text)).toMatchObject({ sent: { today: 1 } });
  });
});
