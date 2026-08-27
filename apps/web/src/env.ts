import "server-only";
import { loadEnv, type Env } from "./env.schema";

export { loadEnv, parseEnv, schema, type Env } from "./env.schema";

/**
 * Lazily parsed on first access (not at import time) so `next build` can
 * bundle this module without a real environment. The Proxy forwards keys,
 * descriptors and `in` checks so `Object.keys(env)`, spread and
 * `JSON.stringify(env)` all work.
 */
const load = loadEnv;

export const env: Env = new Proxy({} as Env, {
  get(_t, key) {
    if (typeof key === "symbol") return undefined;
    return load()[key as keyof Env];
  },
  has(_t, key) {
    return key in load();
  },
  ownKeys() {
    return Reflect.ownKeys(load());
  },
  getOwnPropertyDescriptor(_t, key) {
    const value = load()[key as keyof Env];
    if (value === undefined && !(key in load())) return undefined;
    return { enumerable: true, configurable: true, value };
  },
});
