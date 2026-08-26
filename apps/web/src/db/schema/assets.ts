import {
  customType,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { organization } from "./auth";

/**
 * `bytea`, as a `Buffer`.
 *
 * Declared here rather than imported because `email_attachments` stores its
 * bytes the same way and drizzle has no first-class `bytea` column; keeping
 * the two definitions identical is what stops one of them drifting into
 * base64-in-a-text-column.
 */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

/**
 * An image an author uploaded, stored in Postgres and served from a public
 * URL.
 *
 * ## Why the bytes live in the database
 *
 * A mail client fetches an image with no cookie, no header and no retry, from
 * whatever network the reader happens to be on — so the URL in a campaign has
 * to be public, absolute and stable for as long as the mail exists, which is
 * for ever. That rules out anything session-scoped.
 *
 * The three real options were S3 in the tenant's own account, the local
 * filesystem, and here. S3 would mean widening the CloudFormation template's
 * IAM user from "send mail" to "create and write a public bucket", which is a
 * much bigger permission to ask a customer for than this feature is worth, and
 * it would leave self-hosters without an AWS connection unable to use images
 * at all. The filesystem breaks the moment a deployment runs two containers,
 * which the Docker Compose file already does. The database is the one place
 * every deployment already has, already backs up, and already scopes per team.
 *
 * The cost is honest and bounded: `MAX_ASSET_BYTES` per image, and images are
 * the only thing accepted.
 *
 * ## Why a token and not the id
 *
 * The serving route is unauthenticated — it has to be. A ULID is time-ordered,
 * so `ast_` ids created in the same millisecond differ only in their random
 * tail and neighbouring uploads are trivially enumerable from one known id.
 * `token` is 32 bytes from `randomBytes`, and it is the only thing in the URL.
 */
export const teamAssets = pgTable(
  "team_assets",
  {
    id: text("id").primaryKey(), // ast_<ulid>
    teamId: text("team_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    /** The unguessable path segment. Unique instance-wide, not per team. */
    token: text("token").notNull(),
    /** As uploaded, for the picker. Never used to build a path. */
    filename: text("filename").notNull(),
    /** Decided from the magic bytes, never from what the client claimed. */
    contentType: text("content_type").notNull(),
    bytes: bytea("bytes").notNull(),
    size: integer("size").notNull(),
    /**
     * sha256 of the bytes. Re-uploading the same file returns the existing
     * row rather than storing a second copy — the common case is an author
     * dragging the same logo into three campaigns.
     */
    sha256: text("sha256").notNull(),
    /** Intrinsic pixel size when it could be read; null for a format we do not parse. */
    width: integer("width"),
    height: integer("height"),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true, precision: 3 })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("team_assets_token_uidx").on(t.token),
    // Dedupe is per team: two tenants uploading the same stock photo get their
    // own row each, because deleting one must not break the other's mail.
    uniqueIndex("team_assets_team_sha_uidx").on(t.teamId, t.sha256),
    index("team_assets_team_created_idx").on(t.teamId, t.createdAt),
  ],
);
export type TeamAsset = typeof teamAssets.$inferSelect;
