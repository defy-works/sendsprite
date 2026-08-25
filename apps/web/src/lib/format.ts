/**
 * Server-side, fixed locale and zone: a locale-dependent format in a client
 * component would hydrate differently from the SSR markup.
 */
export const formatWhen = (d: Date | null) =>
  d
    ? new Intl.DateTimeFormat("en-US", {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        timeZone: "UTC",
      }).format(d) + " UTC"
    : "never";
