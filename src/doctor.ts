// `factory doctor [--fix]`: everything the loop needs before `factory watch`, checked once.

import type { CommandRunner, ScmPort } from "./github";
import { labelsFor } from "./labels";
import { gateCount, type RouteConfig, type RuntimeConfig, type TrackerConfig } from "./config";
import type { AgentConfig, StageAgents } from "./agents/types";
import { PRESETS } from "./agents/presets";
import { DEFAULT_AGENT } from "./agents/default";
import { suggestSlots } from "./machine";
import { loadWorkflow } from "./engine/workflows";
import { MCP_REGISTRY, mcpProblems, parseMcpRegistry } from "./mcp";
import { runtimeRefs, unknownRuntimes } from "./runtimes";
import { type Health, probeChecks } from "./runtime-kit";
import type { Workflow } from "./core/workflow";
import { createHash } from "node:crypto";
import { readCommandsCheck } from "./config-health";

export interface DoctorCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
  readonly fixable: boolean;
  // A warning is shown but never fails the run.
  readonly warn?: boolean;
}

export interface DoctorDeps {
  readonly github: ScmPort;
  // Where issues live (config.tracker) and its own auth. Absent: GitHub, whose auth is gh's.
  readonly tracker?: { readonly kind: TrackerConfig["kind"]; authStatus(): Promise<{ ok: boolean; detail: string }> };
  readonly git: CommandRunner;
  readonly which: (bin: string) => Promise<boolean>;
  // `<bin> --version` output, or undefined when it cannot be read.
  readonly versionOf?: (bin: string) => Promise<string | undefined>;
  readonly fileExists: (path: string) => Promise<boolean>;
  readonly readFile: (path: string) => Promise<string | undefined>;
  readonly isExecutable: (path: string) => Promise<boolean>;
  // probeRuntime over this machine's runtimes; absent, doctor checks names only.
  readonly probeRuntime?: (runtime: string, bins: readonly string[]) => Promise<Health>;
}

export interface DoctorContext {
  readonly repo: string;
  // config.runtime and the runtime names this machine has (built-ins plus machine.json runtimes).
  readonly runtime?: RuntimeConfig;
  readonly runtimeNames?: readonly string[];
  readonly cloneDir: string;
  readonly baselineTag: string;
  readonly factoryMode?: string; // FACTORY_MODE, "actions" when CI drives the loop
  readonly agents?: Record<string, AgentConfig>;
  readonly stages?: StageAgents;
  readonly routes?: Readonly<Record<string, RouteConfig>>;
  // Shipped skill files (path relative to the repo root -> content), to spot an install that predates this runner.
  readonly templateSkills?: Record<string, string>;
  // config.templateOverrides: files or directories this repo customised on purpose; the drift check skips them.
  readonly templateOverrides?: readonly string[];
  // config.tmux.enabled: the watcher refuses to start without tmux, so doctor says so first.
  readonly tmux?: boolean;
  // The pre-v2.6.2 shared paths, warned about and never auto-migrated: a shared DB moved without
  // asking could interleave two repos' history, so the move is left to the operator.
  readonly legacyStatePath?: string;
  readonly legacyWorkspacesDir?: string;
  // config.resettable: a repo that never sets it has no reason to keep a baseline tag current.
  readonly resettable?: boolean;
  // The machine's slot count, compared against suggestSlots()'s cores/memory heuristic. Advice only
  // (plan v2.7.0 item 5): nothing here enforces the suggestion.
  readonly configuredSlots?: number;
  // config.workflow: the watcher refuses to start on a workflow that does not parse.
  readonly workflow?: string;
}

// Flags that let a CLI run headless without waiting on an approval prompt.
export const BYPASS_FLAGS: ReadonlySet<string> = new Set([
  "--dangerously-skip-permissions",
  "--dangerously-bypass-approvals-and-sandbox",
  "--yolo",
  "--force",
  "-f",
  "--auto",
  "--full-auto",
  "--yes",
  "--yes-always",
  "-y",
  "--permission-mode",
  "--approval-mode",
  "--auto-approve",
  "--trust",
  "--allow-all",
]);

