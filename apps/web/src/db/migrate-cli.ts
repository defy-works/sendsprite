import { runMigrations } from "./migrate";
await runMigrations(process.env.DATABASE_URL!);
console.log("migrations applied");
