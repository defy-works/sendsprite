/* Sendsprite pixel-art brand generator.
 * Everything is drawn on an integer grid; SVG output merges horizontal runs
 * so the files stay tiny and every edge lands on a whole unit. */
import { writeFileSync, mkdirSync } from "node:fs";
import { encodePng } from "./png.mjs";

const INK = "#0a0a0a";
const PAPER = "#ffffff";
const INDIGO_400 = "#818cf8";

/* ---------- tiny raster ---------- */
class Grid {
  constructor(w, h) {
    this.w = w;
    this.h = h;
    this.px = new Map();
  }
  set(x, y, c) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    this.px.set(`${x},${y}`, c);
  }
  get(x, y) {
    return this.px.get(`${x},${y}`) ?? null;
  }
  /** merge horizontal runs -> <rect> list */
  rects() {
    const out = [];
    for (let y = 0; y < this.h; y++) {
      let x = 0;
      while (x < this.w) {
        const c = this.get(x, y);
        if (!c) {
          x++;
          continue;
        }
        let n = 1;
        while (x + n < this.w && this.get(x + n, y) === c) n++;
        out.push({ x, y, w: n, c });
        x += n;
      }
    }
    return out;
  }
  svgBody(map = (c) => c, dx = 0, dy = 0) {
    const byColor = new Map();
    for (const r of this.rects()) {
      const c = map(r.c);
      if (!c) continue; // dropped -> knocked out, shows the surface behind
      if (!byColor.has(c)) byColor.set(c, []);
      byColor.get(c).push(`M${r.x + dx} ${r.y + dy}h${r.w}v1h-${r.w}z`);
    }
    return [...byColor]
      .map(([c, d]) => `<path fill="${c}" d="${d.join("")}"/>`)
      .join("");
  }
}

/* ---------- the mark: an envelope ---------- */
/* A whole envelope in single-pixel line — all four sides closed, nothing
 * filled, so the black reads straight through it.
 *
 * The flap forms the top edge rather than sitting as a V inside a straight
 * one: draw a closed rectangle and then a crease inside it and the rectangle
 * wins the gestalt every time, and the mark reads as a box.
 *
 * An asymmetric flap was tried first (short fall to an off-centre crease, long
 * climb to a peak at the top right). In hard pixel line it reads as a chart
 * line inside a box rather than as a fold, so the flap is symmetric.
 *
 * Colour is a ramp across the top-left/bottom-right diagonal, quantised per
 * pixel so every cell is one flat value. A gradient, not a bevel: no edge is
 * lit to fake a raised surface. */
const RAMP_DARK = ["#c7d2fe", "#a5b4fc", "#818cf8", "#6366f1", "#4f46e5"];
const RAMP_LIGHT = ["#818cf8", "#6366f1", "#4f46e5", "#4338ca", "#312e81"];

function ramped(ramp, x, y, box) {
  const t = (x - box.x) / box.w / 2 + (y - box.y) / box.h / 2;
  const i = Math.min(ramp.length - 1, Math.floor(t * ramp.length));
  return ramp[i];
}

const ENV_W = 18;
const ENV_H = 13;
const STROKE = 2; // every line is two pixels

/** Draws an 18 x 13 envelope with its top-left corner at ox,oy. */
function envelope(g, ox, oy, ramp) {
  const box = { x: ox, y: oy, w: ENV_W, h: ENV_H };
  const put = (x, y) =>
    g.set(ox + x, oy + y, ramped(ramp, ox + x, oy + y, box));
  /** one stroke-thick mark, weight added downward so diagonals stay joined */
  const nib = (x, y) => {
    for (let t = 0; t < STROKE; t++) put(x, y + t);
  };

  // The flap falls from both shoulders to a crease five rows down — a little
  // under halfway, which is where a folded flap actually sits. Two columns per
  // row until the last, so the fold leaves the shoulder flatter and steepens
  // as it drops, the way paper hangs.
  const half = ENV_W / 2 - 1;
  for (let x = 0, row = 0; x <= half; row++) {
    const cols = x <= half - 2 ? 2 : 1;
    for (let i = 0; i < cols && x <= half; i++, x++) {
      nib(x, row);
      nib(ENV_W - 1 - x, row);
    }
  }

  for (let y = STROKE; y < ENV_H; y++) {
    for (let t = 0; t < STROKE; t++) {
      put(t, y); // left edge
      put(ENV_W - 1 - t, y); // right edge
    }
  }
  for (let x = 0; x < ENV_W; x++) {
    for (let t = 0; t < STROKE; t++) put(x, ENV_H - 1 - t); // bottom
  }
}

