import { z } from "zod";

/** RFC 1123 hostname, at least two labels (lowercase; input is lowercased first). */
const HOSTNAME_RE =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** `auto` = records are managed in a connected Cloudflare zone. */
export const DNS_MODES = ["auto", "manual"] as const;
export type DnsMode = (typeof DNS_MODES)[number];
export const DOMAIN_STATUS = ["pending", "verified", "failed"] as const;
export type DomainStatus = (typeof DOMAIN_STATUS)[number];
export const DNS_RECORD_KINDS = [
  "DKIM",
  "MAIL_FROM_MX",
  "MAIL_FROM_SPF",
  "DMARC",
] as const;
export type DnsRecordKind = (typeof DNS_RECORD_KINDS)[number];

/**
 * `POST /domains`. The DNS mode is not an input: the server picks `auto`
 * when a connected Cloudflare zone covers the name, `manual` otherwise.
 * Must stay `z.toJSONSchema`-representable (no `.transform`; `.overwrite`
 * keeps the string type).
 */
export const CreateDomainInput = z.object({
  name: z
    .string()
    .trim()
    .toLowerCase()
    .overwrite((s) => s.replace(/\.$/, ""))
    .regex(HOSTNAME_RE, "Enter a valid domain like mail.example.com."),
});
export type CreateDomainInput = z.infer<typeof CreateDomainInput>;

export const DnsRecordObject = z.object({
  kind: z.enum(DNS_RECORD_KINDS),
  type: z.enum(["CNAME", "MX", "TXT"]),
  name: z.string(),
  value: z.string(),
  priority: z.number().int().nullable(),
  ok: z.boolean(),
});
export type DnsRecordObject = z.infer<typeof DnsRecordObject>;

export const DomainObject = z.object({
  id: z.string(),
  name: z.string(),
  status: z.enum(DOMAIN_STATUS),
  dnsMode: z.enum(DNS_MODES),
  region: z.string(),
  records: z.array(DnsRecordObject),
  lastError: z.string().nullable(),
  createdAt: z.iso.datetime(),
  verifiedAt: z.iso.datetime().nullable(),
});
export type DomainObject = z.infer<typeof DomainObject>;
