import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { DEFAULT_AGENT, skillsDirFor } from "../src/agents/default";
import { claudePreset } from "../src/agents/presets/claude";

const SRC = join(import.meta.dir, "..", "src");

// Each entry owns a claude-specific path or stage skill.
const ALLOWED = [
  "src/agents/default.ts",
  "src/agents/presets/claude.ts",
  "src/agents/prompt.ts",
  "src/config.ts",
  "src/context.ts",
  "src/core/minion.ts",
  "src/engine/minion.ts",
  "src/harness-defaults.ts",
  "src/install-template.ts",
  "src/learn.ts",
  "src/teach.ts",
];

function tsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? tsFiles(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : [],
  );
}

describe("skills directory resolver", () => {
  test("only the pinned files spell .claude/skills", () => {
    const found = tsFiles(SRC)
      .filter((f) => readFileSync(f, "utf8").includes(".claude/skills"))
      .map((f) => relative(join(SRC, ".."), f))
      .sort();
    expect(found).toEqual(ALLOWED);
  });

  test("skillsDirFor returns the preset directory, else the claude default", () => {
    expect(skillsDirFor(claudePreset)).toBe(claudePreset.skillsDir);
    expect(skillsDirFor({ ...claudePreset, skillsDir: ".other/skills" })).toBe(".other/skills");
    expect(skillsDirFor(undefined)).toBe(".claude/skills");
    expect(DEFAULT_AGENT).toBe("claude");
  });
});
