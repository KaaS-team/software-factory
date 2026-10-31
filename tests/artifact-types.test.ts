import { describe, expect, test } from "bun:test";
import { ARTIFACT_KINDS, parseArtifact, safeHttpUrl } from "../src/artifact-types";

describe("safeHttpUrl", () => {
  test("accepts http and https", () => {
    expect(safeHttpUrl("https://example.com/a?b=1")).toBe("https://example.com/a?b=1");
    expect(safeHttpUrl(" http://example.com ")).toBe("http://example.com/");
  });
  test.each([
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    "data:text/html,<b>x</b>",
    "file:///etc/passwd",
    "ftp://example.com/x",
    "//example.com/x",
    "/relative/path",
    "example.com",
    "http://",
    "",
  ])("rejects %s", (u) => {
    expect(safeHttpUrl(u)).toBeUndefined();
  });
  test("rejects non-strings", () => {
    expect(safeHttpUrl(42)).toBeUndefined();
    expect(safeHttpUrl(null)).toBeUndefined();
  });
});

describe("parseArtifact", () => {
  test("accepts every kind with a safe url", () => {
    for (const kind of ARTIFACT_KINDS) {
      expect(parseArtifact({ kind, title: " T ", url: "https://x.test/r" })).toEqual({
        ok: true,
        artifact: { kind, title: "T", url: "https://x.test/r" },
      });
    }
  });
  test("rejects an unknown kind, empty title, bad url and non-objects", () => {
    expect(parseArtifact({ kind: "video", title: "t", url: "https://x.test" })).toEqual({
      ok: false,
      error: `kind must be one of ${ARTIFACT_KINDS.join(", ")}`,
    });
    expect(parseArtifact({ kind: "log", title: " ", url: "https://x.test" })).toEqual({
      ok: false,
      error: "title must be a non-empty string",
    });
    expect(parseArtifact({ kind: "log", title: "t", url: "javascript:1" })).toEqual({
      ok: false,
      error: "url must be an absolute http or https URL",
    });
    expect(parseArtifact(null)).toEqual({ ok: false, error: "artifact must be an object" });
    expect(parseArtifact([])).toEqual({ ok: false, error: "artifact must be an object" });
  });
});
