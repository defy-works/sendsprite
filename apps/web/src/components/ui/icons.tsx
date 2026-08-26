import type { SVGProps } from "react";
import { cn } from "@/lib/cn";

/**
 * The house icon set.
 *
 * In-house rather than `lucide-react`, for the reason the brand marks are
 * generated rather than downloaded: the logo is line-art with the flap forming
 * the top edge, and a general-purpose set does not draw an envelope that way.
 * Everything here is a stroked path on a 24 grid with round caps and joins, so
 * an icon sits next to the mark without announcing where it came from.
 *
 * Size follows `font-size` (`1.15em`) rather than a prop, so an icon inside a
 * button or a nav row scales with its label and never needs a size at the call
 * site. Colour is `currentColor` for the same reason.
 */
export type IconProps = Omit<SVGProps<SVGSVGElement>, "children">;

/** Declares an icon from its path data. Pass one path or several. */
const icon = (name: string, ...d: string[]) => {
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
      {...rest}
    >
      {d.map((p, i) => (
        <path key={i} d={p} />
      ))}
    </svg>
  );
  C.displayName = `Icon${name}`;
  return C;
};

/* ---------------------------------------------------------------- *
 * Navigation
 * ---------------------------------------------------------------- */

export const IconGauge = icon("Gauge", "M4 19a9 9 0 1 1 16 0", "M12 15l4-4");
export const IconMail = icon(
  "Mail",
  "M3 8.5 12 14l9-5.5",
  "M3 8.5 12 3l9 5.5v10a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z",
);
export const IconGlobe = icon(
  "Globe",
  "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z",
  "M3.5 9h17M3.5 15h17",
  "M12 3c2.2 2.4 3.3 5.4 3.3 9S14.2 18.6 12 21c-2.2-2.4-3.3-5.4-3.3-9S9.8 5.4 12 3Z",
);
export const IconKey = icon(
  "Key",
  "M15 3a6 6 0 1 0-4.2 10.3L4 20v1h3v-2h2v-2h2l1.8-1.8A6 6 0 0 0 15 3Z",
  "M16.6 7.4h.01",
);
export const IconWebhook = icon(
  "Webhook",
  "M9 8.5a3.5 3.5 0 1 1 5.2 3.05",
  "M14.8 18.5H9.2a3.4 3.4 0 1 1 .5-6.8",
  "M12.4 11 9 17",
  "M14 11.4 17.4 17",
);
export const IconShieldOff = icon(
  "ShieldOff",
  "M12 21c4-1.6 7-5.4 7-10V5.5L12 3 5 5.5V11c0 4.6 3 8.4 7 10Z",
  "M9 11.8h6",
);
export const IconTemplate = icon(
  "Template",
  "M4 4.5h16v15H4z",
  "M4 9h16",
  "M9.5 9v10.5",
);
export const IconUsers = icon(
  "Users",
  "M3.5 20v-1.2a4.3 4.3 0 0 1 4.3-4.3h2.4a4.3 4.3 0 0 1 4.3 4.3V20",
  "M9 11.5a3.75 3.75 0 1 0 0-7.5 3.75 3.75 0 0 0 0 7.5Z",
  "M16.5 14.7a4.3 4.3 0 0 1 4 4.1V20",
  "M15.5 4.3a3.75 3.75 0 0 1 0 7.2",
);
export const IconMegaphone = icon(
  "Megaphone",
  "M4 10v4a2 2 0 0 0 2 2h2l8 4V4L8 8H6a2 2 0 0 0-2 2Z",
  "M8 16v4",
  "M19 9.5a3.5 3.5 0 0 1 0 5",
);
export const IconSettings = icon(
  "Settings",
  "M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4Z",
  "m10.6 3.4.4-1.1h2l.4 1.1a8.6 8.6 0 0 1 2.3 1l1-.6 1.4 1.4-.6 1a8.6 8.6 0 0 1 1 2.3l1.1.4v2l-1.1.4a8.6 8.6 0 0 1-1 2.3l.6 1-1.4 1.4-1-.6a8.6 8.6 0 0 1-2.3 1l-.4 1.1h-2l-.4-1.1a8.6 8.6 0 0 1-2.3-1l-1 .6-1.4-1.4.6-1a8.6 8.6 0 0 1-1-2.3l-1.1-.4v-2l1.1-.4a8.6 8.6 0 0 1 1-2.3l-.6-1L7.3 3.8l1 .6a8.6 8.6 0 0 1 2.3-1Z",
);
export const IconShield = icon(
  "Shield",
  "M12 21c4-1.6 7-5.4 7-10V5.5L12 3 5 5.5V11c0 4.6 3 8.4 7 10Z",
  "M9.2 11.8 11.3 14l3.5-3.9",
);
export const IconUser = icon(
  "User",
  "M4.5 20v-1.2a4.5 4.5 0 0 1 4.5-4.5h6a4.5 4.5 0 0 1 4.5 4.5V20",
  "M12 11.5a3.9 3.9 0 1 0 0-7.8 3.9 3.9 0 0 0 0 7.8Z",
);
export const IconBook = icon(
  "Book",
  "M4 4.8A1.8 1.8 0 0 1 5.8 3H19v18H5.8A1.8 1.8 0 0 1 4 19.2Z",
  "M4 17h15",
);
export const IconCreditCard = icon(
  "CreditCard",
  "M3 6.5h18v11H3z",
  "M3 10h18",
  "M6.5 14h3",
);
export const IconBuilding = icon(
  "Building",
  "M4 21V5.2A1.2 1.2 0 0 1 5.2 4h8.6A1.2 1.2 0 0 1 15 5.2V21",
  "M15 10h3.8A1.2 1.2 0 0 1 20 11.2V21",
  "M3 21h18",
  "M7.5 8h4M7.5 12h4M7.5 16h4",
);
export const IconCloud = icon(
  "Cloud",
  "M7 18.5a4 4 0 0 1-.4-8A6 6 0 0 1 18 10.6a4 4 0 0 1-.6 7.9Z",
);
export const IconServer = icon(
  "Server",
  "M3.5 4.5h17v6h-17z",
  "M3.5 13.5h17v6h-17z",
  "M7 7.5h.01M7 16.5h.01",
);

