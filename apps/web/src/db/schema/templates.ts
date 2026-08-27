import {
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type {
  CampaignBlock,
  CampaignTheme,
  TemplateVariablesSchema,
} from "@sendsprite/shared";
import { organization } from "./auth";

/** The current state of a template. Its history is `template_versions`. */
export const templates = pgTable(
  "templates",
  {
    id: text("id").primaryKey(), // tpl_<ulid>
    teamId: text("team_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    /** URL key and the name `POST /emails` uses in `template`. Unique per team. */
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    subject: text("subject").notNull(),
    bodyHtml: text("body_html").notNull(),
    bodyText: text("body_text"),
    /**
     * The block tree the visual editor authored, when it was used.
     *
     * `body_html` stays the source of truth for *sending* — the public API
     * accepts and returns HTML, the SDK types say HTML, and a template written
     * by an API client has no design and never will. This is the editor's
     * source, kept so that reopening a template built in the designer shows
     * the blocks rather than the HTML they compiled to.
     *
     * Null means "authored as HTML". Editing the HTML by hand clears it,
     * because a design that no longer produces the stored HTML is worse than
     * no design: it would silently overwrite the hand edit on the next save.
     */
    design: jsonb("design").$type<CampaignBlock[]>(),
    /**
     * The body theme the design was drawn with. Its own column rather than a
     * field inside `design`, so it is symmetric with `campaigns.theme` and so
     * a template written as HTML can still carry one later without the design
     * column having to hold a shape that is half-used.
     */
    theme: jsonb("theme").$type<CampaignTheme>(),
    variablesSchema: jsonb("variables_schema")
      .$type<TemplateVariablesSchema>()
      .notNull()
      .default({ variables: [] }),
    /** Bumped on every content change; matches the newest `template_versions` row. */
    version: integer("version").notNull().default(1),
    updatedBy: text("updated_by"),
    // Millisecond precision: the list cursor round-trips `createdAt` through
    // a JS Date (ms); see schema/emails.ts.
    createdAt: timestamp("created_at", { withTimezone: true, precision: 3 })
      .notNull()
      .defaultNow(),
    // `$onUpdate` fires only via drizzle `.update()`; upserts must set it.
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [uniqueIndex("templates_team_slug_uidx").on(t.teamId, t.slug)],
);
export type Template = typeof templates.$inferSelect;

export interface TemplateSnapshot {
  name: string;
  subject: string;
  bodyHtml: string;
  bodyText: string | null;
  variablesSchema: TemplateVariablesSchema;
  /**
   * Optional so every snapshot written before the designer existed still
   * parses as one. `null` is "authored as HTML"; absent means the same thing
   * and is what an older row looks like.
   */
  design?: CampaignBlock[] | null;
  /** The body theme, when the snapshot has one. Same optionality as `design`. */
  theme?: CampaignTheme | null;
}

/**
 * One row per version, holding the template **as it became** at that version —
 * so the newest row always equals the `templates` row and the history is
 * complete on its own. Restoring a version is an ordinary update carrying an
 * old snapshot's fields, which then writes a new version of its own: history
 * is append-only and a restore is visible as one.
 *
 * No surrogate id: `(template_id, version)` is the identity, the way
 * `billing_usage` is keyed on `(team_id, period_start)`.
 */
export const templateVersions = pgTable(
  "template_versions",
  {
    templateId: text("template_id")
      .notNull()
      .references(() => templates.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    snapshot: jsonb("snapshot").$type<TemplateSnapshot>().notNull(),
    createdBy: text("created_by"),
    // Millisecond precision: the history list is ordered on this column and
    // compared against values that have been through a JS Date.
    createdAt: timestamp("created_at", { withTimezone: true, precision: 3 })
      .notNull()
      .defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.templateId, t.version] })],
);
export type TemplateVersion = typeof templateVersions.$inferSelect;
