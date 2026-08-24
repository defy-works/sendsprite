import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resetEnvCache } from "@/env.schema";
import { startPg } from "./_pg";

let pg: Awaited<ReturnType<typeof startPg>>;
beforeAll(async () => {
  pg = await startPg();
  process.env.APP_URL = "http://localhost:3000";
  process.env.APP_SECRET = "x".repeat(40);
  process.env.EMAIL_PASSWORD_ENABLED = "true";
  process.env.SIGNUP_MODE = "auto";
  resetEnvCache();
});
afterAll(async () => {
  await pg.stop();
});

async function signUp(email: string) {
  const { auth } = await import("@/lib/auth");
  return auth.api.signUpEmail({
    body: {
      email,
      password: "correct-horse-battery",
      name: email.split("@")[0]!,
    },
  });
}

describe("signup policy (auto)", () => {
  it("first user may sign up", async () => {
    await expect(signUp("first@example.com")).resolves.toMatchObject({
      user: { email: "first@example.com" },
    });
  });
  it("second user is rejected as invite-only", async () => {
    await expect(signUp("second@example.com")).rejects.toThrow(/invite-only/i);
  });
});
