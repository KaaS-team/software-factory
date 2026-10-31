import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { openInitPr } from "../src/init-pr";
import type { CreatePrOptions } from "../src/ports/scm";

const ROOT = join(import.meta.dir, "..");

// Each entry is the gh adapter itself, the safe-output denylist, or a codespace ssh transport.
const ALLOWED = ["src/adapters/codespaces/execution.ts", "src/github.ts", "src/safe-outputs.ts"];

function tsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? tsFiles(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : [],
  );
}

describe("scm boundary", () => {
  test("only the pinned files spawn gh, and cli.ts and init-cli.ts are not among them", () => {
    const found = tsFiles(join(ROOT, "src"))
      .filter((f) => /\[\s*"gh"/.test(readFileSync(f, "utf8")))
      .map((f) => relative(ROOT, f))
      .sort();
    expect(found).toEqual(ALLOWED);
    expect(ALLOWED).not.toContain("src/cli.ts");
    expect(ALLOWED).not.toContain("src/init-cli.ts");
  });
});

describe("openInitPr", () => {
  test("pushes factory/init and opens the PR through the port with the origin default branch", async () => {
    mkdirSync(tmpdir(), { recursive: true });
    const root = mkdtempSync(join(tmpdir(), "init-pr-"));
    try {
      const run = (cwd: string, ...a: string[]) => {
        const r = Bun.spawnSync(["git", ...a], { cwd, stdout: "pipe", stderr: "pipe" });
        expect(r.exitCode).toBe(0);
      };
      const remote = join(root, "remote.git");
      const work = join(root, "work");
      mkdirSync(remote);
      mkdirSync(work);
      run(remote, "init", "--bare", "-b", "trunk");
      run(work, "init", "-b", "trunk");
      run(work, "config", "user.email", "t@example.com");
      run(work, "config", "user.name", "t");
      run(work, "remote", "add", "origin", remote);
      writeFileSync(join(work, "AGENTS.md"), "x\n");
      run(work, "add", "AGENTS.md");
      run(work, "commit", "-m", "base");
      run(work, "push", "-u", "origin", "trunk");
      run(work, "remote", "set-head", "origin", "trunk");
      for (const d of [".factory", ".claude", ".agents"]) mkdirSync(join(work, d));
      writeFileSync(join(work, ".claude", "x"), "x\n");
      writeFileSync(join(work, ".agents", "x"), "x\n");
      writeFileSync(join(work, ".factory", "config.json"), "{}\n");
      const calls: CreatePrOptions[] = [];
      const url = await openInitPr(
        work,
        "o/r",
        { name: "bun", lines: ["a", "b"] },
        {
          createPr: async (o) => {
            calls.push(o);
            return "https://example.test/pr/1";
          },
        },
      );
      expect(url).toBe("https://example.test/pr/1");
      expect(calls).toEqual([
        { repo: "o/r", base: "trunk", head: "factory/init", title: "factory: init", body: "- a\n- b" },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
