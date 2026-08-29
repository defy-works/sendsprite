import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { JsonLd } from "@/components/alternatives/JsonLd";
import { isLandingEnabled, siteOrigin } from "@/services/landing";
import { GITHUB_URL } from "@/components/landing/Footer";
import { Alternatives } from "@/components/landing/Alternatives";
import { CodeTabs } from "@/components/landing/CodeTabs";
import { FeatureGrid } from "@/components/landing/FeatureGrid";
import { Footer } from "@/components/landing/Footer";
import { Hero } from "@/components/landing/Hero";
import { SectionHeader } from "@/components/landing/SectionHeader";
import { Steps } from "@/components/landing/Steps";
import { TopNav } from "@/components/landing/TopNav";

const TITLE = "Sendsprite — free, self-hosted email API on Amazon SES";
const OG_IMAGE = { url: "/og/default.png", width: 1200, height: 630 };
const DESCRIPTION =
  "Self-hosted email API on Amazon SES. One container, one command. A free alternative to Resend, Postmark, SendGrid and Mailgun: $0.10 per 1,000 emails, your domains, your data.";

export function generateMetadata(): Metadata {
  const url = siteOrigin();
  return {
    title: { absolute: TITLE },
    description: DESCRIPTION,
    alternates: { canonical: url },
    keywords: [
      "self-hosted email API",
      "open source email API",
      "Amazon SES email API",
      "Resend alternative",
      "Postmark alternative",
      "SendGrid alternative",
      "Mailgun alternative",
      "transactional email API",
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

export default async function HomePage() {
  // The instance setting wins; the env value is the fallback while unset.
  if (!(await isLandingEnabled())) redirect("/app");
  const origin = siteOrigin();
  return (
    <>
      <JsonLd
        data={[
          {
            "@context": "https://schema.org",
            "@type": "SoftwareApplication",
            name: "Sendsprite",
            url: origin,
            applicationCategory: "DeveloperApplication",
            operatingSystem: "Docker, Linux",
            description: DESCRIPTION,
            offers: {
              "@type": "Offer",
              price: "0",
              priceCurrency: "USD",
              description: "Free to self-host",
            },
            sameAs: [GITHUB_URL],
            author: {
              "@type": "Organization",
              name: "defy.works",
              url: "https://defy.works",
            },
          },
          {
            "@context": "https://schema.org",
            "@type": "WebSite",
            name: "Sendsprite",
            url: origin,
          },
        ]}
      />
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <TopNav />
      <main id="main">
        <Hero />
        <FeatureGrid />
        <section
          aria-labelledby="send-title"
          className="px-5 py-20 sm:px-12 sm:py-28 lg:px-20"
        >
          <div className="mx-auto max-w-7xl">
            <SectionHeader num="03" label="Send" end="Same API, four ways in">
              <h2
                id="send-title"
                className="metric-xl max-w-3xl"
                style={{ fontSize: "clamp(2rem, 4.5vw, 3.5rem)" }}
              >
                The API you already know,
                <br />
                on the box you already own.
              </h2>
            </SectionHeader>
            <div className="mt-14 grid gap-10 lg:grid-cols-[1fr_1.4fr] lg:gap-20">
              <p className="max-w-md text-base leading-relaxed text-white/70">
                A REST API with a typed SDK, React email components, a CLI for
                scripts and an MCP server for agents. Every path goes through
                the same queue, the same suppression list and the same event
                log.
              </p>
              <CodeTabs />
            </div>
          </div>
        </section>
        <Steps />
        <Alternatives />
      </main>
      <Footer />
    </>
  );
}
