import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitCommandRunner } from "../src/git";
import { probePush, pushFailureReason } from "../src/push-probe";
import { engine, removeEngineDirs } from "./engine-harness";
import { defaultWorkflow } from "../src/engine/workflows";

const dirs: string[] = [];
afterAll(() => {
  removeEngineDirs();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const sh = new GitCommandRunner();

async function remoteAndClone(hook?: string) {
  mkdirSync(tmpdir(), { recursive: true });
  const root = mkdtempSync(join(tmpdir(), "push-probe-"));
  dirs.push(root);
  const bare = join(root, "remote.git");
  const clone = join(root, "clone");
  await sh.run(["init", "--bare", bare]);
  if (hook) {
    const path = join(bare, "hooks", "pre-receive");
    mkdirSync(join(bare, "hooks"), { recursive: true });
    writeFileSync(path, hook);
    chmodSync(path, 0o755);
  }
  await sh.run(["init", clone]);
  await sh.run(["config", "commit.gpgsign", "false"], { cwd: clone });
  await sh.run(["remote", "add", "origin", bare], { cwd: clone });
  return { bare, clone };
}

const refs = async (bare: string) => (await sh.run(["for-each-ref", "refs/factory"], { cwd: bare })).stdout;

describe("probePush", () => {
  test("an allowed push is ok and leaves no probe ref behind", async () => {
    const { bare, clone } = await remoteAndClone();
    expect(await probePush(sh, "origin", "run-1", clone)).toEqual({ ok: true });
    expect(await refs(bare)).toBe("");
  });

  test("a remote that denies the push returns a plain reason", async () => {
    const { clone } = await remoteAndClone("#!/bin/sh\necho 'GH006 protected branch update failed' >&2\nexit 1\n");
    const res = await probePush(sh, "origin", "run-2", clone);
    expect(res).toEqual({ ok: false, reason: "protected branch" });
  });

  test("a workflow-scope refusal is named as such", async () => {
    const { clone } = await remoteAndClone(
      "#!/bin/sh\necho 'refusing to allow without workflow permission' >&2\nexit 1\n",
    );
    expect(await probePush(sh, "origin", "run-3", clone)).toEqual({ ok: false, reason: "no workflow write scope" });
  });

  test("the reason never carries the host or a token from git's output", async () => {
    const stderr = "fatal: unable to access 'https://x-access-token:SECRETVALUE@example.invalid/o/r.git/': 403";
    const reason = pushFailureReason(stderr);
    expect(reason).toBe("no write scope");
    expect(reason).not.toContain("example.invalid");
    expect(reason).not.toContain("SECRETVALUE");
  });

  test("an unreachable remote fails with a reason, not a throw", async () => {
    const { clone } = await remoteAndClone();
    const res = await probePush(sh, join(clone, "missing.git"), "run-4", clone);
    expect(res.ok).toBe(false);
  });
});

describe("the run hook", () => {
  test("a failed probe stops the run before any agent step", async () => {
    const e = engine(
      defaultWorkflow(),
      0,
      {},
      {},
      { pushProbe: async () => ({ ok: false, reason: "no write scope" }) },
    );
    expect(await e.run()).toBe("needs-human");
    expect(e.executor.mcp).toHaveLength(0);
    const text = e.github.issues
      .get(1)!
      .comments.map((c) => c.body)
      .join("\n");
    expect(text).toContain("no write scope");
  });

  test("a passing probe lets the run reach its first agent step", async () => {
    let calls = 0;
    const e = engine(
      defaultWorkflow(),
      0,
      {},
      {},
      {
        pushProbe: async () => {
          calls++;
          return { ok: true };
        },
      },
    );
    // The harness has no plan output queued, so reaching the plan stage is the proof the run went on.
    await expect(e.run()).rejects.toThrow("no executor registered for plan:1");
    expect(calls).toBe(1);
  });
});
