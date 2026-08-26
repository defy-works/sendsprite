import { SectionHeader } from "./SectionHeader";

const FEATURES = [
  {
    title: "SES, set up for you",
    body: "One click launches a CloudFormation stack: IAM role, SNS topics, event destinations. No console spelunking, and the credentials never leave your account.",
  },
  {
    title: "Cloudflare DNS",
    body: "Hand over a token and DKIM, SPF, MAIL FROM and DMARC records are written and verified for you. Every other provider gets a clean copy-paste list.",
  },
  {
    title: "Webhooks and a live stream",
    body: "Signed webhooks for every delivery, bounce, complaint and open. A server-sent stream for anything that wants to watch in real time.",
  },
  {
    title: "Reputation guardrails",
    body: "Automatic suppression on hard bounces and complaints, per-team rate limits, and bounce-rate alerts before SES ever notices.",
  },
  {
    title: "SMTP relay",
    body: "Point legacy apps, printers and cron jobs at port 587 with an API key as the password. Same pipeline, same logs, same suppressions.",
  },
  {
    title: "MCP server",
    body: "Let an agent check domains, send test emails and read delivery stats through the Model Context Protocol, scoped by the same API keys.",
  },
];

export function FeatureGrid() {
  return (
    <section
      aria-labelledby="features-title"
      className="px-5 py-20 sm:px-12 sm:py-28 lg:px-20"
    >
      <div className="mx-auto max-w-7xl">
        <SectionHeader
          num="02"
          label="What ships"
          end="Six things, one container"
        >
          <h2
            id="features-title"
            className="metric-xl max-w-3xl"
            style={{ fontSize: "clamp(2rem, 4.5vw, 3.5rem)" }}
          >
            Everything between your app
            <br />
            and the inbox.
          </h2>
        </SectionHeader>

        <ul className="mt-14 grid gap-px border border-white/12 bg-white/12 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((f, i) => (
            <li
              key={f.title}
              className="group flex flex-col gap-10 bg-ink p-7 transition-colors duration-[var(--duration-normal)] hover:bg-indigo-950/40 sm:p-8"
            >
              <span
                aria-hidden
                className="outlined font-display text-5xl font-bold tracking-[-0.04em] text-white/35 transition-colors duration-[var(--duration-normal)] group-hover:text-indigo-300"
              >
                {String(i + 1).padStart(2, "0")}
              </span>
              <div className="flex flex-col gap-3">
                <h3 className="text-lg font-semibold tracking-[-0.01em] text-white">
                  {f.title}
                </h3>
                <p className="text-sm leading-relaxed text-white/65">
                  {f.body}
                </p>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
