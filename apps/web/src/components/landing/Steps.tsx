import { SectionHeader } from "./SectionHeader";

const STEPS = [
  {
    title: "Install",
    body: "Run the one-liner on any box with Docker. It brings up Sendsprite and Postgres and opens the setup wizard.",
    aside: "~2 min",
  },
  {
    title: "Connect AWS",
    body: "One click launches the CloudFormation stack in your account. Sendsprite waits for it and picks up the role automatically.",
    aside: "one click",
  },
  {
    title: "Add a domain",
    body: "Type the domain. With Cloudflare authorised the records are written for you; otherwise copy them over and hit verify — we link you straight to the right zone.",
    aside: "DKIM · SPF · DMARC",
  },
  {
    title: "Send",
    body: "Create an API key and send from curl, the SDK, the CLI, SMTP or an agent. Watch it land in the dashboard.",
    aside: "POST /api/v1/emails",
  },
];

export function Steps() {
  return (
    <section
      aria-labelledby="steps-title"
      className="relative px-5 py-20 sm:px-12 sm:py-28 lg:px-20"
    >
      <div
        aria-hidden
        className="grid-hairlines pointer-events-none absolute inset-0 opacity-40"
      />
      <div className="relative z-10 mx-auto max-w-7xl">
        <SectionHeader num="04" label="From zero to sent" end="Four steps">
          <h2
            id="steps-title"
            className="metric-xl max-w-3xl"
            style={{ fontSize: "clamp(2rem, 4.5vw, 3.5rem)" }}
          >
            An afternoon, not a quarter.
          </h2>
        </SectionHeader>

        <ol className="mt-14 flex flex-col">
          {STEPS.map((s, i) => (
            <li
              key={s.title}
              className="grid gap-4 border-t border-white/12 py-8 last:border-b sm:grid-cols-[6rem_1fr_auto] sm:gap-8"
            >
              <span className="num-stamp pt-2">
                Step {String(i + 1).padStart(2, "0")}
              </span>
              <div className="flex flex-col gap-2">
                <h3 className="font-display text-2xl font-bold tracking-[-0.03em] text-white">
                  {s.title}
                </h3>
                <p className="max-w-xl text-sm leading-relaxed text-white/65">
                  {s.body}
                </p>
              </div>
              <span className="font-mono text-[11px] tracking-[0.08em] text-indigo-300/70 sm:pt-2 sm:text-right">
                {s.aside}
              </span>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
