import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { ComparePage } from "@/components/alternatives/ComparePage";
import { findCompetitor } from "@/components/alternatives/competitors";
import { isLandingEnabled, siteOrigin } from "@/services/landing";

type Params = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { slug } = await params;
  const c = findCompetitor(slug);
  if (!c) return {};
  const url = `${siteOrigin()}/alternatives/${c.slug}`;
  const image = {
    url: `/og/alternatives-${c.slug}.png`,
    width: 1200,
    height: 630,
  };
  return {
    title: { absolute: `${c.title} | Sendsprite` },
    description: c.description,
    alternates: { canonical: url },
    keywords: [
      `${c.name} alternative`,
      `${c.name} free alternative`,
      `free ${c.name} alternative`,
      `open source ${c.name} alternative`,
      `self-hosted ${c.name} alternative`,
      `${c.name} vs Sendsprite`,
      "self-hosted email API",
      "Amazon SES email API",
    ],
    openGraph: {
      type: "article",
      url,
      title: c.title,
      description: c.description,
      siteName: "Sendsprite",
      images: [image],
    },
    twitter: {
      card: "summary_large_image",
      title: c.title,
      description: c.description,
      images: [image.url],
    },
  };
}

export default async function AlternativePage({ params }: Params) {
  const { slug } = await params;
  const c = findCompetitor(slug);
  if (!c) notFound();
  if (!(await isLandingEnabled())) redirect("/app");
  return <ComparePage c={c} origin={siteOrigin()} />;
}