// The checks for one agent a stage uses; the dashboard's Agents page shows the same rows.
export async function agentChecks(
  name: string,
  agents: Readonly<Record<string, AgentConfig>>,
  deps: Pick<DoctorDeps, "which" | "versionOf">,
): Promise<DoctorCheck[]> {
  const out: DoctorCheck[] = [];
  const agent = agents[name];
  const preset = agent?.preset ? PRESETS[agent.preset] : undefined;
  const binary = agent?.command?.[0] ?? preset?.binary;
  out.push({
    name: `${binary ?? name} on PATH`,
    ok: binary !== undefined && (await deps.which(binary)),
    detail: `agent "${name}" runs each stage it is assigned`,
    fixable: false,
  });
  // A preset that wraps `command` pins a protocol, not the binary, so there is no version to compare.
  const pinned = preset?.wrapsCommand ? undefined : preset;
  if (pinned?.noVersionFlag && binary && (await deps.which(binary))) {
    out.push({
      name: `${binary} is version ${pinned.version}`,
      ok: true,
      detail: `${binary} has no --version flag, so the pin (${pinned.version}) is not checked here; the Dockerfile and CI install it`,
      fixable: false,
    });
  } else if (pinned && deps.versionOf && binary && (await deps.which(binary))) {
    const found = await deps.versionOf(binary);
    out.push({
      name: `${binary} is version ${pinned.version}`,
      ok: found?.includes(pinned.version) ?? false,
      warn: true,
      detail:
        found === undefined
          ? `could not read \`${binary} --version\``
          : `found "${found.split("\n")[0]!.trim()}", pinned ${pinned.version} (Dockerfile and CI install the pin)`,
      fixable: false,
    });
  }
  if (preset && !preset.verified) {
    out.push({
      name: `agent "${name}" is verified`,
      ok: false,
      warn: true,
      detail: `verified live: no (participants verify it with \`factory verify-agent ${preset.name}\`, see docs/verify-an-agent.md)`,
      fixable: false,
    });
  }
  if (agent?.command && !preset) {
    const hasBypass = agent.command.some(
      (a) => BYPASS_FLAGS.has(a) || [...BYPASS_FLAGS].some((f) => a.startsWith(`${f}=`)),
    );
    out.push({
      name: `agent "${name}" runs without prompting`,
      ok: hasBypass,
      detail: hasBypass
        ? "its command carries an approval-bypass flag"
        : `its command has no approval-bypass flag (${[...BYPASS_FLAGS].slice(0, 6).join(", ")}, ...): an unattended run would wait for a prompt until the timeout`,
      fixable: false,
    });
  }
  if (agent && !preset) {
    out.push({
      name: `agent "${name}" reports usage`,
      ok: true,
      detail:
        "no preset, so tokens show as not reported and the tool-call cap is not enforced; the timeout is the backstop (consider a sandbox)",
      fixable: false,
    });
  }
  return out;
}

