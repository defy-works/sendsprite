/**
 * Kept in its own dependency-free module so `env.schema.ts` can use it as a
 * default without pulling `oauth.ts` (and `node:crypto`) into any bundle
 * that happens to touch the environment schema.
 *
 * Cloudflare OAuth scope names are the API token permission names,
 * lowercased and suffixed `.read` / `.write` — its own documented example is
 * `workers-platform.read`. We need to list the user's zones and write DNS
 * records in them. `offline_access` is what makes Cloudflare issue a refresh
 * token; without it the grant dies at the first access-token expiry and the
 * owner has to reconnect by hand.
 *
 * DNS read is requested as well as write: `upsertRecord` lists the records at
 * a name before writing, so it can PATCH an existing one instead of adding a
 * duplicate. Write alone would 403 that lookup if Cloudflare does not treat
 * edit as implying read.
 *
 * In the dashboard picker these are the **DNS** row (Edit + Read) and the
 * **Zone** row (Read) under "DNS & Zones"; `offline_access` has no row there
 * because it is a protocol scope, not a permission group — it is requested in
 * the authorize URL regardless.
 *
 * Cloudflare does not publish the canonical strings as a static list. Confirm
 * them against a created client
 * (`GET /client/v4/accounts/{id}/oauth_clients` → `scopes`) and override with
 * `CLOUDFLARE_OAUTH_SCOPES` if they differ from the `<group>.<read|write>`
 * pattern assumed here.
 */
export const CF_DEFAULT_SCOPES = "zone.read dns.read dns.write offline_access";
