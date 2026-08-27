import type { DnsRecordKind, ExpectedRecord } from "@/db/schema/domains";
import { CopyField } from "@/components/ui/CopyField";

const KIND: Record<DnsRecordKind, string> = {
  DKIM: "DKIM",
  MAIL_FROM_MX: "MAIL FROM (MX)",
  MAIL_FROM_SPF: "MAIL FROM (SPF)",
  DMARC: "DMARC",
};

export function RecordsTable({ records }: { records: ExpectedRecord[] }) {
  if (records.length === 0)
    return (
      <p className="text-sm text-white/65">
        Records appear once SES has issued the DKIM tokens (usually within a
        minute).
      </p>
    );
  return (
    <div className="glass overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="num-stamp text-left">
          <tr>
            <th className="px-4 py-3 font-medium">Record</th>
            <th className="px-4 py-3 font-medium">Type</th>
            <th className="px-4 py-3 font-medium">Name</th>
            <th className="px-4 py-3 font-medium">Value</th>
            <th className="px-4 py-3 font-medium">Priority</th>
            <th className="px-4 py-3 font-medium">OK</th>
          </tr>
        </thead>
        <tbody>
          {records.map((r) => (
            <tr
              key={`${r.type}-${r.name}-${r.value}`}
              className="border-t border-white/8 align-top"
            >
              <td className="px-4 py-3 whitespace-nowrap">{KIND[r.kind]}</td>
              <td className="px-4 py-3 font-mono text-xs">{r.type}</td>
              <td className="px-4 py-3">
                <CopyField value={r.name} />
              </td>
              <td className="px-4 py-3">
                <CopyField value={r.value} />
              </td>
              <td className="px-4 py-3 text-white/65">{r.priority ?? "—"}</td>
              <td
                className={`px-4 py-3 ${r.ok ? "text-green-300" : "text-white/40"}`}
              >
                <span aria-hidden>{r.ok ? "✓" : "✗"}</span>
                <span className="sr-only">{r.ok ? "found" : "not found"}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
