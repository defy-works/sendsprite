CREATE TABLE "billing_events" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text,
	"type" text NOT NULL,
	"object_id" text,
	"applied_at" timestamp with time zone,
	"skipped_reason" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "billing_usage" (
	"team_id" text NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"reported_through" timestamp with time zone,
	"reported_units" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_usage_team_id_period_start_pk" PRIMARY KEY("team_id","period_start")
);
--> statement-breakpoint
CREATE TABLE "team_billing" (
	"team_id" text PRIMARY KEY NOT NULL,
	"provider" text DEFAULT 'polar' NOT NULL,
	"provider_customer_id" text,
	"subscription_id" text,
	"product_id" text,
	"plan" text DEFAULT 'free' NOT NULL,
	"status" text,
	"included_emails" integer NOT NULL,
	"overage_per_1k_cents" integer DEFAULT 0 NOT NULL,
	"overage_enabled" boolean DEFAULT false NOT NULL,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"provider_modified_at" timestamp with time zone NOT NULL,
	"past_due_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "billing_usage" ADD CONSTRAINT "billing_usage_team_id_organization_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_billing" ADD CONSTRAINT "team_billing_team_id_organization_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "billing_events_team_created_idx" ON "billing_events" USING btree ("team_id","created_at");