/* ---------------------------------------------------------------- *
 * Chevrons, arrows, motion
 * ---------------------------------------------------------------- */

export const IconChevronDown = icon("ChevronDown", "m6 9.5 6 6 6-6");
export const IconChevronUp = icon("ChevronUp", "m6 14.5 6-6 6 6");
export const IconChevronRight = icon("ChevronRight", "m9.5 6 6 6-6 6");
export const IconChevronLeft = icon("ChevronLeft", "m14.5 6-6 6 6 6");
export const IconArrowLeft = icon("ArrowLeft", "M20 12H4", "m10 6-6 6 6 6");
export const IconArrowRight = icon("ArrowRight", "M4 12h16", "m14 6 6 6-6 6");
export const IconArrowUp = icon("ArrowUp", "M12 20V4", "m6 10 6-6 6 6");
export const IconArrowDown = icon("ArrowDown", "M12 4v16", "m6 14 6 6 6-6");
export const IconExternal = icon(
  "External",
  "M14 4h6v6",
  "m20 4-8.5 8.5",
  "M18 14.5v4a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6h4",
);
export const IconRefresh = icon(
  "Refresh",
  "M20 11.5A8 8 0 0 0 6.3 6.3L4 8.5",
  "M4 4.5v4h4",
  "M4 12.5A8 8 0 0 0 17.7 17.7L20 15.5",
  "M20 19.5v-4h-4",
);

/* ---------------------------------------------------------------- *
 * Actions
 * ---------------------------------------------------------------- */

export const IconPlus = icon("Plus", "M12 5v14M5 12h14");
export const IconMinus = icon("Minus", "M5 12h14");
export const IconX = icon("X", "m6 6 12 12M18 6 6 18");
export const IconCheck = icon("Check", "m5 12.5 4.5 4.5L19 7.5");
export const IconTrash = icon(
  "Trash",
  "M4 6.5h16",
  "M9.5 6.5V4.8A.8.8 0 0 1 10.3 4h3.4a.8.8 0 0 1 .8.8v1.7",
  "M6.5 6.5 7.4 20a1 1 0 0 0 1 .9h7.2a1 1 0 0 0 1-.9l.9-13.5",
  "M10.5 10.5v6M13.5 10.5v6",
);
export const IconCopy = icon(
  "Copy",
  "M9 9.5A1.5 1.5 0 0 1 10.5 8h8A1.5 1.5 0 0 1 20 9.5v9a1.5 1.5 0 0 1-1.5 1.5h-8A1.5 1.5 0 0 1 9 18.5Z",
  "M15 5.5A1.5 1.5 0 0 0 13.5 4h-8A1.5 1.5 0 0 0 4 5.5v9A1.5 1.5 0 0 0 5.5 16",
);
export const IconPencil = icon(
  "Pencil",
  "M4 20h4L20 8a2.8 2.8 0 0 0-4-4L4 16Z",
  "m14.5 5.5 4 4",
);
export const IconSearch = icon(
  "Search",
  "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14Z",
  "m16.2 16.2 4.3 4.3",
);
export const IconSend = icon(
  "Send",
  "M21 3 10.5 13.5",
  "M21 3l-6.8 18-3.7-7.5L3 9.8Z",
);
export const IconEye = icon(
  "Eye",
  "M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z",
  "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z",
);
export const IconDownload = icon(
  "Download",
  "M12 3.5v11",
  "m7.5 10 4.5 4.5 4.5-4.5",
  "M4.5 19.5h15",
);
export const IconUpload = icon(
  "Upload",
  "M12 15.5v-11",
  "m7.5 9 4.5-4.5L16.5 9",
  "M4.5 19.5h15",
);
export const IconFilter = icon("Filter", "M3.5 5.5h17l-6.5 7.6v6l-4 2v-8Z");
export const IconGrip = icon(
  "Grip",
  "M9 6h.01M9 12h.01M9 18h.01M15 6h.01M15 12h.01M15 18h.01",
);
export const IconMore = icon("More", "M6 12h.01M12 12h.01M18 12h.01");
export const IconLogOut = icon(
  "LogOut",
  "M15 4.5h3.5A1.5 1.5 0 0 1 20 6v12a1.5 1.5 0 0 1-1.5 1.5H15",
  "M11 8.5 14.5 12 11 15.5",
  "M14 12H4",
);
export const IconLink = icon(
  "Link",
  "M10 13.5a3.5 3.5 0 0 0 5 0l3-3a3.54 3.54 0 0 0-5-5l-1.2 1.2",
  "M14 10.5a3.5 3.5 0 0 0-5 0l-3 3a3.54 3.54 0 0 0 5 5l1.2-1.2",
);

