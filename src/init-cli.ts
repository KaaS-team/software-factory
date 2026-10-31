// `factory install` and `factory init`. src/cli.ts dispatches here.

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { CliContext } from "./cli-runtime";
import { UsageError } from "./cli-output";
import { DEFAULT_CONFIG, loadConfig, repoFromRemoteUrl } from "./config";
import { fixDoctor } from "./doctor";
import { describeStack, initConfig, isFilledIn, writeCharter } from "./init";
import { openInitPr } from "./init-pr";
import { installTemplate } from "./install-template";
import { templateDir } from "./template-root";
import { makeScm } from "./scm";
import { detectStack, diskFiles } from "./stack";
import { workflowFor } from "./engine/workflows";

export async function cmdInstall(cli: CliContext): Promise<void> {
  const target = cli.args[1];
  if (!target)
    throw new UsageError("install: usage: factory install <target-dir> [--dry-run] [--update] [--ci] [--agents a,b,c]");
  runInstall(target, cli);
  if (cli.has("dry-run")) return;
  // Labels are cheap and idempotent, so create them right after a real install
  // instead of making every repo run a separate `doctor --fix` first. Best
  // effort: a fresh install with no filled-in config.json still gets the
  // "next:" hint above, and `doctor --fix` stays the authoritative fixer.
  try {
    const config = await loadConfig(resolve(target));
    await fixDoctor(
      makeScm(config),
      config.repo,
      config.routes,
      await workflowFor(resolve(target), config).catch(() => undefined),
    );
    console.log(`factory install: labels ensured on ${config.repo}`);
  } catch {
    // no usable config.json yet
  }
}

function runInstall(target: string, cli: CliContext): void {
  const agents = cli.flag("agents");
  if (cli.has("agents") && (!agents || agents.startsWith("-")))
    throw new UsageError("install: --agents needs a list like claude,codex");
  const { lines } = installTemplate(target, {
    dryRun: cli.has("dry-run"),
    update: cli.has("update"),
    ci: cli.has("ci"),
    agents: agents ? agents.split(",") : undefined,
  });
  for (const line of lines) console.log(line);
}

// `factory init`: install the template if it is missing, then write
// .factory/config.json from what the repo's own files say. A filled-in
// config is left alone unless --force. --pr opens it as one pull request.
export async function cmdInit(cli: CliContext): Promise<void> {
  const dir = resolve(cli.flag("repo-dir") ?? ".");
  const dry = cli.has("dry-run");
  if (!existsSync(join(dir, ".factory", "gates.sh")) && !dry) runInstall(dir, cli);
  const stack = detectStack(diskFiles(dir));
  for (const line of describeStack(stack)) console.log(`factory init: ${line}`);
  const target = join(dir, ".factory", "config.json");
  const current = existsSync(target) ? readFileSync(target, "utf8") : undefined;
  if (isFilledIn(current) && !cli.has("force")) {
    console.log(`factory init: ${target} is already filled in; left alone (--force rewrites it)`);
    return;
  }
  const remote = Bun.spawnSync(["git", "remote", "get-url", "origin"], { cwd: dir });
  const repo = remote.exitCode === 0 ? repoFromRemoteUrl(remote.stdout.toString().trim()) : undefined;
  const example = JSON.parse(readFileSync(join(templateDir(), ".factory", "config.example.json"), "utf8")) as Record<
    string,
    unknown
  >;
  const text = `${JSON.stringify(initConfig(example, stack, repo), null, 2)}\n`;
  if (dry) {
    process.stdout.write(text);
    return;
  }
  await Bun.write(target, text);
  console.log(`factory init: wrote ${target}${repo ? "" : ' (no github origin remote: set "repo" by hand)'}`);
  const charter = readFileSync(join(templateDir(), ".factory", "charter.md"), "utf8");
  if (writeCharter(dir, charter, stack, repo))
    console.log(`factory init: wrote ${join(dir, ".factory", "charter.md")}`);
  if (cli.has("pr")) {
    if (!repo) throw new Error("factory init --pr: no github origin remote to open the pull request on");
    const url = await openInitPr(dir, repo, { name: stack.name, lines: describeStack(stack) }, makeScm(DEFAULT_CONFIG));
    console.log(`factory init: opened ${url}`);
  }
  console.log(
    `factory init: next, fill the TODOs in .factory/charter.md, then run \`factory doctor --repo-dir ${dir}\``,
  );
}
