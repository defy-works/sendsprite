import { Console } from "node:console";
import { Writable } from "node:stream";

/**
 * Reserves fd 1 for the MCP protocol and sends everything else to stderr.
 *
 * In stdio mode stdout carries the JSON-RPC framing and nothing else. A
 * client's `ReadBuffer` splits on `\n` and skips a line it cannot parse, so
 * newline-terminated noise is survivable — but an unterminated
 * `process.stdout.write` *prefixes* the next frame and destroys a real
 * message, which usually means a hung handshake. Patching `console.log` does
 * not cover that, nor `console.dir`, which writes to the Console instance's
 * own stream.
 *
 * So: the whole console is rebuilt over stderr, the public
 * `process.stdout.write` is rerouted there too, and the one writer that still
 * reaches fd 1 is `protocolStdout` — handed to `StdioServerTransport`
 * explicitly. Any dependency that writes to stdout, at any depth, lands on
 * stderr instead.
 *
 * This module is a side effect and must be imported before anything else in
 * `bin.ts`; `protocolStdout` is imported as a value so no bundler can decide
 * the import is dead and drop it (`"sideEffects": false` invites exactly that).
 *
 * Limit worth knowing: ESM evaluates every imported module before the first
 * statement of the importer runs, so a dependency that writes to stdout while
 * *its own module body* is evaluating still beats this guard. Nothing short of
 * a CJS shim can close that, and no dependency here does it — what this covers
 * is every write from the moment our own code starts, which is all of them in
 * practice.
 */

// Captured first, while `process.stdout.write` is still the real one.
const writeToFd1 = process.stdout.write.bind(process.stdout);

/** The only stream still connected to fd 1. */
export const protocolStdout = new Writable({
  write(
    chunk: unknown,
    encoding: unknown,
    callback: (e?: Error | null) => void,
  ) {
    writeToFd1(chunk as string, encoding as BufferEncoding, callback);
  },
});

// `node:console`'s class and the `globalThis.console` interface are two
// different declarations of the same thing in @types/node; at runtime a
// `Console` instance is exactly what the global holds.
globalThis.console = new Console(
  process.stderr,
  process.stderr,
) as unknown as typeof globalThis.console;

process.stdout.write = function redirectedWrite(
  this: unknown,
  chunk: unknown,
  encoding?: unknown,
  callback?: unknown,
) {
  return process.stderr.write(
    chunk as string,
    encoding as BufferEncoding,
    callback as () => void,
  );
} as typeof process.stdout.write;
