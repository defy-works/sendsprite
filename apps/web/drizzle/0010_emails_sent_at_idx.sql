CREATE INDEX "emails_sent_at_idx" ON "emails" USING btree ("team_id","sent_at");--> statement-breakpoint
CREATE INDEX "emails_sent_at_all_idx" ON "emails" USING btree ("sent_at");