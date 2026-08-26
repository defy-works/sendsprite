CREATE TABLE "campaign_recipients" (
	"campaign_id" text NOT NULL,
	"contact_id" text NOT NULL,
	"email_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"skip_reason" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "campaign_recipients_campaign_id_contact_id_pk" PRIMARY KEY("campaign_id","contact_id")
);
--> statement-breakpoint
CREATE TABLE "campaigns" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"book_id" text NOT NULL,
	"domain_id" text NOT NULL,
	"name" text NOT NULL,
	"subject" text NOT NULL,
	"from" text NOT NULL,
	"reply_to" text,
	"blocks" jsonb NOT NULL,
	"html" text,
	"text" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"scheduled_at" timestamp (3) with time zone,
	"started_at" timestamp (3) with time zone,
	"sent_at" timestamp (3) with time zone,
	"fanout_cursor" text,
	"counts" jsonb DEFAULT '{"recipients":0,"sent":0,"delivered":0,"opened":0,"clicked":0,"unsubscribed":0,"bounced":0,"complained":0,"failed":0}'::jsonb NOT NULL,
	"created_by" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "emails" ADD COLUMN "campaign_id" text;--> statement-breakpoint
ALTER TABLE "emails" ADD COLUMN "contact_id" text;--> statement-breakpoint
ALTER TABLE "campaign_recipients" ADD CONSTRAINT "campaign_recipients_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_recipients" ADD CONSTRAINT "campaign_recipients_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_recipients" ADD CONSTRAINT "campaign_recipients_email_id_emails_id_fk" FOREIGN KEY ("email_id") REFERENCES "public"."emails"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_team_id_organization_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "campaign_recipients_email_idx" ON "campaign_recipients" USING btree ("email_id");--> statement-breakpoint
CREATE INDEX "campaigns_team_created_idx" ON "campaigns" USING btree ("team_id","created_at","id");--> statement-breakpoint
CREATE INDEX "campaigns_status_idx" ON "campaigns" USING btree ("status","scheduled_at");--> statement-breakpoint
CREATE INDEX "emails_campaign_idx" ON "emails" USING btree ("campaign_id","id");