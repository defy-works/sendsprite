/**
 * Copies the canonical installer and compose file into `apps/web/public/`, so a
 * running instance serves them at `/install.sh` and `/docker-compose.yml`.
 * sendsprite.com is one such instance, which is where the documented one-liner
 * `curl -fsSL https://sendsprite.com/install.sh | sh` points.
 *
 * The copies are committed (Next serves `public/` statically and the Dockerfile
 * ships it) and `apps/web/tests/unit/public-scripts.test.ts` fails when they
 * drift. After editing either root file: `bun run sync:scripts`.
 */
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dest = join(root, "apps", "web", "public");
const files = ["install.sh", "docker-compose.yml"];

mkdirSync(dest, { recursive: true });
for (const f of files) copyFileSync(join(root, f), join(dest, f));
console.log(`Synced ${files.join(", ")} -> apps/web/public/`);
