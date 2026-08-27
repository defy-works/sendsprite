/**
 * Proves the webhook SSRF pin still works **on the runtime that ships**.
 *
 * Do not delete this as redundant with `tests/unit/pinned-fetch.test.ts`.
 * That suite runs under vitest, and `bun run test` executes vitest under
 * *Node* (its bin has a node shebang; Bun only substitutes itself for
 * `--bun`). So the whole test suite is structurally blind to a Bun-runtime
 * regression in this path — which is exactly how the pin shipped broken:
 * `pinnedFetch` used undici's `Agent({ connect: { lookup } })`, and Bun
 * aliases the `undici` package to a builtin that never calls `connect.lookup`.
 * Every test passed on Node while the image resolved DNS a second time,
 * after vetting, reopening the DNS-rebinding window.
 *
 * This script therefore runs under Bun on purpose and refuses to run
 * anywhere else, so it cannot silently degrade into proving nothing.
 *
 *   bun run verify:pin                       # from the repo root
 *   bun run apps/web/scripts/verify-pin.ts
 */
import dns from "node:dns";
import http from "node:http";
import type { ClientRequest, ClientRequestArgs } from "node:http";
import type { AddressInfo, LookupFunction } from "node:net";
import type { Resolved } from "@/lib/pinned-fetch";

/** Reserved by RFC 2606: guaranteed never to resolve anywhere. */
const HOST = "pin.acme.invalid";
/** Serves a certificate for *.badssl.com, which this name does not match. */
const BAD_TLS_HOST = "wrong.host.badssl.com";

let failures = 0;
const pass = (what: string, detail = "") =>
  console.log(`  ok    ${what}${detail && `  (${detail})`}`);
const fail = (what: string, detail: string) => {
  failures++;
  console.log(`  FAIL  ${what}\n        ${detail}`);
};
const skip = (what: string, why: string) =>
  console.log(`  skip  ${what}\n        ${why}`);

/**
 * Counts invocations of the `lookup` that `pinnedFetch` hands to `node:http`.
 * Patching the module is the honest check: it observes the runtime calling
 * our resolver, which is the single behaviour undici silently dropped.
 */
function countLookups(): { calls: () => number; restore: () => void } {
  const real = http.request;
  let calls = 0;
  http.request = ((...args: unknown[]) => {
    const options = args[0] as ClientRequestArgs | undefined;
    const inner = options?.lookup;
    if (options && inner)
      options.lookup = ((...a: Parameters<LookupFunction>) => {
        calls++;
        return inner(...a);
      }) as LookupFunction;
    return (real as unknown as (...a: unknown[]) => ClientRequest)(...args);
  }) as unknown as typeof http.request;
  return { calls: () => calls, restore: () => void (http.request = real) };
}

console.log("verify-pin: webhook delivery pin, on the shipping runtime\n");

// 0. The runtime itself, checked before anything else is even imported:
//    everything below is meaningless on Node, so this is a hard failure
//    rather than a skip, and it must not be pre-empted by an import error.
if (!process.versions.bun) {
  console.log(
    `  FAIL  runs under Bun\n        process.versions.bun is unset ` +
      `(node ${process.versions.node}). Run this with \`bun\`, not \`node\`: ` +
      `the whole point is to exercise Bun's node:http.`,
  );
  process.exit(1);
}
pass("runs under Bun", `bun ${process.versions.bun}`);

const { pinnedFetch } = await import("@/lib/pinned-fetch");

// 1. The pin decides the destination. The URL names a host that cannot
//    resolve, so if the pin were ignored this could not connect at all; and
//    the listener must still see the original hostname in `Host`, which is
//    what keeps TLS verification standard.
const server = http.createServer((req, res) =>
  res.writeHead(200, { "content-type": "text/plain" }).end(req.headers.host),
);
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as AddressInfo).port;
const pin: Resolved = [{ address: "127.0.0.1", family: 4 }];

const spy = countLookups();
try {
  const res = await pinnedFetch(pin)(`http://${HOST}:${port}/hook`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: '{"a":1}',
    signal: AbortSignal.timeout(10_000),
  });
  const seenHost = await res.text();
  if (res.status !== 200)
    fail("loopback pin reaches the listener", `status ${res.status}`);
  else if (seenHost !== `${HOST}:${port}`)
    fail("Host header preserved", `listener saw "${seenHost}"`);
  else pass("loopback pin reaches the listener", `Host: ${seenHost}`);
} catch (e) {
  fail(
    "loopback pin reaches the listener",
    `${(e as Error).message} -- the runtime ignored connect lookup, so the ` +
      `name was resolved by DNS instead of pinned`,
  );
} finally {
  spy.restore();
  await new Promise<void>((r) => server.close(() => r()));
}

if (spy.calls() > 0) pass("lookup callback invoked", `${spy.calls()}x`);
else
  fail(
    "lookup callback invoked",
    "node:http never called the lookup we passed; the address is not pinned",
  );

// 2. Pinning must not weaken TLS: `host` stays the hostname, so a
//    certificate that does not cover it has to be rejected. Needs the
//    network, so it skips cleanly offline -- the loopback half above does not.
const online = await dns.promises
  .lookup(BAD_TLS_HOST, { all: true })
  .then((addrs) => addrs as Resolved)
  .catch(() => null);
if (!online) {
  skip(
    "TLS still rejects a bad certificate",
    `cannot resolve ${BAD_TLS_HOST} (offline?); the loopback checks above ` +
      `still ran and are mandatory`,
  );
} else {
  try {
    const res = await pinnedFetch(online)(`https://${BAD_TLS_HOST}/`, {
      signal: AbortSignal.timeout(15_000),
    });
    fail(
      "TLS still rejects a bad certificate",
      `the request succeeded with status ${res.status}; certificate ` +
        `validation is not using the hostname`,
    );
  } catch (e) {
    const msg = (e as Error).message;
    if (/ALTNAME|altname|does not match|ERR_TLS/.test(msg))
      pass("TLS still rejects a bad certificate", msg.split("\n")[0]!.trim());
    else
      fail(
        "TLS still rejects a bad certificate",
        `rejected, but not for the certificate name: ${msg}`,
      );
  }
}

console.log(
  failures === 0
    ? "\nverify-pin: OK"
    : `\nverify-pin: ${failures} check(s) FAILED`,
);
process.exit(failures === 0 ? 0 : 1);