/* ---------------------------------------------------------------- *
 * Status
 * ---------------------------------------------------------------- */

export const IconAlert = icon(
  "Alert",
  "M10.6 4.2 2.9 17.5A1.6 1.6 0 0 0 4.3 20h15.4a1.6 1.6 0 0 0 1.4-2.5L13.4 4.2a1.6 1.6 0 0 0-2.8 0Z",
  "M12 9.5v4M12 16.5h.01",
);
export const IconInfo = icon(
  "Info",
  "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z",
  "M12 11v5.5M12 7.8h.01",
);
export const IconCheckCircle = icon(
  "CheckCircle",
  "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z",
  "m8.3 12.2 2.4 2.4 5-5",
);
export const IconClock = icon(
  "Clock",
  "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z",
  "M12 7v5.3l3.3 2",
);
export const IconCalendar = icon(
  "Calendar",
  "M4 6.5h16v13.5H4z",
  "M4 11h16",
  "M8.5 3.5V7M15.5 3.5V7",
);
export const IconSparkle = icon(
  "Sparkle",
  "M12 3.5 13.9 9 19.5 11 13.9 13 12 18.5 10.1 13 4.5 11 10.1 9Z",
  "M18.5 16.5 19.2 18.6 21.3 19.3 19.2 20 18.5 22.1 17.8 20 15.7 19.3 17.8 18.6Z",
);

/* ---------------------------------------------------------------- *
 * Editor blocks
 * ---------------------------------------------------------------- */

export const IconHeading = icon("Heading", "M6 5v14M18 5v14M6 12h12");
export const IconText = icon("Text", "M4 6.5h16M4 12h16M4 17.5h10");
export const IconButtonBlock = icon("ButtonBlock", "M3 8.5h18v7H3z", "M8 12h8");
export const IconImage = icon(
  "Image",
  "M4 5h16v14H4z",
  "M4 15.5 8.8 11l4 3.6 3-2.4L20 15.5",
  "M9 9.2h.01",
);
export const IconDivider = icon("Divider", "M3 12h18", "M6 7h12M6 17h12");
export const IconSpacer = icon(
  "Spacer",
  "M4 5h16M4 19h16",
  "M12 8.5v7",
  "m9.5 11 2.5-2.5 2.5 2.5",
  "m9.5 13 2.5 2.5 2.5-2.5",
);
export const IconColumns = icon("Columns", "M4 5h16v14H4z", "M12 5v14");
export const IconBold = icon(
  "Bold",
  "M7 5h6.5a3.5 3.5 0 0 1 0 7H7Z",
  "M7 12h7.5a3.5 3.5 0 0 1 0 7H7Z",
);
export const IconItalic = icon("Italic", "M15.5 5h-5M13.5 19h-5M14 5l-4 14");
export const IconMenu = icon("Menu", "M4 7h16M4 12h16M4 17h16");
export const IconAlignLeft = icon("AlignLeft", "M4 6.5h16M4 12h10M4 17.5h13");
export const IconAlignCenter = icon(
  "AlignCenter",
  "M4 6.5h16M7 12h10M5.5 17.5h13",
);
export const IconAlignRight = icon(
  "AlignRight",
  "M4 6.5h16M10 12h10M7 17.5h13",
);
