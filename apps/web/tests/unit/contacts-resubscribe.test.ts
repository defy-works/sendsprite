import { describe, expect, it } from "vitest";
import { resubscribeConfirmation } from "@/app/app/contacts/resubscribe";

const prompt = (reason: string | null) =>
  resubscribeConfirmation({
    email: "ada@example.com",
    reason,
    unsubscribedWhen: "Aug 26, 10:40 AM UTC",
  });

/**
 * The wording *is* the deliverable here: the service will happily resubscribe
 * anyone, so what stops a wrong click is whether the operator was told who
 * unsubscribed this person and when.
 */
describe("resubscribeConfirmation", () => {
  it("names the address and the date in every case", () => {
    for (const reason of [null, "manual", "api", "import", "clicked a link"]) {
      const text = prompt(reason);
      expect(text).toContain("ada@example.com");
      expect(text).toContain("Aug 26, 10:40 AM UTC");
    }
  });

  it("says an api unsubscribe is most likely the person's own request", () => {
    const text = prompt("api");
    expect(text).toContain('"api"');
    expect(text).toContain("unsubscribe link");
    expect(text).toMatch(/own request/);
  });

  it("distinguishes an operator's unsubscribe from the contact's", () => {
    expect(prompt("manual")).toContain("somebody on this team");
    expect(prompt("import")).toContain("already unsubscribed in a CSV");
  });

  it("quotes a reason it does not recognise rather than paraphrasing it", () => {
    expect(prompt("replied STOP to sms")).toContain('"replied STOP to sms"');
  });

  it("does not invent a reason when none was recorded", () => {
    const text = prompt(null);
    expect(text).toContain("No reason was recorded");
    expect(text).not.toContain('"null"');
  });

  it("says what resubscribing does, and asks for it to be justified", () => {
    const text = prompt("api");
    expect(text).toContain("Only do this if they asked to come back");
    expect(text).toContain("Campaigns to this book will include them again");
  });
});
