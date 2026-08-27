import {
  CampaignBlock,
  type ColumnLayout,
  type LeafBlock,
} from "@sendsprite/shared";

/**
 * What the editor can add, what a fresh one holds, and how a block is
 * identified while it is being edited.
 *
 * Shared by the campaign editor and the template designer, which is why it is
 * here rather than under `app/app/campaigns/`. Nothing in this file reaches a
 * database or a `next/*` module, so it is unit-testable on its own.
 */

/* ------------------------------------------------------------------ *
 * The block list
 * ------------------------------------------------------------------ */

export type BlockKind = CampaignBlock["kind"];
/** Everything that can sit inside a column, which is everything but a row. */
export type LeafKind = LeafBlock["kind"];

/** Insertion order of the block palette, and the only leaf kinds that exist. */
export const BLOCK_KINDS = [
  "heading",
  "text",
  "button",
  "image",
  "divider",
  "spacer",
] as const satisfies readonly LeafKind[];

export const BLOCK_LABELS: Record<BlockKind, string> = {
  heading: "Heading",
  text: "Text",
  button: "Button",
  image: "Image",
  divider: "Divider",
  spacer: "Spacer",
  columns: "Columns",
};

/** What each layout is called in the palette, and what it looks like. */
export const LAYOUT_LABELS: Record<ColumnLayout, string> = {
  "1": "One column",
  "1-1": "Two columns",
  "1-1-1": "Three columns",
  "2-1": "Wide + narrow",
  "1-2": "Narrow + wide",
};

/**
 * What a freshly added block holds.
 *
 * Every default is a **valid** block, which is a deliberate choice with a
 * cost: a button carries `https://example.com` until somebody changes it. The
 * alternative — an empty required URL — makes `renderBlocks` throw for the
 * whole body the instant a button is added, so adding a block would blank the
 * preview rather than show the thing that was just added. Per-block validation
 * (`blockIssue`) reports a field left empty afterwards, and the service
 * refuses the save regardless, so the placeholder cannot reach a send silently.
 */
export function blockDefaults(kind: LeafKind): LeafBlock {
  switch (kind) {
    case "heading":
      return { kind: "heading", level: 2, text: "Your headline" };
    case "text":
      return { kind: "text", html: "Write your message here." };
    case "button":
      return { kind: "button", label: "Read more", url: "https://example.com" };
    case "image":
      return {
        kind: "image",
        url: "https://example.com/image.png",
        alt: "Describe this image",
      };
    case "divider":
      return { kind: "divider" };
    case "spacer":
      return { kind: "spacer", size: 24 };
  }
}

/**
 * One token per module instance, so the server and the browser cannot mint the
 * same id.
 *
 * The initial tree is built on the server (it comes off a stored row and
 * arrives as a prop), and every block added afterwards is minted in the
 * browser. A bare counter would have the browser's first "add block" collide
 * with the server's first block — same React key, same dnd-kit id, and a drag
 * that edits the wrong card. The counter alone is not enough and a random id
 * per block is more than is needed.
 *
 * The tree itself lives in `tree.ts`; this stays here because it is the id
 * scheme, not the structure, and `tree.ts` imports it.
 */
const ID_PREFIX = Math.random().toString(36).slice(2, 8);
let idCounter = 0;

/** Unique within one editor session, which is the whole requirement. */
export const newBlockId = (): string => `blk-${ID_PREFIX}-${++idCounter}`;

/**
 * Why one block would be refused, or `null`.
 *
 * The same `CampaignBlock` the service and the renderer parse, so a field the
 * editor flags is a field the save would have rejected — there is no second
 * set of rules for the form to disagree with.
 */
export function blockIssue(block: CampaignBlock): string | null {
  const parsed = CampaignBlock.safeParse(block);
  if (parsed.success) return null;
  return parsed.error.issues[0]?.message ?? "This block is not valid.";
}
