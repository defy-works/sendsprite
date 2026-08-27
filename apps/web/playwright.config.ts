import { defineConfig } from "@playwright/test";

// Port 3000 is often taken on dev machines; CI sets E2E_PORT=3000.
const PORT = process.env.E2E_PORT ?? "3001";
const baseURL = process.env.E2E_BASE_URL ?? `http://localhost:${PORT}`;
// The suite runs against a built server: same app the dev server served,
// compiled before the run instead of during it (scripts/e2e-server.ts has the
// why). `E2E_SERVER=dev` swaps `next dev` back in for local iteration: no
// build to wait for, at the price of a route compiling on its first request —
// budget accordingly if a wait fails there and nowhere else. CI never sets it.
const devServer = process.env.E2E_SERVER === "dev";

export default defineConfig({
  testDir: "tests/e2e",
  // Every route is already compiled, so an assertion that has not passed in
  // ten seconds is a bug, not a slow first paint. Anything that legitimately
  // waits longer waits on a background job (domain provisioning, a send), and
  // those spell their own budget out in the spec.
  expect: { timeout: 10_000 },
  // The longest spec walks the wizard, verifies a domain and sends over both
  // REST and SMTP, waiting on the worker throughout: ~15 s here, so 60 s
  // leaves room for a slower runner and still reports a hang promptly.
  timeout: 60_000,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL,
    trace: "retain-on-failure",
  },
  // On an empty database (CI) the dashboard is closed until an owner finishes
  // the wizard; setup.spec.ts does that, so it runs first and alone, and the
  // other specs (which expect an open dashboard) depend on it. Both projects
  // share the one `webServer` below, so the build happens once per run.
  projects: [
    { name: "setup", testMatch: /setup\.spec\.ts/ },
    { name: "app", testIgnore: /setup\.spec\.ts/, dependencies: ["setup"] },
  ],
  // With E2E_BASE_URL set we target an already-running server (e.g. the
  // Docker image); otherwise the server is built and started on PORT.
  // DATABASE_URL and APP_SECRET come from .env.local locally (Next loads it,
  // in either server mode) and from the job env in CI; APP_URL is overridden
  // so it matches the port in use.
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: devServer
          ? `bun run dev -- -p ${PORT}`
          : `bun run scripts/e2e-server.ts ${PORT}`,
        url: `${baseURL}/api/health`,
        // Never attach to a stray dev server: it may run with a different
        // env (no AWS mock, another database) and make the run meaningless.
        reuseExistingServer: false,
        // The build is inside this budget on the built-server path: a cold
        // `next build` on a CI runner, then boot (migrations, worker, relay).
        timeout: devServer ? 120_000 : 300_000,
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
          // Billing against the in-memory provider: the e2e proves the page,
          // the flag and the entitlement wiring without a Polar account.
          BILLING_ENABLED: "1",
          BILLING_PROVIDER: "fake",
          // Fake SES reports DKIM/MAIL FROM as SUCCESS so send.spec.ts can
          // verify a domain with one Re-verify click.
          AWS_E2E_VERIFY: "1",
          // SMTP relay on a non-privileged port; the spec authenticates over
          // a plain connection (self-signed cert, no client verification).
          SMTP_ENABLED: "true",
          SMTP_PORT: "2587",
          SMTP_ALLOW_INSECURE_AUTH: "true",
        },
      },
});
