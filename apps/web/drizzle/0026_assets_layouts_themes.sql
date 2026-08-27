CREATE TABLE "team_assets" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"token" text NOT NULL,
	"filename" text NOT NULL,
	"content_type" text NOT NULL,
	"bytes" "bytea" NOT NULL,
	"size" integer NOT NULL,
	"sha256" text NOT NULL,
	"width" integer,
	"height" integer,
	"created_by" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "team_layouts" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"name" text NOT NULL,
	"blocks" jsonb NOT NULL,
	"theme" jsonb,
	"created_by" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "templates" ADD COLUMN "theme" jsonb;--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "theme" jsonb;--> statement-breakpoint
ALTER TABLE "team_assets" ADD CONSTRAINT "team_assets_team_id_organization_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_layouts" ADD CONSTRAINT "team_layouts_team_id_organization_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "team_assets_token_uidx" ON "team_assets" USING btree ("token");--> statement-breakpoint
CREATE UNIQUE INDEX "team_assets_team_sha_uidx" ON "team_assets" USING btree ("team_id","sha256");--> statement-breakpoint
CREATE INDEX "team_assets_team_created_idx" ON "team_assets" USING btree ("team_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "team_layouts_team_name_uidx" ON "team_layouts" USING btree ("team_id","name");--> statement-breakpoint
CREATE INDEX "team_layouts_team_created_idx" ON "team_layouts" USING btree ("team_id","created_at");