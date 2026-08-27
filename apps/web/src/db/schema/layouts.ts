import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type { CampaignBlock, CampaignTheme } from "@sendsprite/shared";
import { organization } from "./auth";

/**
 * A saved arrangement of blocks a team can drop into any body.
 *
 * Not a template. A template is a *sendable* thing with a slug, a subject, a
 * variables schema and a version history, and it is addressed by name from
 * `POST /emails`. A layout is a fragment with none of that: a header, a
 * three-up feature row, a footer with the company address in it. Conflating
 * them would mean every reusable footer occupying a slug in the namespace the
 * API sends from.
 *
 * `blocks` is validated against the contract on write, so a layout can only
 * ever insert blocks a body could already hold — inserting one is exactly the
 * same operation as adding blocks by hand, and produces nothing the editor
 * could not have produced.
 *
 * `theme` is optional and separate: a layout that carries one offers it when
 * inserted, because a footer designed on a dark card looks wrong on a white
 * one, and the author should get to say whether the whole body follows.
 */
export const teamLayouts = pgTable(
  "team_layouts",
  {
    id: text("id").primaryKey(), // lay_<ulid>
    teamId: text("team_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    blocks: jsonb("blocks").$type<CampaignBlock[]>().notNull(),
    theme: jsonb("theme").$type<CampaignTheme>(),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true, precision: 3 })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // One name per team: the picker lists them by name, and two "Footer"s are
    // a coin flip rather than a choice.
    uniqueIndex("team_layouts_team_name_uidx").on(t.teamId, t.name),
    index("team_layouts_team_created_idx").on(t.teamId, t.createdAt),
  ],
);
export type TeamLayout = typeof teamLayouts.$inferSelect;
