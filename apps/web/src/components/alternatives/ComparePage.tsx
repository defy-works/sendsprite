import Link from "next/link";
import { Footer, GITHUB_URL } from "@/components/landing/Footer";
import { InstallCommand } from "@/components/landing/InstallCommand";
import { SectionHeader } from "@/components/landing/SectionHeader";
import { TopNav } from "@/components/landing/TopNav";
import { JsonLd } from "./JsonLd";
import { COMPETITORS, type Competitor } from "./competitors";

const CTA_BASE =
  "inline-flex h-12 items-center justify-center gap-3 rounded-md px-6 text-sm font-medium " +
  "tracking-wide transition-colors duration-[var(--duration-fast)]";

const H2 = "metric-xl max-w-3xl";
const H2_SIZE = { fontSize: "clamp(1.75rem, 4vw, 3rem)" };

/**
 * One `/alternatives/<slug>` page. Everything is server-rendered plain HTML
 * with the headline phrases in the H1, H2s and FAQ so the page reads as an
 * answer to "<competitor> alternative" rather than as a feature list; the
 * FAQ is mirrored into `FAQPage` structured data.
 */
export function ComparePage({ c, origin }: { c: Competitor; origin: string }) {
  const url = `${origin}/alternatives/${c.slug}`;
  const others = COMPETITORS.filter((o) => o.slug !== c.slug);

  return (
    <>
      <JsonLd
        data={[
          {
            "@context": "https://schema.org",
            "@type": "FAQPage",
            mainEntity: c.faqs.map((f) => ({
              "@type": "Question",
              name: f.q,
              acceptedAnswer: { "@type": "Answer", text: f.a },
            })),
          },
          {
            "@context": "https://schema.org",
            "@type": "BreadcrumbList",
            itemListElement: [
              {
                "@type": "ListItem",
                position: 1,
                name: "Sendsprite",
                item: origin,
              },
              {
                "@type": "ListItem",
                position: 2,
                name: "Alternatives",
                item: `${origin}/alternatives`,
              },
              {
                "@type": "ListItem",
                position: 3,
                name: `${c.name} alternative`,
                item: url,
              },
            ],
          },
        ]}
      />
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <TopNav />
      <main id="main">
        <section
          aria-labelledby="hero-title"
          className="relative overflow-hidden px-5 pt-16 pb-16 sm:px-12 sm:pt-24 sm:pb-24 lg:px-20"
        >
          <div
            aria-hidden
            className="grid-hairlines pointer-events-none absolute inset-0 opacity-70"
          />
          <div className="relative z-10 mx-auto max-w-7xl">
            <nav aria-label="Breadcrumb" className="num-stamp rise-in">
              <Link href="/alternatives" className="hover:text-indigo-200">
                Alternatives
              </Link>
              <span aria-hidden> / </span>
              <span className="text-white/60">{c.name}</span>
            </nav>
            <h1
              id="hero-title"
              className="metric-xl rise-in mt-8 max-w-5xl text-white"
              style={{
                animationDelay: "80ms",
                fontSize: "clamp(2.5rem, 7vw, 6rem)",
                lineHeight: 0.92,
              }}
            >
              {c.headline[0]}
              <br />
              <span className="text-indigo-300 italic">{c.headline[1]}</span>
            </h1>
            <div
              className="rise-in mt-12 grid gap-10 lg:grid-cols-[1fr_1.15fr] lg:items-end lg:gap-20"
              style={{ animationDelay: "200ms" }}
            >
              <div className="flex min-w-0 flex-col gap-8">
                <p className="max-w-lg text-base leading-relaxed text-white/75">
                  {c.intro}
                </p>
                <div className="flex flex-wrap items-center gap-3">
                  <Link
                    href="/app"
                    className={`${CTA_BASE} bg-indigo-500 text-white hover:bg-indigo-400 active:bg-indigo-600`}
                  >
                    Start free
                    <span aria-hidden className="font-mono text-xs">
                      →
                    </span>
                  </Link>
                  <Link
                    href="/docs/self-hosting"
                    className={`${CTA_BASE} border border-white/20 text-white/85 hover:border-indigo-400/70 hover:bg-indigo-500/10 hover:text-indigo-200`}
                  >
                    Self-host in 2 minutes
                  </Link>
                </div>
              </div>
              <div className="flex min-w-0 flex-col gap-3">
                <p className="num-stamp">Install</p>
                <InstallCommand />
                <p className="font-mono text-[11px] tracking-[0.08em] text-white/40">
                  Docker + Postgres. Prompts for a domain, brings up the
                  container, opens the setup wizard.
                </p>
              </div>
            </div>
          </div>
        </section>

        <section
          aria-labelledby="why-title"
          className="px-5 py-20 sm:px-12 sm:py-28 lg:px-20"
        >
          <div className="mx-auto max-w-7xl">
            <SectionHeader
              num="01"
              label={`Why leave ${c.name}`}
              end="Where it is fair to say so"
            >
              <h2 id="why-title" className={H2} style={H2_SIZE}>
                What you give up staying on {c.name}.
              </h2>
            </SectionHeader>
            <p className="mt-8 max-w-2xl text-sm leading-relaxed text-white/55">
              {c.credit}
            </p>
            <ul className="mt-14 grid gap-px border border-white/12 bg-white/12 sm:grid-cols-2">
              {c.switchReasons.map((r, i) => (
                <li
                  key={r.title}
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
                      {r.title}
                    </h3>
                    <p className="text-sm leading-relaxed text-white/65">
                      {r.body}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section
          aria-labelledby="table-title"
          className="relative px-5 py-20 sm:px-12 sm:py-28 lg:px-20"
        >
          <div
            aria-hidden
            className="grid-hairlines pointer-events-none absolute inset-0 opacity-40"
          />
          <div className="relative z-10 mx-auto max-w-7xl">
            <SectionHeader
              num="02"
              label="Side by side"
              end={`List prices checked ${c.checked}`}
            >
              <h2 id="table-title" className={H2} style={H2_SIZE}>
                Sendsprite vs {c.name}
                {c.vendor && c.vendor !== "raw" ? ` (${c.vendor})` : ""}.
              </h2>
            </SectionHeader>
            <div className="mt-14 overflow-x-auto">
              <table className="w-full min-w-[40rem] border-collapse text-sm">
                <caption className="sr-only">
                  Feature and price comparison of Sendsprite and {c.name}
                </caption>
                <thead>
                  <tr className="text-left">
                    <th scope="col" className="num-stamp pb-4 pr-6 font-normal">
                      &nbsp;
                    </th>
                    <th
                      scope="col"
                      className="num-stamp pr-6 pb-4 font-normal text-white/50"
                    >
                      {c.name}
                    </th>
                    <th scope="col" className="num-stamp pb-4 font-normal">
                      Sendsprite
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {c.rows.map((r) => (
                    <tr key={r.label} className="border-t border-white/12">
                      <th
                        scope="row"
                        className="py-4 pr-6 align-top font-medium text-white"
                      >
                        {r.label}
                      </th>
                      <td className="py-4 pr-6 align-top leading-relaxed text-white/55">
                        {r.theirs}
                      </td>
                      <td className="py-4 align-top leading-relaxed text-white/85">
                        {r.ours}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-6 font-mono text-[11px] tracking-[0.08em] text-white/40">
              {c.name} figures are list prices from{" "}
              <a
                href={c.pricingUrl}
                rel="nofollow noopener"
                className="underline decoration-white/30 underline-offset-4 hover:text-indigo-200"
              >
                {c.pricingUrl.replace(/^https?:\/\//, "")}
              </a>{" "}
              on {c.checked}. Amazon SES is $0.10 per 1,000 outbound emails plus
              $0.12 per GB of attachments.
            </p>
          </div>
        </section>

        <section
          aria-labelledby="faq-title"
          className="px-5 py-20 sm:px-12 sm:py-28 lg:px-20"
        >
          <div className="mx-auto max-w-7xl">
            <SectionHeader num="03" label="Questions" end="Straight answers">
              <h2 id="faq-title" className={H2} style={H2_SIZE}>
                {c.name} alternative, asked plainly.
              </h2>
            </SectionHeader>
            <dl className="mt-14 grid gap-x-16 gap-y-10 lg:grid-cols-2">
              {c.faqs.map((f) => (
                <div key={f.q} className="flex flex-col gap-3">
                  <dt className="text-lg font-semibold tracking-[-0.01em] text-white">
                    {f.q}
                  </dt>
                  <dd className="text-sm leading-relaxed text-white/65">
                    {f.a}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        </section>

        <section
          aria-labelledby="more-title"
          className="px-5 pb-20 sm:px-12 sm:pb-28 lg:px-20"
        >
          <div className="mx-auto max-w-7xl">
            <SectionHeader
              num="04"
              label="Also compared"
              end="Same box, same price"
            >
              <h2 id="more-title" className={H2} style={H2_SIZE}>
                Coming from somewhere else?
              </h2>
            </SectionHeader>
            <ul className="mt-10 flex flex-wrap gap-3">
              {others.map((o) => (
                <li key={o.slug}>
                  <Link
                    href={`/alternatives/${o.slug}`}
                    className="inline-flex h-10 items-center rounded-md border border-white/20 px-4 text-sm text-white/80 transition-colors duration-[var(--duration-fast)] hover:border-indigo-400/70 hover:bg-indigo-500/10 hover:text-indigo-200"
                  >
                    {o.name} alternative
                  </Link>
                </li>
              ))}
              <li>
                <a
                  href={GITHUB_URL}
                  className="inline-flex h-10 items-center rounded-md border border-white/20 px-4 text-sm text-white/80 transition-colors duration-[var(--duration-fast)] hover:border-indigo-400/70 hover:bg-indigo-500/10 hover:text-indigo-200"
                >
                  Read the source
                </a>
              </li>
            </ul>
          </div>
        </section>
      </main>
      <Footer />
    </>
  );
}
