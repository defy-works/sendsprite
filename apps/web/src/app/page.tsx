import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { env } from "@/env";
import { getInstanceSettings } from "@/services/instance-settings";
import { CodeTabs } from "@/components/landing/CodeTabs";
import { FeatureGrid } from "@/components/landing/FeatureGrid";
import { Footer } from "@/components/landing/Footer";
import { Hero } from "@/components/landing/Hero";
import { SectionHeader } from "@/components/landing/SectionHeader";
import { Steps } from "@/components/landing/Steps";
import { TopNav } from "@/components/landing/TopNav";

export const metadata: Metadata = {
  title: { absolute: "Sendsprite — self-hosted email API" },
  description:
    "Self-hosted email API on Amazon SES. One container, one command. Your domains, your data.",
};

export default async function HomePage() {
  // The instance setting wins; the env value is the fallback while unset.
  const s = await getInstanceSettings();
  const landing = s.landingEnabled ?? env.LANDING_ENABLED;
  if (!landing) redirect("/app");
  return (
    <>
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
      </main>
      <Footer />
    </>
  );
}
