import {
  InvalidCampaignBlockError,
  UNSUBSCRIBE_MARKER,
  renderBlocks,
  type CampaignBlock,
} from "@sendsprite/shared";

/**
 * The campaign live preview.
 *
 * Everything else that used to live here — the inline serialiser, the block
 * kinds and defaults, the editor tree — moved under `lib/editor/` when the
 * template designer started using the same editor. What is left is the one
 * part that is genuinely about *campaigns*: the unsubscribe footer, which a
 * campaign always carries and a template never does.
 */

/* ------------------------------------------------------------------ *
 * The preview
 * ------------------------------------------------------------------ */

export type CampaignPreview =
  | { ok: true; html: string; text: string }
  | { ok: false; error: string; index: number | null };

/**
 * What stands in for the per-recipient unsubscribe link.
 *
 * `renderBlocks` leaves {@link UNSUBSCRIBE_MARKER} in both parts and the
 * fan-out swaps it for a link unique to each recipient — so a preview that
 * left the marker alone would show an invisible control character where every
 * recipient sees a footer. Substituting a stand-in is the *same* step the
 * fan-out performs, one line further from the send; it is not a second
 * renderer, and the surrounding markup is still the send's own.
 */
const PREVIEW_UNSUBSCRIBE_HTML =
  "Unsubscribe (a link unique to each recipient)";
const PREVIEW_UNSUBSCRIBE_TEXT = "Unsubscribe: a link unique to each recipient";

/**
 * The live preview, rendered by the **same** `renderBlocks` the send calls.
 *
 * There is deliberately no React renderer for blocks anywhere in this app: a
 * preview with its own renderer starts agreeing with itself and disagreeing
 * with what lands in the inbox, which is the failure Phase 6 built the
 * template preview through this seam to avoid.
 *
 * `InvalidCampaignBlockError` is caught rather than allowed to escape, because
 * the editor renders **stored** blocks: a body written against an older
 * contract throws here, and the honest answer is to say which block and tell
 * the author to fix it — not a blank panel and not a crashed route.
 */
export function previewCampaign(
  blocks: readonly CampaignBlock[],
): CampaignPreview {
  try {
    const rendered = renderBlocks(blocks);
    return {
      ok: true,
      html: rendered.html.replaceAll(
        UNSUBSCRIBE_MARKER,
        () => PREVIEW_UNSUBSCRIBE_HTML,
      ),
      text: rendered.text.replaceAll(
        UNSUBSCRIBE_MARKER,
        () => PREVIEW_UNSUBSCRIBE_TEXT,
      ),
    };
  } catch (e) {
    if (e instanceof InvalidCampaignBlockError)
      return {
        ok: false,
        index: e.index,
        error:
          `Block ${e.index + 1} of this campaign body is no longer valid, so ` +
          `nothing was rendered. Reopen it in the editor and fix that block.`,
      };
    throw e;
  }
}
