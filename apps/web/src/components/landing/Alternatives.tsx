import Link from "next/link";
import { COMPETITORS } from "@/components/alternatives/competitors";
import { SectionHeader } from "./SectionHeader";

/** Landing section linking every `/alternatives/<slug>` comparison. */
export function Alternatives() {
  return (
    <section
      aria-labelledby="alternatives-title"
      className="px-5 py-20 sm:px-12 sm:py-28 lg:px-20"
    >
      <div className="mx-auto max-w-7xl">
        <SectionHeader
          num="05"
          label="Switching"
          end="Same API shape, a tenth of the price"
        >
          <h2
            id="alternatives-title"
            className="metric-xl max-w-3xl"
            style={{ fontSize: "clamp(2rem, 4.5vw, 3.5rem)" }}
          >
            A free alternative to the email API
            <br />
            you pay for today.
          </h2>
        </SectionHeader>
        <div className="mt-14 grid gap-10 lg:grid-cols-[1fr_1.4fr] lg:gap-20">
          <p className="max-w-md text-base leading-relaxed text-white/70">
            Resend, Postmark, SendGrid and Mailgun meter every email. Sendsprite
            sends through Amazon SES in your own account for $0.10 per 1,000,
            keeps your logs for as long as you like, and charges nothing to
            self-host.
          </p>
          <ul className="flex flex-wrap gap-3 self-start">
            {COMPETITORS.map((c) => (
              <li key={c.slug}>
                <Link
                  href={`/alternatives/${c.slug}`}
                  className="inline-flex h-10 items-center rounded-md border border-white/20 px-4 text-sm text-white/80 transition-colors duration-[var(--duration-fast)] hover:border-indigo-400/70 hover:bg-indigo-500/10 hover:text-indigo-200"
                >
                  {c.slug === "amazon-ses"
                    ? "vs raw Amazon SES"
                    : `${c.name} alternative`}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