export async function runDoctor(deps: DoctorDeps, ctx: DoctorContext): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];

  checks.push({
    name: "gh on PATH",
    ok: await deps.which("gh"),
    detail: "gh CLI must be installed and authenticated (`gh auth status`)",
    fixable: false,
  });
  // One check per agent a stage actually uses, not one for every agent in config.
  const agents = ctx.agents ?? { [DEFAULT_AGENT]: { preset: "claude" } };
  const stages = ctx.stages ?? { default: DEFAULT_AGENT };
  // The default only counts if some stage falls back to it.
  const STAGES = ["triage", "plan", "build", "verify", "pr", "retro"] as const;
  const used = new Set(STAGES.map((st) => stages[st] ?? stages.default ?? DEFAULT_AGENT));
  for (const name of [...used].sort()) checks.push(...(await agentChecks(name, agents, deps)));
  checks.push({
    name: "python3 on PATH",
    ok: await deps.which("python3"),
    detail: "guard-paths.sh parses hook JSON with python3 and fails closed (blocks everything) without it",
    fixable: false,
  });
  checks.push({
    name: "jq on PATH",
    ok: await deps.which("jq"),
    detail: "gates.sh and the CI workflow expect jq",
    fixable: false,
  });

  const auth = await deps.github.authStatus();
  checks.push({
    name: "gh authenticated",
    ok: auth.ok,
    detail: auth.detail,
    fixable: false,
  });
  const kind = deps.tracker?.kind ?? "github";
  const trackerAuth =
    kind === "github"
      ? { ok: auth.ok, detail: "issues and labels on GitHub, through gh" }
      : await deps.tracker!.authStatus();
  checks.push({
    name: `tracker: ${kind}, authenticated`,
    ok: trackerAuth.ok,
    detail: trackerAuth.detail,
    fixable: false,
  });

  checks.push({
    name: "target has .factory/config.json",
    ok: await deps.fileExists(`${ctx.cloneDir}/.factory/config.json`),
    detail: `${ctx.cloneDir}/.factory/config.json`,
    fixable: false,
  });
  checks.push({
    name: "target has an executable .factory/gates.sh",
    ok: await deps.isExecutable(`${ctx.cloneDir}/.factory/gates.sh`),
    detail: `${ctx.cloneDir}/.factory/gates.sh (run \`factory install --update\` to restore it)`,
    fixable: false,
  });
  // A skeleton left as installed still has TODO markers: the runner would
  // grade against placeholder gates and an empty charter.
  for (const file of ["config.json", "charter.md"]) {
    const text = await deps.readFile(`${ctx.cloneDir}/.factory/${file}`);
    checks.push({
      name: `.factory/${file} has no TODO left`,
      ok: text !== undefined && !text.includes("TODO"),
      detail: text === undefined ? "file is missing" : text.includes("TODO") ? "fill in every TODO" : "filled in",
      fixable: false,
    });
  }
  // With no gates no build can go green, so the watcher parks every issue at build.
  const config = await deps.readFile(`${ctx.cloneDir}/.factory/config.json`);
  const gateCount = gatesIn(config);
  if (gateCount !== undefined) {
    checks.push({
      name: ".factory/config.json defines at least one gate",
      ok: gateCount > 0,
      detail:
        gateCount > 0
          ? `${gateCount} gate(s)`
          : "no gates: run `factory init`, or add one (a docs-only repo needs only a lint or link check)",
      fixable: false,
    });
  }
  checks.push(...readCommandsCheck(ctx.routes, config));
  const overridden = (path: string) =>
    (ctx.templateOverrides ?? []).some((o) => path === o || path.startsWith(o.endsWith("/") ? o : `${o}/`));
  if (ctx.templateSkills) {
    const stale: string[] = [];
    for (const [path, want] of Object.entries(ctx.templateSkills)) {
      if (overridden(path)) continue;
      if ((await deps.readFile(`${ctx.cloneDir}/${path}`)) !== want) stale.push(path);
    }
    checks.push({
      name: "installed skills match this runner",
      ok: stale.length === 0,
      detail: stale.length
        ? `${stale.length} differ or are missing (${stale[0]}); run \`factory install --update\``
        : "up to date",
      fixable: false,
      warn: true,
    });
  }
  // src/install-template.ts records the sha256 of every factory file it left in place; a file that no longer
  // matches was edited in this repo, and the next `install --update` would overwrite it.
  const manifest = parseManifest(await deps.readFile(`${ctx.cloneDir}/.factory/manifest.json`));
  if (manifest) {
    const edited: string[] = [];
    for (const [path, sha] of Object.entries(manifest)) {
      if (overridden(path)) continue;
      const text = await deps.readFile(`${ctx.cloneDir}/${path}`);
      if (text === undefined || sha256(text) !== sha) edited.push(path);
    }
    checks.push({
      name: "factory files unchanged since install",
      ok: edited.length === 0,
      detail: edited.length
        ? `${edited.length} edited or missing (${edited[0]}); \`factory install --update\` overwrites them, so list a kept edit in templateOverrides`
        : "match .factory/manifest.json",
      fixable: false,
      warn: true,
    });
  }
  let stepLabels: string[] = [];
  if (ctx.workflow !== undefined) {
    const loaded = await loadWorkflow(ctx.cloneDir, ctx.workflow, deps.readFile);
    if (loaded.ok) stepLabels = workflowLabels(loaded.workflow);
    checks.push({
      name: `workflow ${ctx.workflow} is valid`,
      ok: loaded.ok,
      detail: loaded.ok
        ? `${Object.keys(loaded.workflow.steps).length} steps from ${loaded.workflow.start}`
        : loaded.problems.join("; "),
      fixable: false,
    });
    const refs = runtimeRefs({ runtime: ctx.runtime }, loaded.ok ? loaded.workflow.steps : {});
    if (ctx.runtimeNames && refs.length > 0) {
      const unknown = unknownRuntimes(refs, Object.fromEntries(ctx.runtimeNames.map((n) => [n, true])));
      checks.push({
        name: "every runtime the config and workflow name exists on this machine",
        ok: unknown.length === 0,
        detail: unknown.length ? unknown.join("; ") : refs.map((r) => `${r.where}: ${r.name}`).join(", "),
        fixable: false,
      });
      // A name that exists can still be a box that is down.
      if (deps.probeRuntime) checks.push(...(await probeChecks(refs, ctx.runtimeNames, deps.probeRuntime, config)));
    }
    const named = loaded.ok
      ? Object.values(loaded.workflow.steps).flatMap((s) => (s.mcp ?? []).map((n) => ({ step: s.id, n })))
      : [];
    if (named.length > 0) {
      const registry = parseMcpRegistry(await deps.readFile(`${ctx.cloneDir}/${MCP_REGISTRY}`));
      const problems = mcpProblems(registry, [...new Set(named.map((x) => x.n))]);
      checks.push({
        name: `every mcp: server in ${ctx.workflow} is in ${MCP_REGISTRY}`,
        ok: problems.length === 0,
        detail: problems.length ? problems.join("; ") : named.map((x) => `${x.step}: ${x.n}`).join(", "),
        fixable: false,
      });
    }
  }
  if (ctx.tmux) {
    checks.push({
      name: "tmux is installed (tmux.enabled)",
      ok: await deps.which("tmux"),
      detail: "install tmux, or set tmux.enabled to false",
      fixable: false,
    });
  }
  if (ctx.factoryMode === "actions") {
    checks.push({
      name: "FACTORY_MODE=actions has a workflow",
      ok: await deps.fileExists(`${ctx.cloneDir}/.github/workflows/factory.yml`),
      detail: "rename .github/workflows/factory.yml.example to factory.yml (from `factory install --ci`)",
      fixable: false,
    });
  }

  // Only `reset`/`rebaseline` ever read this tag, and both already refuse on
  // a repo that isn't resettable (reset.ts). A live repo (lwp-website) that
  // deliberately never sets one would otherwise fail doctor for a tag it can
  // never use, so this check doesn't fire unless the repo opted in.
  if (ctx.resettable) {
    const tag = await deps.git.run(["rev-parse", ctx.baselineTag], { cwd: ctx.cloneDir });
    checks.push({
      name: `baseline tag "${ctx.baselineTag}" exists`,
      ok: tag.code === 0,
      detail: tag.stdout.trim() || tag.stderr.trim(),
      fixable: false,
    });
  }

  let existingLabels: Set<string>;
  try {
    existingLabels = new Set(await deps.github.listLabels(ctx.repo));
  } catch {
    existingLabels = new Set();
  }
  const missing = labelsFor(ctx.routes, stepLabels).filter((l) => !existingLabels.has(l.name));
  checks.push({
    name: "all factory labels exist",
    ok: missing.length === 0,
    detail: missing.length ? `missing: ${missing.map((l) => l.name).join(", ")}` : "all present",
    fixable: true,
  });

  if (ctx.legacyStatePath) {
    const exists = await deps.fileExists(ctx.legacyStatePath);
    checks.push({
      name: "no unmigrated pre-v2.6.2 shared factory.db",
      ok: !exists,
      detail: exists
        ? `${ctx.legacyStatePath} still exists; each repo now gets its own DB under FACTORY_HOME/<owner>/<repo>/factory.db. This is never migrated automatically: move any run history you want to keep, then remove it.`
        : "none found",
      fixable: false,
      warn: true,
    });
  }
  if (ctx.legacyWorkspacesDir) {
    const exists = await deps.fileExists(ctx.legacyWorkspacesDir);
    checks.push({
      name: "no unmigrated pre-v2.6.2 shared workspaces/",
      ok: !exists,
      detail: exists
        ? `${ctx.legacyWorkspacesDir} still exists; each repo now gets its own workspaces/ under FACTORY_HOME/<owner>/<repo>/. This is never migrated automatically: move anything you need, then remove it.`
        : "none found",
      fixable: false,
      warn: true,
    });
  }

  if (ctx.configuredSlots !== undefined) {
    const suggested = suggestSlots();
    checks.push({
      name: "machine slots suit this machine",
      ok: true,
      warn: true,
      detail: `configured ${ctx.configuredSlots}, this machine's cores/memory suggest ${suggested} (advice only; set FACTORY_SLOTS or FACTORY_HOME/machine.json to change it)`,
      fixable: false,
    });
  }

  return checks;
}

export async function fixDoctor(
  github: Pick<ScmPort, "ensureLabel">,
  repo: string,
  routes?: Readonly<Record<string, RouteConfig>>,
  workflow?: Workflow,
): Promise<void> {
  for (const label of labelsFor(routes, workflow ? workflowLabels(workflow) : [])) {
    await github.ensureLabel(repo, label.name, label.color, label.description);
  }
}

const workflowLabels = (workflow: Workflow): string[] => Object.values(workflow.steps).map((s) => s.label);

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

// `.factory/manifest.json` is `{ "files": { "<path>": "<sha256>" } }`; anything else is no manifest.
function parseManifest(text: string | undefined): Record<string, string> | undefined {
  if (text === undefined) return undefined;
  try {
    const files = JSON.parse(text)?.files;
    return files && typeof files === "object" && !Array.isArray(files) ? files : undefined;
  } catch {
    return undefined;
  }
}

// The number of gates in a config file's text; undefined when it is missing or not JSON.
function gatesIn(text: string | undefined): number | undefined {
  if (text === undefined) return undefined;
  try {
    return gateCount(JSON.parse(text));
  } catch {
    return undefined;
  }
}
