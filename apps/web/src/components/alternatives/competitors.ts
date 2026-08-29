/**
 * The comparison pages under `/alternatives/<slug>`. One entry per competitor;
 * every number here is a list price copied from the competitor's public
 * pricing page on the date in `checked`, and must be re-checked when that
 * page changes. Sendsprite's own hosted prices are deliberately absent (see
 * docs/billing: they live in the payment provider's catalogue), so the pages
 * argue from self-hosting, where the cost is Amazon SES's and the box's.
 */

export type Row = {
  label: string;
  /** What the competitor offers. */
  theirs: string;
  /** What Sendsprite offers. */
  ours: string;
};

export type Faq = { q: string; a: string };

export type Competitor = {
  slug: string;
  name: string;
  /** Short parenthetical after the name in headings, e.g. "(Twilio)". */
  vendor?: string;
  /** The `<title>`: the search phrase first, the brand last. */
  title: string;
  description: string;
  /** The H1, split at the line break. */
  headline: [string, string];
  intro: string;
  /** Where the competitor is strong; said plainly, it is what makes the rest credible. */
  credit: string;
  /** What you give up staying with them — the argument of the page. */
  switchReasons: { title: string; body: string }[];
  rows: Row[];
  faqs: Faq[];
  /** ISO date the competitor's pricing page was last read. */
  checked: string;
  pricingUrl: string;
};

const SES_PER_1K = "$0.10";

const OURS = {
  price50k: `${SES_PER_1K} per 1,000 at Amazon SES — about $5 for 50,000 — plus the box it runs on`,
  free: "Free to self-host, for ever. No email cap: the only limit is your SES sending quota",
  daily: "None beyond your SES quota",
  retention:
    "Your Postgres, your retention. Keep events for a day or for ten years",
  domains: "Unlimited",
  selfHost: "Yes — one container plus Postgres, installed with one command",
  ownAws: "Yes — SES in your account, credentials never leave it",
  source: "Source-available server (FSL-1.1-MIT), MIT SDK, CLI and MCP server",
  smtp: "Yes — port 587 with an API key as the password",
  webhooks:
    "Signed webhooks for delivery, bounce, complaint, open and click, plus a live SSE stream",
  agents: "MCP server included, scoped by the same API keys",
};

