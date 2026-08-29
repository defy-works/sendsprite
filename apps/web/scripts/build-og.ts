/**
 * Renders the Open Graph images into `public/og/` with the site's own fonts
 * and tokens: `default.png` for every page, and one per `/alternatives/<slug>`
 * with the competitor in the headline. Re-run after changing a headline:
 *
 *   bun run og
 *
 * Playwright rather than `next/og` (satori): satori cannot load the variable
 * woff2 the site ships and does not synthesise the italic the hero uses, so
 * the image would not match the page it previews.
 */
import { readFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";
import { COMPETITORS } from "../src/components/alternatives/competitors";

const PUBLIC = resolve(import.meta.dirname, "../public");
const OUT = resolve(PUBLIC, "og");
const W = 1200;
const H = 630;

const font = (file: string) =>
  `url(data:font/woff2;base64,${readFileSync(resolve(PUBLIC, "fonts", file)).toString("base64")}) format("woff2-variations")`;

const LOCKUP = readFileSync(resolve(PUBLIC, "brand/lockup.svg"), "utf8")
  // 76x15 grid; scale 3 keeps every pixel whole.
  .replace("<svg ", '<svg width="228" height="45" ');

type Card = {
  file: string;
  eyebrow: string;
  /** Lines of the headline; the last one is set in indigo italic. */
  lines: string[];
  copy: string;
  /** Headline font size in px. */
  size: number;
};

/**
 * Largest size (capped at 104px) at which the longest headline line still
 * fits the 1072px column; Space Grotesk Bold at -0.04em runs ~0.46em/char.
 */
const fit = (lines: string[]) =>
  Math.min(
    104,
    Math.floor(1072 / (0.46 * Math.max(...lines.map((l) => l.length)))),
  );

const CARDS: Card[] = [
  {
    file: "default.png",
    eyebrow: "01 — Self-hosted",
    lines: ["The email API", "you run", "yourself."],
    copy: "Amazon SES under the hood. One container, one command. Your domains, your data.",
    size: 118,
  },
  ...COMPETITORS.map((c) => ({
    file: `alternatives-${c.slug}.png`,
    eyebrow: `Alternatives / ${c.name}`,
    lines: [c.headline[0], c.headline[1]],
    copy: "Free to self-host on your own Amazon SES: $0.10 per 1,000 emails, your logs kept for as long as you like.",
    size: fit(c.headline),
  })),
];

function html(card: Card): string {
  const head = card.lines.slice(0, -1);
  const last = card.lines[card.lines.length - 1];
  // Two-line headlines keep the accent on its own line; three-line ones join
  // the last two lines as the hero does ("you run yourself.").
  const headline =
    card.lines.length === 3
      ? `${head[0]}<br>${head[1]} <em>${last}</em>`
      : `${head.join("<br>")}<br><em>${last}</em>`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face{font-family:"Space Grotesk";src:${font("SpaceGrotesk-Variable.woff2")};font-weight:300 700}
@font-face{font-family:"SUIT";src:${font("SUIT-Variable.woff2")};font-weight:100 900}
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:${W}px;height:${H}px;background:#000;overflow:hidden}
body{font-family:"Space Grotesk","SUIT",sans-serif;color:#fff;position:relative;padding:56px 64px;
  background-image:linear-gradient(to right,rgba(255,255,255,.035) 1px,transparent 1px),linear-gradient(to bottom,rgba(255,255,255,.035) 1px,transparent 1px);
  background-size:80px 80px}
.mono{font-family:ui-monospace,"JetBrains Mono","SF Mono",Menlo,Consolas,monospace}
.eyebrow{margin-top:44px;font-size:14px;letter-spacing:.24em;text-transform:uppercase;color:rgba(165,180,252,.85)}
h1{margin-top:22px;font-weight:700;font-size:${card.size}px;line-height:.92;letter-spacing:-.04em;max-width:1072px}
h1 em{font-style:italic;color:#a5b4fc}
.foot{position:absolute;left:64px;right:64px;bottom:56px;display:flex;justify-content:space-between;align-items:flex-end;gap:48px}
.copy{max-width:440px;font-size:20px;line-height:1.4;color:rgba(255,255,255,.72)}
.install{display:flex;flex-direction:column;gap:10px}
.install .label{font-size:12px;letter-spacing:.24em;text-transform:uppercase;color:rgba(165,180,252,.85)}
.cmd{display:flex;align-items:center;border:1px solid rgba(255,255,255,.14);border-radius:8px;background:rgba(255,255,255,.03);font-size:17px}
.cmd .p{padding:14px 22px;border-right:1px solid rgba(255,255,255,.14);color:#a5b4fc}
.cmd .c{padding:14px 26px;color:#fff}
</style></head><body>
${LOCKUP}
<p class="eyebrow mono">${card.eyebrow}</p>
<h1>${headline}</h1>
<div class="foot">
  <p class="copy">${card.copy}</p>
  <div class="install">
    <span class="label mono">Install</span>
    <div class="cmd mono"><span class="p">$</span><span class="c">curl -fsSL https://sendsprite.com/install.sh | sh</span></div>
  </div>
</div>
</body></html>`;
}

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: W, height: H },
  deviceScaleFactor: 1,
});
for (const card of CARDS) {
  await page.setContent(html(card), { waitUntil: "load" });
  await page.evaluate(() => document.fonts.ready);
  const path = resolve(OUT, card.file);
  await page.screenshot({ path, type: "png" });
  console.log(`wrote public/og/${card.file}`);
}
await browser.close();
