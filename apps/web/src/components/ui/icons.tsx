import type { SVGProps } from "react";
import { cn } from "@/lib/cn";
import { ICON_BODIES, type IconName } from "./icon-data";

/**
 * The icon set: Lucide, vendored out of Iconify at build time.
 *
 * These used to be drawn by hand — a stroked path per icon, written here. The
 * argument for that was the brand mark, which is line-art an off-the-shelf set
 * does not draw. It did not survive contact with sixty-three of them: an
 * envelope and a chevron are fine to draw, a gauge, a webhook and a
 * mouse-pointer-in-a-square are where a hand-drawn set starts looking like a
 * hand-drawn set, and several were plainly wrong on screen. Lucide is drawn on
 * the same 24 grid with the same round caps and joins, so the geometry lands
 * where the old set was aiming.
 *
 * The artwork is committed (`icon-data.ts`, from `bun run icons`), never
 * fetched. `@iconify/react` resolves names against the Iconify API at runtime,
 * which for a self-hosted instance means a network request and a CSP entry
 * standing between it and its own chrome. `@iconify-json/lucide` is a
 * devDependency: a build input, not a shipped one.
 *
 * Two house rules are kept from the old set, because both are about the call
 * site rather than the drawing:
 *
 * - **Size follows `font-size`** (`1.15em`), not a prop, so an icon in a
 *   button or a nav row scales with its label and needs nothing at the call
 *   site.
 * - **Colour is `currentColor`**, for the same reason.
 *
 * Lucide's `stroke-width="2"` is dropped when the data is generated and the
 * house 1.6 applied here: 2 reads heavy next to hairlines and thin type.
 */
export type IconProps = Omit<SVGProps<SVGSVGElement>, "children">;

/**
 * Wraps one vendored icon body in the house `<svg>`.
 *
 * `dangerouslySetInnerHTML` is the only way to mount markup that is a string,
 * and this one is: generated at build time from a package in the lockfile,
 * committed, and never touched by anything at runtime. No value from a
 * request, a database or a user reaches it.
 */
const icon = (name: IconName) => {
  const C = ({ className, ...rest }: IconProps) => (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      focusable="false"
      className={cn("inline-block h-[1.15em] w-[1.15em] shrink-0", className)}
      dangerouslySetInnerHTML={{ __html: ICON_BODIES[name] }}
      {...rest}
    />
  );
  C.displayName = `Icon${name}`;
  return C;
};

/* ---------------------------------------------------------------- *
 * Navigation
 * ---------------------------------------------------------------- */

export const IconGauge = icon("Gauge");
export const IconMail = icon("Mail");
export const IconGlobe = icon("Globe");
export const IconKey = icon("Key");
export const IconWebhook = icon("Webhook");
export const IconShieldOff = icon("ShieldOff");
export const IconTemplate = icon("Template");
export const IconUsers = icon("Users");
export const IconMegaphone = icon("Megaphone");
export const IconSettings = icon("Settings");
export const IconShield = icon("Shield");
export const IconUser = icon("User");
export const IconBook = icon("Book");
export const IconCreditCard = icon("CreditCard");
export const IconBuilding = icon("Building");
export const IconCloud = icon("Cloud");
export const IconServer = icon("Server");

/* ---------------------------------------------------------------- *
 * Direction and movement
 * ---------------------------------------------------------------- */

export const IconChevronDown = icon("ChevronDown");
export const IconChevronUp = icon("ChevronUp");
export const IconChevronRight = icon("ChevronRight");
export const IconChevronLeft = icon("ChevronLeft");
export const IconArrowLeft = icon("ArrowLeft");
export const IconArrowRight = icon("ArrowRight");
export const IconArrowUp = icon("ArrowUp");
export const IconArrowDown = icon("ArrowDown");
export const IconExternal = icon("External");
export const IconRefresh = icon("Refresh");

/* ---------------------------------------------------------------- *
 * Actions
 * ---------------------------------------------------------------- */

export const IconPlus = icon("Plus");
export const IconMinus = icon("Minus");
export const IconX = icon("X");
export const IconCheck = icon("Check");
export const IconTrash = icon("Trash");
export const IconCopy = icon("Copy");
export const IconPencil = icon("Pencil");
export const IconSearch = icon("Search");
export const IconSend = icon("Send");
export const IconEye = icon("Eye");
export const IconDownload = icon("Download");
export const IconUpload = icon("Upload");
export const IconFilter = icon("Filter");
export const IconGrip = icon("Grip");
export const IconMore = icon("More");
export const IconLogOut = icon("LogOut");
export const IconLink = icon("Link");

/* ---------------------------------------------------------------- *
 * Status
 * ---------------------------------------------------------------- */

export const IconAlert = icon("Alert");
export const IconInfo = icon("Info");
export const IconCheckCircle = icon("CheckCircle");
export const IconClock = icon("Clock");
export const IconCalendar = icon("Calendar");
export const IconSparkle = icon("Sparkle");

/* ---------------------------------------------------------------- *
 * The editor's blocks and its toolbar
 * ---------------------------------------------------------------- */

export const IconHeading = icon("Heading");
export const IconText = icon("Text");
export const IconButtonBlock = icon("ButtonBlock");
export const IconImage = icon("Image");
export const IconDivider = icon("Divider");
export const IconSpacer = icon("Spacer");
export const IconColumns = icon("Columns");
export const IconBold = icon("Bold");
export const IconItalic = icon("Italic");
export const IconMenu = icon("Menu");
export const IconAlignLeft = icon("AlignLeft");
export const IconAlignCenter = icon("AlignCenter");
export const IconAlignRight = icon("AlignRight");