export const COMPETITORS: Competitor[] = [
  {
    slug: "resend",
    name: "Resend",
    title: "Resend alternative — free, self-hosted, on your own Amazon SES",
    description:
      "Looking for a free Resend alternative? Sendsprite is a self-hosted email API with the same developer experience: REST, typed SDK, React email, webhooks — running on your own Amazon SES for $0.10 per 1,000 emails.",
    headline: ["The free Resend alternative", "you run yourself."],
    intro:
      "Resend made the email API pleasant again: a clean REST endpoint, a typed SDK, React for templates. Sendsprite keeps all of that and removes the part where the pleasant API meters your emails. It is one container on a box you already own, sending through Amazon SES in your own AWS account.",
    credit:
      "Resend's free plan is generous for a side project — 3,000 emails a month — and its SDKs and dashboard are excellent. If you send a few hundred emails a month and never want to see a server, stay.",
    switchReasons: [
      {
        title: "The free plan stops at 100 a day",
        body: "Resend's free tier is 3,000 a month with a hard 100-per-day cap and 30 days of history. One signup spike and the day is over. Self-hosted Sendsprite has no cap of its own: your limit is your SES quota, which Amazon raises on request.",
      },
      {
        title: "$20 a month is $5 of SES",
        body: "Resend Pro is $20 for 50,000 emails and $0.90 per 1,000 after. The same 50,000 emails cost about $5 at SES's $0.10 per 1,000, and the marginal email costs a ninth as much. At 500,000 a month the gap is $350 against $50.",
      },
      {
        title: "Your logs live for 30 days",
        body: "Resend keeps events for 30 days on every plan short of Enterprise. Sendsprite writes every delivery, bounce, complaint and open to your Postgres, and the retention is whatever you set.",
      },
      {
        title: "Same shape of API",
        body: "POST /api/v1/emails with from, to, subject, html or react. A typed SDK, batch sends, idempotency keys, tags, scheduled sends and signed webhooks. Most Resend integrations move by changing the base URL and the key.",
      },
    ],
    rows: [
      {
        label: "Price at 50,000 emails / month",
        theirs: "$20 (Pro), then $0.90 per 1,000",
        ours: OURS.price50k,
      },
      {
        label: "Free tier",
        theirs: "3,000 emails / month, 100 per day, 3 domains",
        ours: OURS.free,
      },
      {
        label: "Daily send limit",
        theirs: "100 on Free; none on paid plans",
        ours: OURS.daily,
      },
      {
        label: "Event retention",
        theirs: "30 days (custom on Enterprise)",
        ours: OURS.retention,
      },
      {
        label: "Domains",
        theirs: "3 Free, 10 Pro, 1,000 Scale; $20 per extra 100",
        ours: OURS.domains,
      },
      { label: "Self-hostable", theirs: "No", ours: OURS.selfHost },
      {
        label: "Your own AWS account",
        theirs: "No — Resend's infrastructure",
        ours: OURS.ownAws,
      },
      { label: "Source", theirs: "Closed", ours: OURS.source },
      { label: "SMTP relay", theirs: "Yes", ours: OURS.smtp },
      { label: "Webhooks", theirs: "Yes", ours: OURS.webhooks },
      { label: "AI agents", theirs: "MCP server", ours: OURS.agents },
    ],
    faqs: [
      {
        q: "Is there a free alternative to Resend?",
        a: "Yes. Sendsprite is free to self-host with no email cap of its own. You pay Amazon SES directly — $0.10 per 1,000 emails — and whatever the server costs. A small VPS runs it comfortably.",
      },
      {
        q: "Is Sendsprite open source?",
        a: "The server is source-available under the Functional Source License (FSL-1.1-MIT), which converts to MIT two years after each release. The SDK, CLI, MCP server and shared packages are MIT. You can read, fork, self-host and modify all of it.",
      },
      {
        q: "How do I migrate from Resend to Sendsprite?",
        a: "Install Sendsprite, connect your AWS account with the one-click CloudFormation stack, add your domain (Cloudflare DNS is written for you; other providers get a copy-paste list), then point your app at the new base URL with a new API key. The request body — from, to, subject, html, react, tags — has the same shape.",
      },
      {
        q: "Does Sendsprite support React email templates?",
        a: "Yes. The SDK accepts a React element for the body, and the dashboard has a template editor with merge fields and linked header/footer layouts.",
      },
      {
        q: "Is Amazon SES deliverability as good as Resend's?",
        a: "Resend and most email APIs send through the same class of infrastructure; your reputation comes from your domain's DKIM, SPF and DMARC and from your bounce and complaint rates. Sendsprite sets the records up for you and suppresses hard bounces and complaints automatically so the rates stay low.",
      },
    ],
    checked: "2026-08-29",
    pricingUrl: "https://resend.com/pricing",
  },
  {
    slug: "postmark",
    name: "Postmark",
    vendor: "ActiveCampaign",
    title:
      "Postmark alternative — free, self-hosted transactional email on Amazon SES",
    description:
      "A free Postmark alternative for developers: Sendsprite is a self-hosted transactional email API with signed webhooks, an SMTP relay and unlimited retention, sending through your own Amazon SES for $0.10 per 1,000 emails.",
    headline: ["The free Postmark alternative", "with no 100-email ceiling."],
    intro:
      "Postmark earned its reputation on transactional deliverability and a no-nonsense API. Its free plan, though, is 100 emails a month — enough to test, not enough to run anything. Sendsprite is a self-hosted email API that sends through Amazon SES in your own account, with the same transactional focus and no ceiling but your SES quota.",
    credit:
      "Postmark's message streams, its bounce handling and its inbound parsing are mature, and its support is well regarded. If you want a vendor on the hook for deliverability and 10,000 emails for $15 fits, it is a fine choice.",
    switchReasons: [
      {
        title: "100 emails a month is a demo, not a free plan",
        body: "Postmark's free tier stops at 100 emails a month with no overage. A password-reset flow on a small app clears that in a week. Self-hosted Sendsprite has no monthly cap: SES starts most new accounts at 50,000 a day and raises it on request.",
      },
      {
        title: "$1.80 per 1,000 against $0.10",
        body: "Postmark Basic is $15 for 10,000 emails and $1.80 per 1,000 beyond. The same 10,000 emails cost $1 at SES. At 100,000 a month Postmark's list price passes $100; SES is $10.",
      },
      {
        title: "45 days of history, unless you pay for more",
        body: "Postmark keeps 45 days by default and sells longer retention on higher plans. Sendsprite stores every event in your Postgres; retention is a setting, not a tier.",
      },
      {
        title: "Everything Postmark's API does, on your box",
        body: "Signed webhooks for delivery, bounce, complaint, open and click. Automatic suppression on hard bounces and complaints. An SMTP relay on port 587 for the legacy app that cannot speak HTTP. Batch sends, tags, scheduled sends, idempotency keys.",
      },
    ],
    rows: [
      {
        label: "Price at 10,000 emails / month",
        theirs: "$15 (Basic), $16.50 (Pro), $18 (Platform)",
        ours: `${SES_PER_1K} per 1,000 at Amazon SES — $1 for 10,000 — plus the box`,
      },
      {
        label: "Overage",
        theirs: "$1.80 / $1.30 / $1.20 per 1,000",
        ours: `${SES_PER_1K} per 1,000, flat`,
      },
      {
        label: "Free tier",
        theirs: "100 emails / month, no overage",
        ours: OURS.free,
      },
      {
        label: "Event retention",
        theirs: "45 days; up to 365 on Pro and Platform",
        ours: OURS.retention,
      },
      { label: "Self-hostable", theirs: "No", ours: OURS.selfHost },
      {
        label: "Your own AWS account",
        theirs: "No — Postmark's infrastructure",
        ours: OURS.ownAws,
      },
      { label: "Source", theirs: "Closed", ours: OURS.source },
      { label: "SMTP relay", theirs: "Yes", ours: OURS.smtp },
      { label: "Webhooks", theirs: "Yes", ours: OURS.webhooks },
      { label: "AI agents", theirs: "—", ours: OURS.agents },
    ],
    faqs: [
      {
        q: "Is there a free alternative to Postmark?",
        a: "Sendsprite is free to self-host and has no email cap of its own. You pay Amazon SES $0.10 per 1,000 emails plus a small server. Postmark's free plan is 100 emails a month.",
      },
      {
        q: "Can Sendsprite handle transactional email only, like Postmark?",
        a: "Yes, and campaigns too if you want them. Transactional sends go through the same queue, suppression list and event log; automatic suppression on hard bounces and complaints keeps the reputation where a transactional sender needs it.",
      },
      {
        q: "How do I migrate from Postmark?",
        a: "Install Sendsprite, connect AWS with the one-click CloudFormation stack, verify your domain, then switch the SMTP host or the API base URL and key. Webhook payloads are documented so your bounce handler is a small mapping change.",
      },
      {
        q: "Does Sendsprite have message streams?",
        a: "Sendsprite separates sending by API key and by tag rather than by stream, and every event carries the tags you sent with. Rate limits and suppression are per team.",
      },
    ],
    checked: "2026-08-29",
    pricingUrl: "https://postmarkapp.com/pricing",
  },
  {
    slug: "sendgrid",
    name: "SendGrid",
    vendor: "Twilio",
    title:
      "SendGrid alternative — free, self-hosted email API on your Amazon SES",
    description:
      "SendGrid ended its free plan. Sendsprite is a free, self-hosted SendGrid alternative: a modern email API with SDK, SMTP relay and webhooks, running on your own Amazon SES for $0.10 per 1,000 emails.",
    headline: ["The SendGrid alternative", "that is still free."],
    intro:
      "SendGrid's permanent free plan is gone; what is left is a 60-day trial at 100 emails a day, then $19.95 a month. Sendsprite is a self-hosted email API with a typed SDK, an SMTP relay for everything that speaks only SMTP, and signed webhooks — sending through Amazon SES in your own account.",
    credit:
      "SendGrid is the incumbent for a reason: enormous scale, dedicated IPs, marketing campaigns and a contacts product in the same bill. If you need a vendor with a sales team and an SLA, it is still on the shortlist.",
    switchReasons: [
      {
        title: "The free plan is a 60-day trial now",
        body: "SendGrid replaced its free tier with a 60-day trial capped at 100 emails a day. Self-hosted Sendsprite is free for as long as you run it, and the limit is your SES quota.",
      },
      {
        title: "$19.95 a month for what SES sells for $5",
        body: "Essentials starts at $19.95 a month for 50,000 emails and shares that volume between transactional and marketing mail. At SES's $0.10 per 1,000 that is $5, and you decide which sends count.",
      },
      {
        title: "Three days of activity history",
        body: "SendGrid's email activity feed keeps a few days unless you buy extended history. Sendsprite writes every event to your Postgres and keeps it as long as you say.",
      },
      {
        title: "SMTP relay, without the SendGrid SMTP quirks",
        body: "Point cron jobs, printers and legacy apps at port 587 with an API key as the password. Same queue, same suppression list, same logs as the API. Modern HTTP clients get a REST API and a typed SDK.",
      },
    ],
    rows: [
      {
        label: "Price at 50,000 emails / month",
        theirs: "From $19.95 (Essentials)",
        ours: OURS.price50k,
      },
      {
        label: "Free tier",
        theirs: "60-day trial, 100 emails / day, then paid",
        ours: OURS.free,
      },
      {
        label: "Event retention",
        theirs: "Days by default; extended history is paid",
        ours: OURS.retention,
      },
      { label: "Self-hostable", theirs: "No", ours: OURS.selfHost },
      {
        label: "Your own AWS account",
        theirs: "No — Twilio's infrastructure",
        ours: OURS.ownAws,
      },
      { label: "Source", theirs: "Closed", ours: OURS.source },
      { label: "SMTP relay", theirs: "Yes", ours: OURS.smtp },
      { label: "Webhooks", theirs: "Event webhook", ours: OURS.webhooks },
      {
        label: "Campaigns and contacts",
        theirs: "Yes, on the same volume cap",
        ours: "Yes — contact books, campaigns, unsubscribe pages, on your own database",
      },
      { label: "AI agents", theirs: "—", ours: OURS.agents },
    ],
    faqs: [
      {
        q: "Is there a free alternative to SendGrid?",
        a: "Sendsprite is free to self-host with no email cap of its own; you pay Amazon SES $0.10 per 1,000 emails and the server. SendGrid no longer has a permanent free plan, only a 60-day trial.",
      },
      {
        q: "Does Sendsprite support SMTP like SendGrid?",
        a: "Yes. Every instance runs an SMTP relay on port 587 that accepts an API key as the password, so anything that could send through SendGrid's SMTP can send through Sendsprite by changing the host and credentials.",
      },
      {
        q: "Can I do marketing email as well as transactional?",
        a: "Yes. Sendsprite has contact books, CSV import, campaigns, unsubscribe pages and merge fields, and they share the suppression list with your transactional sends.",
      },
      {
        q: "How do I migrate from SendGrid?",
        a: "Install Sendsprite, connect AWS with the one-click CloudFormation stack, verify your domain, then swap the SMTP host or API base URL and key. Webhook events are documented for the bounce and complaint handlers.",
      },
    ],
    checked: "2026-08-29",
    pricingUrl: "https://sendgrid.com/pricing/",
  },
  {
    slug: "mailgun",
    name: "Mailgun",
    vendor: "Sinch",
    title:
      "Mailgun alternative — free, self-hosted email API with real log retention",
    description:
      "A free Mailgun alternative you host yourself: Sendsprite is an email API with unlimited log retention, signed webhooks and an SMTP relay, sending through your own Amazon SES for $0.10 per 1,000 emails.",
    headline: ["The Mailgun alternative", "that keeps your logs."],
    intro:
      "Mailgun's free plan is 100 emails a day and one day of logs; its paid plans start at $15 and keep logs for one to thirty days depending on tier. Sendsprite is a self-hosted email API that sends through Amazon SES in your own AWS account and stores every event in your own Postgres.",
    credit:
      "Mailgun's email validation, its inbound routing and its dedicated-IP options are solid, and the API has been stable for a decade. If you need validation as a service or a vendor-managed IP pool, it still earns its place.",
    switchReasons: [
      {
        title: "One day of logs on the plans most people are on",
        body: "Mailgun keeps one day of logs on Free and Basic, five on Foundation and thirty on Scale. A bounce from last Tuesday is gone by Thursday. Sendsprite keeps every delivery, bounce, complaint, open and click in your database for as long as you choose.",
      },
      {
        title: "$1.80 per 1,000 against $0.10",
        body: "Basic is $15 for 10,000 and $1.80 per 1,000 after; Foundation is $35 for 50,000. At SES the same 50,000 cost about $5, and the overage is $0.10.",
      },
      {
        title: "100 a day is a hard ceiling",
        body: "Mailgun's free tier stops at 100 emails a day. Self-hosted Sendsprite's limit is your SES quota, which Amazon raises on request.",
      },
      {
        title: "A modern developer surface",
        body: "REST with a typed SDK, React email, a CLI for scripts, an MCP server for agents, signed webhooks and a live SSE event stream. Plus the SMTP relay for the things that only speak SMTP.",
      },
    ],
    rows: [
      {
        label: "Price at 50,000 emails / month",
        theirs: "$35 (Foundation), then $1.30 per 1,000",
        ours: OURS.price50k,
      },
      {
        label: "Free tier",
        theirs: "100 emails / day, 1 day of logs",
        ours: OURS.free,
      },
      {
        label: "Log retention",
        theirs: "1 day (Free, Basic), 5 days (Foundation), 30 days (Scale)",
        ours: OURS.retention,
      },
      { label: "Self-hostable", theirs: "No", ours: OURS.selfHost },
      {
        label: "Your own AWS account",
        theirs: "No — Mailgun's infrastructure",
        ours: OURS.ownAws,
      },
      { label: "Source", theirs: "Closed", ours: OURS.source },
      { label: "SMTP relay", theirs: "Yes", ours: OURS.smtp },
      { label: "Webhooks", theirs: "Yes", ours: OURS.webhooks },
      {
        label: "Dedicated IP",
        theirs: "$59 per IP per month",
        ours: "Through SES dedicated IPs in your own account",
      },
      { label: "AI agents", theirs: "—", ours: OURS.agents },
    ],
    faqs: [
      {
        q: "Is there a free alternative to Mailgun?",
        a: "Sendsprite is free to self-host with no email cap of its own. You pay Amazon SES $0.10 per 1,000 emails plus a small server, and you keep your logs for as long as you want.",
      },
      {
        q: "How long does Sendsprite keep email logs?",
        a: "As long as you like. Events are rows in your Postgres database, so retention is a setting you control rather than a plan tier.",
      },
      {
        q: "How do I migrate from Mailgun?",
        a: "Install Sendsprite, connect AWS with the one-click CloudFormation stack, verify your domain, then swap the SMTP host or API base URL and key. Webhook payloads are documented for your bounce handlers.",
      },
      {
        q: "Does Sendsprite validate email addresses?",
        a: "Sendsprite validates syntax on every send and suppresses addresses that hard-bounce or complain. It does not sell a bulk validation API; if you rely on Mailgun's, keep that piece.",
      },
    ],
    checked: "2026-08-29",
    pricingUrl: "https://www.mailgun.com/pricing/",
  },
  {
    slug: "usesend",
    name: "useSend",
    title:
      "useSend alternative — self-hosted email on Amazon SES, set up in one command",
    description:
      "Comparing useSend and Sendsprite? Both are open, self-hostable email APIs on your own Amazon SES. Sendsprite runs as one container, provisions the AWS side with a CloudFormation stack, writes your DNS to Cloudflare and adds an SMTP relay, CLI and MCP server.",
    headline: ["The useSend alternative", "that sets up AWS for you."],
    intro:
      "useSend and Sendsprite want the same thing: an open email API on Amazon SES that you can run yourself. The difference is what happens between docker pull and the first email. useSend gives you a compose file with Postgres, Redis and MinIO and asks for AWS keys; Sendsprite is one container plus Postgres, and its setup wizard creates the IAM role, SNS topics and configuration set with a CloudFormation stack and writes DKIM, SPF and DMARC to Cloudflare for you.",
    credit:
      "useSend is a good project: open source, on SES, with campaigns, contacts, inbound email and a hosted plan that starts at $10. It has been around longer, has a larger community, and its AGPL licence is the one some self-hosters want. If you already have it running, there is no reason to move.",
    switchReasons: [
      {
        title: "The AWS side is a click, not a runbook",
        body: "useSend expects you to create the IAM user, paste its keys into the environment and wire SES's SNS notifications yourself. Sendsprite's wizard launches a CloudFormation quick-create stack that provisions the IAM role, SNS topics, configuration set and event destinations, then picks the role up when the stack finishes.",
      },
      {
        title: "DNS written for you",
        body: "Authorise Cloudflare once and Sendsprite writes and verifies DKIM, SPF, MAIL FROM and DMARC. Other DNS providers get a copy-paste list with a link to the right zone. useSend shows you the records; you add them.",
      },
      {
        title: "One container, not four",
        body: "useSend's production compose file runs the app, Postgres, Redis and MinIO. Sendsprite is the app and Postgres — the queue lives in Postgres, so there is no Redis to size, back up or watch. One command installs it and opens the setup wizard.",
      },
      {
        title: "SMTP, CLI and an MCP server in the box",
        body: "Both have SMTP and webhooks. Sendsprite adds a CLI for scripts, a live SSE event stream, a Resend-shaped REST API so existing integrations move by changing the base URL, and an MCP server so an AI agent can send and query email with a scoped key.",
      },
    ],
    rows: [
      {
        label: "Self-hosting stack",
        theirs: "App + Postgres + Redis + MinIO (docker compose)",
        ours: OURS.selfHost,
      },
      {
        label: "AWS setup",
        theirs: "Create IAM keys and SNS wiring by hand, paste keys into .env",
        ours: "One-click CloudFormation stack from the setup wizard",
      },
      {
        label: "Domain DNS",
        theirs: "Records shown; you add them",
        ours: "Written and verified on Cloudflare; copy-paste list elsewhere",
      },
      {
        label: "Hosted price at 50,000 transactional / month",
        theirs: "$20 ($0.0004 per email; $10 minimum)",
        ours: OURS.price50k,
      },
      {
        label: "Hosted free tier",
        theirs: "3,000 emails / month, 100 per day, 1 domain",
        ours: OURS.free,
      },
      {
        label: "Your own AWS account",
        theirs: "Yes, when self-hosted",
        ours: OURS.ownAws,
      },
      {
        label: "Licence",
        theirs: "AGPL-3.0",
        ours: OURS.source,
      },
      { label: "SMTP relay", theirs: "Yes", ours: OURS.smtp },
      { label: "Webhooks", theirs: "Yes", ours: OURS.webhooks },
      {
        label: "Campaigns and contacts",
        theirs: "Yes",
        ours: "Yes — contact books, campaigns, RFC 8058 one-click unsubscribe",
      },
      {
        label: "Inbound email",
        theirs: "Yes",
        ours: "Not yet",
      },
      { label: "CLI", theirs: "—", ours: "Yes — npx sendsprite" },
      { label: "AI agents", theirs: "—", ours: OURS.agents },
    ],
    faqs: [
      {
        q: "What is the difference between useSend and Sendsprite?",
        a: "Both are open, self-hostable email APIs that send through Amazon SES in your own account. Sendsprite runs as a single container plus Postgres, provisions the AWS side with a one-click CloudFormation stack, writes your DNS records to Cloudflare, and ships an SMTP relay, a CLI and an MCP server. useSend needs Redis and MinIO alongside Postgres, takes AWS keys you create yourself, and has inbound email, which Sendsprite does not yet.",
      },
      {
        q: "Is Sendsprite open source like useSend?",
        a: "useSend is AGPL-3.0. Sendsprite's server is source-available under the Functional Source License (FSL-1.1-MIT), which converts to MIT two years after each release; the SDK, CLI, MCP server and shared packages are MIT. You can read, fork, self-host and modify all of it. The FSL is what lets a small team fund the project.",
      },
      {
        q: "How do I migrate from useSend to Sendsprite?",
        a: "Install Sendsprite, connect the same AWS account with the CloudFormation stack, add your domain (existing DKIM records verify straight away), then point your app at the new base URL with a new API key. Contacts export from useSend as CSV and import into a Sendsprite contact book.",
      },
      {
        q: "Does Sendsprite need Redis?",
        a: "No. The send queue, retries and scheduled jobs run on pg-boss inside Postgres, so a self-hosted install is one container and one database.",
      },
      {
        q: "Does Sendsprite handle inbound email?",
        a: "Not yet. If you rely on useSend's inbound parsing, keep that piece or wait; outbound, events, suppression, templates, contacts and campaigns are all there.",
      },
    ],
    checked: "2026-08-29",
    pricingUrl: "https://usesend.com/",
  },
  {
    slug: "amazon-ses",
    name: "Amazon SES",
    vendor: "raw",
    title: "Amazon SES dashboard and API — the email API layer SES is missing",
    description:
      "Using Amazon SES directly? Sendsprite is a free, self-hosted email API and dashboard on top of your own SES: domain setup, signed webhooks, suppression, templates, SMTP relay and logs — for SES's $0.10 per 1,000 emails.",
    headline: ["Amazon SES,", "with the product on top."],
    intro:
      "SES is the cheapest reliable way to send email and one of the least pleasant to use directly: IAM policies, SNS topics, configuration sets, event destinations, a console that hides the bounce you are looking for. Sendsprite is the layer the other email APIs sell — and it runs in your account, on your SES, for SES's price.",
    credit:
      "If you already have SES wired up with SNS, a bounce handler and a log pipeline you trust, and your team is fluent in the console, you may not need anything on top.",
    switchReasons: [
      {
        title: "SES's price, an email API's product",
        body: "You keep paying Amazon $0.10 per 1,000. Sendsprite adds the dashboard, the logs, the suppression list, the templates, the webhooks and the SDK — the things Resend and Postmark charge ten times SES's rate for.",
      },
      {
        title: "The AWS setup is one click",
        body: "A CloudFormation quick-create stack provisions the IAM role, SNS topics, configuration set and event destinations. Sendsprite waits for it and picks up the role. No policy authoring, no console spelunking.",
      },
      {
        title: "Bounces become a suppression list, not an SNS payload",
        body: "Every delivery, bounce, complaint, open and click lands in your Postgres, is searchable in the dashboard, is re-emitted as a signed webhook, and hard bounces and complaints are suppressed automatically before SES's reputation dashboard notices.",
      },
      {
        title: "Domains verified for you",
        body: "Authorise Cloudflare once and DKIM, SPF, MAIL FROM and DMARC records are written and verified. Other DNS providers get a clean copy-paste list and a link to the right zone.",
      },
    ],
    rows: [
      {
        label: "Price",
        theirs: `${SES_PER_1K} per 1,000 emails`,
        ours: `${SES_PER_1K} per 1,000 — it is the same SES — plus the box`,
      },
      {
        label: "Setup",
        theirs: "IAM, SNS, configuration sets, event destinations by hand",
        ours: "One-click CloudFormation stack",
      },
      {
        label: "Dashboard and logs",
        theirs: "CloudWatch and the SES console",
        ours: "Searchable event log per email, in your Postgres",
      },
      {
        label: "Suppression",
        theirs: "Account-level list; you wire the SNS handler",
        ours: "Automatic on hard bounce and complaint, per team, with an API",
      },
      {
        label: "Webhooks",
        theirs: "SNS topics you subscribe to",
        ours: OURS.webhooks,
      },
      {
        label: "Templates",
        theirs: "SES templates, no editor",
        ours: "Visual editor, React email, merge fields, linked layouts",
      },
      { label: "SMTP relay", theirs: "SES SMTP credentials", ours: OURS.smtp },
      {
        label: "API keys and teams",
        theirs: "IAM users and policies",
        ours: "Per-team API keys with scopes, rate limits and an audit log",
      },
      { label: "AI agents", theirs: "—", ours: OURS.agents },
      { label: "Source", theirs: "—", ours: OURS.source },
    ],
    faqs: [
      {
        q: "Does Sendsprite replace Amazon SES?",
        a: "No, it runs on it. Sendsprite is the API, dashboard and event pipeline; SES in your own AWS account does the sending. You pay Amazon SES's rate and nothing to Sendsprite when self-hosting.",
      },
      {
        q: "What AWS permissions does Sendsprite need?",
        a: "A role created by the CloudFormation stack with the SES and SNS actions the pipeline uses — sending, configuration sets, event destinations, identity verification and the SNS topics for events. The template is public and the policy is tested against every SDK call the app makes.",
      },
      {
        q: "Can I use SES's sandbox with Sendsprite?",
        a: "Yes. Sendsprite works in the SES sandbox for verified recipients and tells you when the account needs production access.",
      },
      {
        q: "Does Sendsprite support SES dedicated IPs and multiple regions?",
        a: "Sendsprite sends through the region you connect; dedicated IPs are an SES setting in your account and apply to sends from it.",
      },
    ],
    checked: "2026-08-29",
    pricingUrl: "https://aws.amazon.com/ses/pricing/",
  },
];

export function findCompetitor(slug: string): Competitor | undefined {
  return COMPETITORS.find((c) => c.slug === slug);
}
