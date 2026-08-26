/**
 * The server the Playwright suite runs against: `next build`, then the build
 * served by `next start`. Started by `webServer` in playwright.config.ts,
 * once per run — never per worker.
 *
 * Why not `next dev`, which this replaced: a dev server compiles a route on
 * its first request — milliseconds on a warm machine, tens of seconds on a
 * cold CI runner (`/docs/api` has taken 19 s there). Every flaky wait this
 * suite has had traced back to that: assertions timing out on a first
 * navigation, an SSE stream still compiling while the events it was meant to
 * carry were emitted. Building first removes the whole class — nothing
 * compiles during the run.
 *
 * Why NODE_ENV=development rather than production, which is the one part of
 * this that is not free. The suite needs seams the app refuses in production:
 * the canned SES/SNS/STS client (`AWS_E2E_MOCK`, armed by
 * `process.env.NODE_ENV !== "production"` in lib/aws/clients.ts) and
 * `BILLING_PROVIDER=fake` (rejected outright by env.schema.ts). The first is
 * decisive: `next build` *replaces* `process.env.NODE_ENV` in the bundles
 * with a literal, so in a production build that guard is not a check that
 * could be satisfied at runtime — it is folded to `false` before the server
 * ever starts. That is what its comment promises ("the fake can never
 * activate in a production build, whatever the environment says"), so the way
 * through is not to relax it but to build the app the way the dev server
 * already ran it: `experimental.allowDevelopmentBuild` (see next.config.ts)
 * makes that literal `development`, and Next refuses the option unless
 * NODE_ENV is explicitly `development`, so a production build cannot pick it
 * up by accident.
 *
 * So the run is the same app the dev server served, with the same seams and
 * the same development-mode React — compiled ahead of time instead of on
 * demand. It is not a production build, and it does not pretend to be: the
 * production bundle is exercised by the image build and its smoke test in CI.
 *
 * Why not the standalone server, which is what the Docker image runs:
 * `.next/standalone/apps/web/server.js` sets `process.env.NODE_ENV =
 * "production"` unconditionally, so it cannot serve a run that needs the fake
 * providers. next.config.ts leaves that output out of a development build
 * altogether — nothing would run it, and `next start` warns when it finds one.
 */
import { spawn, type ChildProcess } from "node:child_process";

const port = process.argv[2] ?? process.env.PORT ?? "3000";
// This script runs under bun; spawning `"bun"` by name would need a shell to
// find it on Windows.
const bun = process.execPath;

let current: ChildProcess | undefined;
// Playwright kills this process (and its tree) when the run ends; forward a
// signal we receive first so `next start` shuts its worker and SMTP relay
// down rather than being killed mid-job.
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => current?.kill(sig));
}

function run(args: string[]) {
  return new Promise<number>((resolve, reject) => {
    const child: ChildProcess = spawn(bun, args, {
      stdio: "inherit",
      env: { ...process.env, NODE_ENV: "development" },
    });
    current = child;
    child.on("error", reject);
    child.on("exit", (code, signal) => resolve(signal ? 1 : (code ?? 0)));
  });
}

const built = await run(["run", "build"]);
if (built !== 0) process.exit(built);
process.exit(await run(["run", "start", "--", "-p", port]));
