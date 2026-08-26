export interface ParsedAddress {
  name: string | null;
  email: string; // normalised (trimmed, lower-cased)
  raw: string;
}

const ADDR = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;

export const normaliseEmail = (s: string) => s.trim().toLowerCase();

export const domainOf = (email: string) =>
  normaliseEmail(email).split("@")[1] ?? "";

/** RFC 5322-lite: `Name <a@b>`, `"Quoted, Name" <a@b>`, `<a@b>`, or `a@b`. */
export function parseAddress(raw: string): ParsedAddress | null {
  const s = raw.trim();
  const m = /^(?:"((?:[^"\\]|\\.)*)"|([^<]*?))\s*<([^<>]+)>$/.exec(s);
  if (m) {
    const email = normaliseEmail(m[3]!);
    if (!ADDR.test(email)) return null;
    const name = (m[1] ?? m[2] ?? "").replace(/\\(.)/g, "$1").trim();
    return { name: name || null, email, raw: s };
  }
  const email = normaliseEmail(s);
  return ADDR.test(email) ? { name: null, email, raw: s } : null;
}

export const formatAddress = (a: Pick<ParsedAddress, "name" | "email">) =>
  a.name ? `"${a.name.replace(/[\\"]/g, "\\$&")}" <${a.email}>` : a.email;
