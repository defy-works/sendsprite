/* global console, process, setImmediate, setTimeout */
/**
 * Preloaded with `--require` to imitate the worst realistic neighbour: a
 * dependency that writes to stdout behind the server's back.
 *
 * Two escapes that a `console.log = console.error` patch leaves open:
 *   - `console.dir` writes to the Console instance's own stream, not `log`;
 *   - `process.stdout.write` bypasses `console` altogether.
 *
 * The second write deliberately has no trailing newline. The client's
 * `ReadBuffer` splits on `\n` and skips a whole line it cannot parse, so
 * newline-terminated junk is survivable — but an unterminated write *prefixes*
 * the next JSON-RPC frame, destroying a real message. That is the case that
 * actually breaks a session, so it is the one the test reproduces.
 *
 * The writes are deferred to the first event-loop turn so they land after the
 * bin's module graph has evaluated, i.e. after any guard has installed.
 */
const shout = () => {
  console.dir({ x: 1 });
  process.stdout.write("junk");
};
setImmediate(shout);
setTimeout(shout, 50);