function markGrid(ramp = RAMP_DARK) {
  const g = new Grid(20, 15); // 18 x 13 art with a pixel of air around it
  envelope(g, 1, 1, ramp);
  return g;
}

function tileGlyphGrid(ramp = RAMP_DARK) {
  const g = new Grid(24, 24); // same art, centred on the tile
  envelope(g, 3, 6, ramp);
  return g;
}

/* ---------- pixel typeface (5 x-height rows, y0..y8 em) ---------- */
// rows are y0..y8; "#" = on. Ascenders start at y0, baseline is y6.
const FONT = {
  S: [
    "  .####",
    "  #....",
    "  #....",
    "  .###.",
    "  ....#",
    "  ....#",
    "  ####.",
  ].map((s) => s.slice(2)),
  e: [".....", ".....", ".###.", "#...#", "#####", "#....", ".###."],
  n: [".....", ".....", "#.##.", "##..#", "#...#", "#...#", "#...#"],
  d: ["....#", "....#", ".####", "#...#", "#...#", "#...#", ".####"],
  s: [".....", ".....", ".####", "#....", ".###.", "....#", "####."],
  p: [
    ".....",
    ".....",
    "####.",
    "#...#",
    "#...#",
    "#...#",
    "####.",
    "#....",
    "#....",
  ],
  r: ["....", "....", "#.##", "##..", "#...", "#...", "#..."],
  i: [".", "#", ".", "#", "#", "#", "#"],
  t: [".#.", ".#.", "###", ".#.", ".#.", ".#.", ".##"],
};

function textGrid(text, colorOf) {
  const glyphs = [...text].map((ch) => FONT[ch]);
  const w = glyphs.reduce((a, gl) => a + gl[0].length + 1, -1);
  const g = new Grid(w, 9);
  let x = 0;
  glyphs.forEach((gl, idx) => {
    const c = colorOf(idx, text[idx]);
    gl.forEach((row, y) => {
      [...row].forEach((ch, i) => {
        if (ch === "#") g.set(x + i, y, c);
      });
    });
    x += gl[0].length + 1;
  });
  return g;
}

/* ---------- emit ---------- */
const svg = (vb, body, extra = "") =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}" shape-rendering="crispEdges" fill="none">${extra}${body}</svg>\n`;

const OUT = `${import.meta.dirname}/../apps/web/public/brand`;
mkdirSync(OUT, { recursive: true });

const mark = markGrid();
const tileGlyph = tileGlyphGrid();

// 1. mark, full colour, transparent background
writeFileSync(`${OUT}/mark.svg`, svg("0 0 20 15", mark.svgBody()));
writeFileSync(
  `${OUT}/mark-on-light.svg`,
  svg("0 0 20 15", markGrid(RAMP_LIGHT).svgBody()),
);

// 2. mark, flattened to one inherited colour for tight or monochrome contexts
writeFileSync(
  `${OUT}/mark-mono.svg`,
  svg(
    "0 0 20 15",
    mark.svgBody(() => "currentColor"),
  ),
);

// 3. tile (avatar / favicon): ink rounded square + centred envelope
const tileBg = `<rect width="24" height="24" rx="5.5" fill="#0a0a0a"/>`;
writeFileSync(
  `${OUT}/mark-tile.svg`,
  svg("0 0 24 24", tileGlyph.svgBody(), tileBg),
);

// 4. wordmark — one tone, so the mark carries the only colour in the lockup
const WORD = "Sendsprite";
const wmDark = textGrid(WORD, () => PAPER);
const wmLight = textGrid(WORD, () => INK);
const wmMono = textGrid(WORD, () => "currentColor");
const wmDuo = textGrid(WORD, (i) => (i < 4 ? PAPER : INDIGO_400));
const wmW = wmDark.w;
writeFileSync(`${OUT}/wordmark.svg`, svg(`0 0 ${wmW} 9`, wmDark.svgBody()));
writeFileSync(
  `${OUT}/wordmark-on-light.svg`,
  svg(`0 0 ${wmW} 9`, wmLight.svgBody()),
);
writeFileSync(
  `${OUT}/wordmark-mono.svg`,
  svg(`0 0 ${wmW} 9`, wmMono.svgBody()),
);
writeFileSync(`${OUT}/wordmark-duo.svg`, svg(`0 0 ${wmW} 9`, wmDuo.svgBody()));

