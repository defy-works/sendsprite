import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { COMPETITORS } from "@/components/alternatives/competitors";
import { JsonLd } from "@/components/alternatives/JsonLd";
import { Footer } from "@/components/landing/Footer";
import { SectionHeader } from "@/components/landing/SectionHeader";
import { TopNav } from "@/components/landing/TopNav";
import { isLandingEnabled, siteOrigin } from "@/services/landing";

const TITLE =
  "Free, self-hosted alternative to Resend, Postmark, SendGrid, Mailgun and useSend";
const OG_IMAGE = { url: "/og/default.png", width: 1200, height: 630 };
const DESCRIPTION =
  "Sendsprite is a free, self-hosted email API on your own Amazon SES: $0.10 per 1,000 emails, unlimited retention, signed webhooks, SMTP relay, typed SDK. Compare it with Resend, Postmark, SendGrid, Mailgun, useSend and raw SES.";

export function generateMetadata(): Metadata {
  const url = `${siteOrigin()}/alternatives`;
  return {
    title: { absolute: `${TITLE} | Sendsprite` },
    description: DESCRIPTION,
    alternates: { canonical: url },
    keywords: [
      "Resend alternative",
      "Postmark alternative",
      "SendGrid alternative",
      "Mailgun alternative",
      "useSend alternative",
      "free email API",
      "self-hosted email API",
      "open source email API",
      "Amazon SES dashboard",
    ],
    openGraph: {
      type: "website",
      url,
      title: TITLE,
      description: DESCRIPTION,
      siteName: "Sendsprite",
      images: [OG_IMAGE],
    },
    twitter: {
      card: "summary_large_image",
      title: TITLE,
      description: DESCRIPTION,
      images: [OG_IMAGE.url],
    },
  };
}

export default async function AlternativesIndex() {
  if (!(await isLandingEnabled())) redirect("/app");
  const origin = siteOrigin();
  return (
    <>
      <JsonLd
        data={{
          "@context": "https://schema.org",
          "@type": "ItemList",
          name: "Sendsprite compared with other email APIs",
          itemListElement: COMPETITORS.map((c, i) => ({
            "@type": "ListItem",
            position: i + 1,
            name: `${c.name} alternative`,
            url: `${origin}/alternatives/${c.slug}`,
          })),
        }}
      />
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <TopNav />
      <main id="main">
        <section
          aria-labelledby="hero-title"
          className="relative overflow-hidden px-5 pt-16 pb-12 sm:px-12 sm:pt-24 sm:pb-16 lg:px-20"
        >
          <div
            aria-hidden
            className="grid-hairlines pointer-events-none absolute inset-0 opacity-70"
          />
          <div className="relative z-10 mx-auto max-w-7xl">
            <p className="num-stamp rise-in">Alternatives</p>
            <h1
              id="hero-title"
              className="metric-xl rise-in mt-8 max-w-5xl text-white"
              style={{
                animationDelay: "80ms",
                fontSize: "clamp(2.5rem, 7vw, 6rem)",
                lineHeight: 0.92,
              }}
            >
              The free alternative
              <br />
              to <span className="text-indigo-300 italic">every</span> email
              API.
            </h1>
            <p
              className="rise-in mt-10 max-w-xl text-base leading-relaxed text-white/75"
              style={{ animationDelay: "200ms" }}
            >
              Resend, Postmark, SendGrid and Mailgun sell the same thing: a nice
              API in front of someone else&rsquo;s mail servers, metered per
              email. Sendsprite is that API on your own box, sending through
              Amazon SES in your own account for $0.10 per 1,000 — and nothing
              to us. Already self-hosting on useSend? That one is compared too.
            </p>
          </div>
        </section>

        <section
          aria-labelledby="list-title"
          className="px-5 pb-20 sm:px-12 sm:pb-28 lg:px-20"
        >
          <div className="mx-auto max-w-7xl">
            <SectionHeader num="01" label="Pick yours" end="Six comparisons">
              <h2
                id="list-title"
                className="metric-xl max-w-3xl"
                style={{ fontSize: "clamp(1.75rem, 4vw, 3rem)" }}
              >
                Where are you sending from today?
              </h2>
            </SectionHeader>
            <ul className="mt-14 grid gap-px border border-white/12 bg-white/12 sm:grid-cols-2 lg:grid-cols-3">
              {COMPETITORS.map((c, i) => (
                <li key={c.slug} className="bg-ink">
                  <Link
                    href={`/alternatives/${c.slug}`}
                    className="group flex h-full flex-col gap-10 p-7 transition-colors duration-[var(--duration-normal)] hover:bg-indigo-950/40 sm:p-8"
                  >
                    <span
                      aria-hidden
                      className="outlined font-display text-5xl font-bold tracking-[-0.04em] text-white/35 transition-colors duration-[var(--duration-normal)] group-hover:text-indigo-300"
                    >
                      {String(i + 1).padStart(2, "0")}
                    </span>
                    <div className="flex flex-col gap-3">
                      <h3 className="text-lg font-semibold tracking-[-0.01em] text-white">
                        {c.slug === "amazon-ses"
                          ? "Amazon SES, with a product on top"
                          : `${c.name} alternative`}
                      </h3>
                      <p className="text-sm leading-relaxed text-white/65">
                        {c.headline.join(" ")}
                      </p>
                      <span className="num-stamp mt-2 group-hover:text-indigo-200">
                        Compare →
                      </span>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </section>
      </main>
      <Footer />
    </>
  );
}
