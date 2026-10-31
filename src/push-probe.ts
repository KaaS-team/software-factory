// Proves a session can push before a run spends anything: creates an empty probe ref on the
// remote and deletes it again. A refusal comes back as a plain reason; the git output itself
// (which can carry a token or a host) never leaves this module.

import type { CommandRunner } from "./github";

export type ProbeResult = { ok: true } | { ok: false; reason: string };

// Matched against git's stderr, most specific first. The text is only read, never returned.
const REASONS: ReadonlyArray<readonly [RegExp, string]> = [
  [/protected branch|GH006|GH013|rule violations/i, "protected branch"],
  [/workflow.*(scope|permission)|without `?workflows`? permission/i, "no workflow write scope"],
  [/403|permission.*denied|not allowed|write access|authentication failed|could not read username/i, "no write scope"],
  [/pre-receive hook declined|remote rejected|denied|declined/i, "denied by repo settings"],
];

export function pushFailureReason(stderr: string): string {
  for (const [re, reason] of REASONS) if (re.test(stderr)) return reason;
  return "push refused";
}

export async function probePush(
  runner: CommandRunner,
  remote: string,
  runId: string,
  cwd?: string,
): Promise<ProbeResult> {
  const ref = `refs/factory/probe/${runId.replace(/[^A-Za-z0-9._-]/g, "-")}`;
  const empty = await runner.run(["hash-object", "-t", "tree", "-w", "--stdin"], { cwd });
  const treeSha = empty.code === 0 ? empty.stdout.trim() : "";
  if (!treeSha) return { ok: false, reason: "could not build the probe commit" };
  const commit = await runner.run(["commit-tree", treeSha, "-m", `factory: push probe ${runId}`], { cwd });
  const sha = commit.stdout.trim();
  if (commit.code !== 0 || !sha) return { ok: false, reason: "could not build the probe commit" };
  const push = await runner.run(["push", "--no-verify", remote, `${sha}:${ref}`], { cwd });
  if (push.code !== 0) return { ok: false, reason: pushFailureReason(push.stderr) };
  // Deleting is best effort: the create already proved write access.
  await runner.run(["push", "--no-verify", remote, `:${ref}`], { cwd });
  return { ok: true };
}
