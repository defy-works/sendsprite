import { describe, expect, it } from "vitest";
import { parseArgs } from "../src/args";

describe("parseArgs", () => {
  it("defaults to stdio", () => {
    expect(parseArgs([])).toMatchObject({ http: false, help: false });
  });

  it("accepts --http bare, spaced and inline", () => {
    expect(parseArgs(["--http"])).toMatchObject({ http: true, port: 3333 });
    expect(parseArgs(["--http", "8080"])).toMatchObject({ port: 8080 });
    expect(parseArgs(["--http=8080"])).toMatchObject({ port: 8080 });
    // Port 0 asks the OS for a free one; the smoke tests rely on it.
    expect(parseArgs(["--http", "0"])).toMatchObject({ http: true, port: 0 });
  });

  it("recognises --help and -h", () => {
    expect(parseArgs(["--help"]).help).toBe(true);
    expect(parseArgs(["-h"]).help).toBe(true);
  });

  it("rejects a non-numeric or out-of-range port", () => {
    expect(() => parseArgs(["--http=abc"])).toThrow(/port/i);
    expect(() => parseArgs(["--http=70000"])).toThrow(/port/i);
    expect(() => parseArgs(["--http=-1"])).toThrow(/port/i);
    // A spaced `-1` is not a port at all, it is a stray flag.
    expect(() => parseArgs(["--http", "-1"])).toThrow(/unknown argument/i);
  });

  it("rejects an unknown argument", () => {
    expect(() => parseArgs(["--nope"])).toThrow(/unknown argument/i);
  });
});