// 5. lockup. The mark is 15 deep against a 9-deep wordmark; dropping the type
// 4 rows centres its cap-to-baseline run on the envelope. The mark carries a
// two-pixel stroke against the wordmark's one, but relative to their own
// heights those are 2/15 and 1/9 — near enough the same weight on the page.
const GAP = 4;
const lockMark = new Grid(20, 15);
envelope(lockMark, 1, 1, RAMP_DARK);
const lockMarkLight = new Grid(20, 15);
envelope(lockMarkLight, 1, 1, RAMP_LIGHT);
const lockW = 20 + GAP + wmW;
const lockup = (art, word) =>
  svg(`0 0 ${lockW} 15`, art.svgBody() + word.svgBody((c) => c, 20 + GAP, 4));
writeFileSync(`${OUT}/lockup.svg`, lockup(lockMark, wmDark));
writeFileSync(`${OUT}/lockup-on-light.svg`, lockup(lockMarkLight, wmLight));

// 6. favicon — the tile, shipped under its own name
writeFileSync(
  `${OUT}/favicon.svg`,
  svg("0 0 24 24", tileGlyph.svgBody(), tileBg),
);

// 7. TSX paths for the React component
const jsx = {
  mark: mark.svgBody(),
  markMono: mark.svgBody(() => "currentColor"),
  tile: tileGlyph.svgBody(),
  word: wmDark.svgBody(),
  wordMono: wmMono.svgBody(),
  lockMark: lockMark.svgBody(),
  wordW: wmW,
  lockW,
  gap: GAP,
};

/* ---------- React component ---------- */
const tsx = `/* GENERATED pixel-art brand marks — see scripts/gen-brand.mjs.
 * Every coordinate is a whole unit on the source grid (20x15 for the mark,
 * 52x9 for the wordmark). These are bitmaps: they are crisp at a whole
 * multiple of that grid and nowhere else — see the note further down.
 * Edit the generator and re-run it; do not edit this file. */

type SvgProps = React.SVGProps<SVGSVGElement>;

const CRISP = { shapeRendering: "crispEdges" } as const;

/* These are bitmaps, so they may only be drawn at a whole multiple of their
 * source grid. Ask for 22px of a 15-row grid and every row lands on 1.47
 * device pixels: the renderer snaps each one to 1 or 2, strokes come out
 * uneven and the type visibly breaks up. So the components take an integer
 * scale rather than a free height — the size is scale x the grid,
 * and a fractional one cannot be requested. (A 2x display doubles it again,
 * which is still whole.) */
const px = (grid: number, scale: number) => grid * Math.max(1, Math.round(scale));

/** The mark: an envelope in two-pixel line. \`mono\` inherits the current
 * colour instead of carrying the indigo ramp. */
export function Mark({
  scale = 2,
  mono = false,
  ...rest
}: SvgProps & { scale?: number; mono?: boolean }) {
  return (
    <svg
      viewBox="0 0 20 15"
      width={px(20, scale)}
      height={px(15, scale)}
      fill="none"
      style={CRISP}
      aria-hidden
      {...rest}
    >
      {mono ? <>${jsx.markMono}</> : <>${jsx.mark}</>}
    </svg>
  );
}

/** Same envelope on an ink tile — avatars, favicons, tight nav slots. */
export function MarkTile({ scale = 1, ...rest }: SvgProps & { scale?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={px(24, scale)}
      height={px(24, scale)}
      fill="none"
      style={CRISP}
      aria-hidden
      {...rest}
    >
      <rect width="24" height="24" rx="5.5" fill="#0a0a0a" />
      ${jsx.tile}
    </svg>
  );
}

/** "Sendsprite" in the pixel face. \`mono\` inherits the current colour. */
export function Wordmark({
  scale = 2,
  mono = false,
  ...rest
}: SvgProps & { scale?: number; mono?: boolean }) {
  return (
    <svg
      viewBox="0 0 ${jsx.wordW} 9"
      width={px(${jsx.wordW}, scale)}
      height={px(9, scale)}
      fill="none"
      style={CRISP}
      role="img"
      aria-label="Sendsprite"
      {...rest}
    >
      {mono ? (
        <>${jsx.wordMono}</>
      ) : (
        <>${jsx.word}</>
      )}
    </svg>
  );
}

/** Mark + wordmark, optically aligned. The default brand lockup. */
export function Logo({ scale = 2, ...rest }: SvgProps & { scale?: number }) {
  return (
    <svg
      viewBox="0 0 ${jsx.lockW} 15"
      width={px(${jsx.lockW}, scale)}
      height={px(15, scale)}
      fill="none"
      style={CRISP}
      role="img"
      aria-label="Sendsprite"
      {...rest}
    >
      ${jsx.lockMark}
      <g transform="translate(${20 + jsx.gap} 4)">${jsx.word}</g>
    </svg>
  );
}
`;
writeFileSync(`${OUT}/../../src/components/ui/Logo.tsx`, tsx);

