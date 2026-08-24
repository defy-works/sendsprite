import { describe, expect, it } from "vitest";
import { createCipher } from "@/lib/crypto";

const SECRET = "s".repeat(40);

describe("createCipher", () => {
  it("round-trips utf-8 text", () => {
    const c = createCipher(SECRET);
    const enc = c.encrypt("AKIA…/secret 🔐");
    expect(enc).not.toContain("AKIA");
    expect(c.decrypt(enc)).toBe("AKIA…/secret 🔐");
  });
  it("produces different ciphertext for the same plaintext (random IV)", () => {
    const c = createCipher(SECRET);
    expect(c.encrypt("x")).not.toBe(c.encrypt("x"));
  });
  it("fails to decrypt with a different secret", () => {
    const a = createCipher(SECRET);
    const b = createCipher("t".repeat(40));
    expect(() => b.decrypt(a.encrypt("hello"))).toThrow();
  });
  it("detects tampering", () => {
    const c = createCipher(SECRET);
    const enc = c.encrypt("hello");
    const tampered = enc.slice(0, -2) + (enc.endsWith("A") ? "BB" : "AA");
    expect(() => c.decrypt(tampered)).toThrow();
  });
  it("is versioned so the format can change later", () => {
    expect(createCipher(SECRET).encrypt("v")).toMatch(/^v1\./);
  });
});
