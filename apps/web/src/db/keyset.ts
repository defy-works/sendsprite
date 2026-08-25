import { and, desc, sql, type ColumnBaseConfig, type SQL } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import type { PageQuery } from "@sendsprite/shared";
import { db } from "@/db";
import { decodeCursor, encodeCursor } from "@/lib/cursor";
import type { Result } from "@/lib/result";

export interface Page<T> {
  data: T[];
  /** Opaque; pass back as `cursor` for the next page. Null on the last page. */
  nextCursor: string | null;
}

/** `id` text, `created_at` a date-mode timestamptz(3) (ms, like the cursor). */
type KeysetTable = PgTable & {
  id: PgColumn<ColumnBaseConfig<"string", string>>;
  createdAt: PgColumn<ColumnBaseConfig<"date", string>>;
};

/**
 * One page of `table` ordered `(created_at desc, id desc)`, keyset-paged on
 * the cursor from `@/lib/cursor`. Fetches `limit + 1` to know whether a next
 * page exists. A malformed cursor is a code-less failure (400 at the edge).
 */
export async function keysetPage<T extends KeysetTable>(
  table: T,
  q: PageQuery,
  where?: SQL,
): Promise<Result<Page<T["$inferSelect"]>>> {
  const cur = q.cursor ? decodeCursor(q.cursor) : null;
  if (q.cursor && !cur) return { ok: false, error: "Invalid cursor." };
  const rows = (await db()
    .select()
    .from(table as KeysetTable)
    .where(
      and(
        where,
        cur
          ? sql`(${table.createdAt}, ${table.id}) < (${cur.createdAt.toISOString()}::timestamptz, ${cur.id})`
          : undefined,
      ),
    )
    .orderBy(desc(table.createdAt), desc(table.id))
    .limit(q.limit + 1)) as T["$inferSelect"][];
  const data = rows.slice(0, q.limit);
  const last = data.at(-1) as { createdAt: Date; id: string } | undefined;
  return {
    ok: true,
    data: {
      data,
      nextCursor: rows.length > q.limit && last ? encodeCursor(last) : null,
    },
  };
}
