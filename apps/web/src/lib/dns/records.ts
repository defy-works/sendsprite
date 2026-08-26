import type { ExpectedRecord } from "@/db/schema/domains";

export interface RecordInput {
  domain: string;
  region: string;
  dkimTokens: string[];
  mailFromDomain: string;
  dmarcPolicy?: "none" | "quarantine" | "reject";
  /** Aggregate-report address; omitted (default) → no `rua=` tag. */
  dmarcRua?: string | null;
}

/** The DNS every SES domain needs. Pure; order is stable for display. */
export function expectedRecords(i: RecordInput): ExpectedRecord[] {
  const dkim: ExpectedRecord[] = i.dkimTokens.map((t) => ({
    kind: "DKIM",
    type: "CNAME",
    name: `${t}._domainkey.${i.domain}`,
    value: `${t}.dkim.amazonses.com`,
    ok: false,
  }));
  return [
    ...dkim,
    {
      kind: "MAIL_FROM_MX",
      type: "MX",
      name: i.mailFromDomain,
      value: `feedback-smtp.${i.region}.amazonses.com`,
      priority: 10,
      ok: false,
    },
    {
      kind: "MAIL_FROM_SPF",
      type: "TXT",
      name: i.mailFromDomain,
      value: "v=spf1 include:amazonses.com ~all",
      ok: false,
    },
    {
      kind: "DMARC",
      type: "TXT",
      name: `_dmarc.${i.domain}`,
      value:
        `v=DMARC1; p=${i.dmarcPolicy ?? "none"}` +
        (i.dmarcRua ? `; rua=mailto:${i.dmarcRua}` : ""),
      ok: false,
    },
  ];
}
