import { defineConfig } from "@playwright/test";

// Port 3000 is often taken on dev machines; CI sets E2E_PORT=3000.
const PORT = process.env.E2E_PORT ?? "3001";
const baseURL = process.env.E2E_BASE_URL ?? `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 60_000,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL,
    trace: "retain-on-failure",
  },
  // On an empty database (CI) the dashboard is closed until an owner finishes
  // the wizard; setup.spec.ts does that, so it runs first and alone, and the
  // other specs (which expect an open dashboard) depend on it.
  projects: [
    { name: "setup", testMatch: /setup\.spec\.ts/ },
    { name: "app", testIgnore: /setup\.spec\.ts/, dependencies: ["setup"] },
  ],
  // With E2E_BASE_URL set we target an already-running server (e.g. the
  // Docker image); otherwise `next dev` is started on PORT. DATABASE_URL and
  // APP_SECRET come from .env.local locally (Next loads it) and from the job
  // env in CI; APP_URL is overridden so it matches the port in use.
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: `bun run dev -- -p ${PORT}`,
        url: `${baseURL}/api/health`,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...(process.env.DATABASE_URL && {
            DATABASE_URL: process.env.DATABASE_URL,
          }),
          ...(process.env.APP_SECRET && { APP_SECRET: process.env.APP_SECRET }),
          APP_URL: `http://localhost:${PORT}`,
          EMAIL_PASSWORD_ENABLED: "true",
          SIGNUP_MODE: "open",
          // Domain provisioning runs as a job, so the in-process worker is on.
          WORKER_MODE: "inline",
          // Canned SES/SNS/STS responses (src/lib/aws/fake-client.ts); set
          // here unconditionally so CI needs no extra variable.
          AWS_E2E_MOCK: "1",
        },
      },
});