/* ---------- PNG exports ----------
 * Bitmaps drawn straight from the grid at whole-number scales, so every source
 * pixel becomes an exact scale x scale block — no rasteriser, no antialiasing.
 * The tile's rounded corners are the one non-grid shape; they are supersampled
 * so the curve is smooth while the envelope on top stays hard-edged.
 * `currentColor` variants are skipped: a PNG cannot inherit a colour, the
 * "-on-light" files are the equivalents for light surfaces. */
const PNG_SCALES = [8, 32];

const hex = (c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));

function rasterize(grid, scale, tile = null) {
  const W = grid.w * scale;
  const H = grid.h * scale;
  const out = new Uint8Array(W * H * 4);
  if (tile) {
    const [r, g, b] = hex(tile.fill);
    const rx = tile.rx * scale;
    const SS = 4; // supersample the corner edge
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        let hit = 0;
        for (let sy = 0; sy < SS; sy++)
          for (let sx = 0; sx < SS; sx++) {
            const px = x + (sx + 0.5) / SS;
            const py = y + (sy + 0.5) / SS;
            const cx = Math.min(Math.max(px, rx), W - rx);
            const cy = Math.min(Math.max(py, rx), H - rx);
            if ((px - cx) ** 2 + (py - cy) ** 2 <= rx * rx) hit++;
          }
        const i = (y * W + x) * 4;
        out[i] = r;
        out[i + 1] = g;
        out[i + 2] = b;
        out[i + 3] = Math.round((255 * hit) / (SS * SS));
      }
  }
  for (const { x, y, w, c } of grid.rects()) {
    const [r, g, b] = hex(c);
    for (let yy = y * scale; yy < (y + 1) * scale; yy++)
      for (let xx = x * scale; xx < (x + w) * scale; xx++) {
        const i = (yy * W + xx) * 4;
        out[i] = r;
        out[i + 1] = g;
        out[i + 2] = b;
        out[i + 3] = 255;
      }
  }
  return encodePng(W, H, out);
}

/** Lockup as one grid so it rasterizes like everything else. */
function lockupGrid(art, word) {
  const g = new Grid(lockW, 15);
  for (const [k, c] of art.px) g.px.set(k, c);
  for (const [k, c] of word.px) {
    const [x, y] = k.split(",").map(Number);
    g.set(x + 20 + GAP, y + 4, c);
  }
  return g;
}

const TILE = { fill: INK, rx: 5.5 };
const pngs = {
  mark: [mark],
  "mark-on-light": [markGrid(RAMP_LIGHT)],
  "mark-tile": [tileGlyph, TILE],
  wordmark: [wmDark],
  "wordmark-on-light": [wmLight],
  "wordmark-duo": [wmDuo],
  lockup: [lockupGrid(lockMark, wmDark)],
  "lockup-on-light": [lockupGrid(lockMarkLight, wmLight)],
};
for (const [name, [grid, tile]] of Object.entries(pngs))
  for (const s of PNG_SCALES)
    writeFileSync(`${OUT}/${name}@${s}x.png`, rasterize(grid, s, tile));
