// What every step and every resume path shares: the deps, the comment and
// label helpers, running one agent stage, retro, and the spend caps. Moved
// verbatim from watch.ts when the pipeline became a workflow (v3.1).

import type { BlobStore } from "../ports/blob";
import { shipStage } from "./blobs";
import type { FactoryConfig } from "../config";
import type { HoldoutRunner } from "../holdout";
import { TRUNCATION_KIND } from "../event-budget";
import { costFor } from "../pricing";
import {
  OPERATOR_TAKEOVER,
  type Executor,
  type StageName,
  type StageRunOptions,
  type StageRunResult,
} from "../executor";
import { hiddenPaths } from "../acceptance";
import type { IssueView } from "../tmux";
import {
  clearStageArtifacts,
  validateStepJson,
  readStageArtifacts,
  runDir,
  type RetroArtifact,
  type VerdictArtifact,
} from "../artifacts";
import { hasBlocking, isChecked, keepSupported, type Rechecker } from "../recheck";
import { isTrusted } from "../chatops";
import { describeFindings, scanText } from "../secret-scan";
import { mcpServersFor } from "../mcp";
import { deriveIssueState, latestDataFor, parseDataMarkers } from "../derive";
import { type IssueScope, scopeFrom } from "../core/model-tier";
import { rehydrate } from "../rehydrate";
import { sanitizeIssue } from "../sanitize-issue";
import type { GateRunner } from "../gates";
import type { ProofGit } from "../proof";
import type { GhIssue } from "../github";
import { withLease, type Held, type LeaseOpts } from "./lease";
import type { LeasePort } from "../ports/lease";
import type { SpendEntry, SpendPolicy, SpendStore, SpendTotal } from "../ports/spend";
import type { ExecutionPort } from "../ports/execution";
import type { ScmPort } from "../ports/scm";
import type { Git } from "../git";
import type { Workflow } from "../core/workflow";
import { ensureSetup, ShellSetupRunner, type SetupRunner } from "../setup";
import type { FactoryState, RetroTrigger, Stage } from "../state";
import { LABEL, issueType } from "../labels";
import { emitEvent, type EventBus } from "./bus";
import { configHash } from "../team/hash";
import type { Minion } from "../core/minion";
import type { MachineConfig, MachineLeases, MachineSpend } from "../machine";

export type { Stage };
export type Outcome =
  | "needs-info"
  | "awaiting-approval"
  | "needs-human"
  | "failed"
  | "shipped"
  | "cancelled"
  | "lost-claim"
  | "untrusted"
  | "waiting";

export interface WatchDeps {
  readonly github: ScmPort;
  readonly git: Git;
  readonly state: FactoryState;
  readonly executor: Executor;
  readonly gateRunner: GateRunner;
  readonly holdoutRunner: HoldoutRunner;
  // A tool-free second look at must/should findings; absent means findings stand as written.
  readonly rechecker?: Rechecker;
  // Runs the proof:test revert check before verify and writes proof.json; absent means verify does it by hand.
  readonly proofGit?: ProofGit;
  readonly cloneDir: string;
  readonly pushProbe?: (worktree: string, runId: string) => Promise<import("../push-probe").ProbeResult>;
  readonly workspacesDir: string;
  // Runs config.setup once per worktree; defaults to a real shell, so tests can inject a fake.
  readonly setupRunner?: SetupRunner;
  // Absent: this process is the only worker on the repo. Present: every
  // advance holds the issue's lease (src/engine/lease.ts) for its whole run,
  // so workers on other machines, CI jobs and cloud routines never run the
  // same issue at once, and a crashed worker's issue is reclaimed after the TTL.
  readonly leases?: {
    readonly port: LeasePort;
    readonly holder: string;
    readonly opts?: LeaseOpts;
    readonly held: Map<number, Held>;
  };
  // Absent: caps read this machine's SQLite. Present: every stage's spend is
  // also recorded here and caps read the larger of the two, so they hold
  // across every worker.
  readonly spend?: SpendStore;
  // An org or fleet cap read with the repo's; absent means the repo and machine caps alone.
  readonly spendPolicy?: SpendPolicy;
  // Runtimes by name for check steps (src/runtimes.ts builds them); absent means check steps run like setup.
  readonly runtimes?: Readonly<Record<string, ExecutionPort>>;
  // Absent: this process alone decides concurrency. Present: every dispatch first takes a machine-wide
  // lease, so a second watcher on the same FACTORY_HOME shares this machine's slots (plan v2.7.0 item 5).
  readonly machine?: { readonly leases: MachineLeases; readonly config: MachineConfig; readonly spend: MachineSpend };
  // Where a stage streams its transcript and its pid/session (`factory takeover`). Absent: neither is written.
  readonly runFiles?: { transcript(issue: number): string; live(issue: number): string };
  // A live window per issue (tmux). Only a viewer: a failure here never fails a stage.
  readonly view?: IssueView;
  // The steps an issue walks; absent means the bundled feature-to-pr.
  readonly workflow?: Workflow;
  // Workflows a route names (routes.<type>.workflow), by name; an issue of that type runs its route's.
  readonly routeWorkflows?: Readonly<Record<string, Workflow>>;
  // The clock cron triggers read; absent means the real one.
  readonly now?: () => Date;
  // The v4 event bus (src/engine/bus.ts); absent means nothing is emitted.
  readonly bus?: EventBus;
  // The repo's .factory/minions, checked at boot (src/engine/minion.ts).
  readonly minions?: readonly Minion[];
  // Where each stage's transcript and artifacts are copied for the plane; absent means they stay here.
  readonly blobs?: BlobStore;
}

// Thrown by runStage when an operator stopped the agent to take it over;
// runWorkflow parks the issue instead of counting a failure.
export class OperatorTakeover extends Error {
  constructor(readonly stage: Stage) {
    super(`operator takeover during ${stage}`);
  }
}
export function worktreeFor(deps: WatchDeps, issue: number): string {
  return `${deps.workspacesDir}/issue-${issue}`;
}

export function labelsOf(issue: Pick<GhIssue, "labels">): string[] {
  return issue.labels.map((l) => l.name);
}

// Every label transition names its own "from" — always the label the caller
// just set (the loop's own `stage` variable, or the specific parked label a
// resume function is leaving) — rather than guessing at the issue's current
// label list, which is what let a restarted process reconstruct the wrong
// state (audit finding #21).
export async function moveLabel(
  deps: WatchDeps,
  config: FactoryConfig,
  issueNumber: number,
  from: string,
  to: string,
): Promise<void> {
  await deps.github.setStateLabel(config.repo, issueNumber, [from], to);
}

// The one place every resume path prepares a worktree: creates it if needed,
// then primes it with config.setup (idempotent). A setup failure parks the
// issue with the command output attached instead of handing a stage a
// worktree with no dependencies installed (plan v2.6.2 item 4).
export async function ensureWorktreeReady(
  deps: WatchDeps,
  config: FactoryConfig,
  issueNumber: number,
  worktree: string,
  fromLabel: string,
): Promise<boolean> {
  await deps.git.ensureWorktree(deps.cloneDir, worktree, issueNumber);
  // Every resume path funnels through here, so this is the one place that has
  // to hide holdout paths for triage, plan, build, verify and pr alike.
  const setupRunner = deps.setupRunner ?? new ShellSetupRunner();
  await deps.git.excludeFromSparseCheckout(worktree, await hiddenPaths(setupRunner, config, worktree));
  const result = await ensureSetup(setupRunner, worktree, config.setup);
  if (result.ok) return true;
  await moveLabel(deps, config, issueNumber, fromLabel, LABEL.needsHuman);
  await postComment(
    deps,
    config,
    issueNumber,
    `Setup failed in the worktree, so this parked instead of starting a stage:\n\n\`\`\`\n${result.log.slice(-4000)}\n\`\`\``,
  );
  finish(deps, config, issueNumber, "needs-human", "setup failed");
  return false;
}

export function withDataMarker(body: string, stage: string, json: unknown): string {
  return `${body}\n\n<!-- factory:data ${JSON.stringify({ stage, json })} -->`;
}

// Runs `work` holding the issue's lease when leases are on. "waiting" when
// another worker holds it: that worker is advancing the issue right now.
export async function leased(deps: WatchDeps, issueNumber: number, work: () => Promise<Outcome>): Promise<Outcome> {
  const l = deps.leases;
  if (!l) return work();
  const out = await withLease(
    l.port,
    String(issueNumber),
    l.holder,
    async (held) => {
      l.held.set(issueNumber, held);
      try {
        return await work();
      } finally {
        l.held.delete(issueNumber);
      }
    },
    l.opts,
  );
  return out ?? "waiting";
}

export async function postComment(
  deps: WatchDeps,
  config: FactoryConfig,
  issueNumber: number,
  body: string,
  dataTag?: { stage: string; json: unknown },
): Promise<void> {
  if (!body.trim()) return;
  const secrets = scanText(body);
  if (secrets.length > 0) {
    finish(deps, config, issueNumber, "needs-human", describeFindings(secrets));
    return;
  }
  // No marker means it would read as an OWNER-authored human comment.
  const full = dataTag
    ? withDataMarker(body, dataTag.stage, dataTag.json)
    : body.includes("<!-- factory:")
      ? body
      : `${body}\n\n<!-- factory:notice -->`;
  await deps.github.commentIssue(config.repo, issueNumber, full);
}

// Drop the must/should findings the diff does not support. A reject that loses
// every blocking finding becomes uncertain (a human looks), never a silent pass.
export async function recheckFindings(
  deps: WatchDeps,
  config: FactoryConfig,
  worktree: string,
  verdict: VerdictArtifact,
): Promise<{ verdict: VerdictArtifact; note: string }> {
  const checked = verdict.findings.filter(isChecked);
  const supported = await deps.rechecker!.supported(checked, await deps.git.diff(worktree, config.base));
  if (supported === undefined) return { verdict, note: "" };
  const { kept, dropped } = keepSupported(verdict.findings, supported);
  if (dropped.length === 0) return { verdict, note: "" };
  const result = verdict.result === "reject" && !hasBlocking(kept) ? "uncertain" : verdict.result;
  const list = dropped.map((f) => `- ${f.what}`).join("\n");
  return {
    verdict: { ...verdict, findings: kept, result },
    note: `\n\nThe diff does not support ${dropped.length} finding(s): none points at a changed line with a reproduction, so they were dropped:\n${list}`,
  };
}

// Build's status-comment.md is the one comment the runner keeps and edits in
// place. Its id comes from SQLite when this process ran the earlier rounds,
// or — for a resumed/restarted run — from the thread itself, so a restart
// never posts a duplicate status comment (audit finding #21).
export async function upsertStatusComment(
  deps: WatchDeps,
  config: FactoryConfig,
  issue: GhIssue,
  body: string,
  json?: unknown,
): Promise<void> {
  if (!body.trim()) return;
  const full = json !== undefined ? withDataMarker(body, "build", json) : body;
  const run = deps.state.getRun(config.repo, issue.number);
  const existingId = run?.status_comment_id ?? deriveIssueState(issue).statusCommentId;
  if (existingId) {
    await deps.github.editComment(config.repo, existingId, full);
    deps.state.updateRun(config.repo, issue.number, { status_comment_id: existingId });
    return;
  }
  const id = await deps.github.commentIssue(config.repo, issue.number, full);
  if (id !== undefined) deps.state.updateRun(config.repo, issue.number, { status_comment_id: id });
}

export function finish(
  deps: WatchDeps,
  config: FactoryConfig,
  issueNumber: number,
  status: "needs-info" | "awaiting-approval" | "needs-human" | "failed" | "shipped" | "cancelled",
  reason?: string,
): void {
  deps.state.updateRun(config.repo, issueNumber, { status, reason: reason ?? null });
  // Parked issues keep their window, so the operator can still read it.
  if (deps.view && (status === "shipped" || status === "cancelled" || status === "failed")) {
    deps.view.close(issueNumber).catch((e) => console.error(`[tmux] close #${issueNumber}: ${e}`));
  }
}

// Skills never call `gh` (only the runner talks to GitHub), so the current
// issue thread is handed to them as a file: they read it instead of fetching
// it themselves. Rewritten before every stage, sanitised (src/sanitize-issue.ts).
export async function writeIssueSnapshot(worktree: string, issue: GhIssue): Promise<void> {
  await Bun.write(`${worktree}/${runDir(issue.number)}/issue.json`, JSON.stringify(sanitizeIssue(issue), null, 2));
}

// The agent's own cost wins; otherwise price the tokens. No price means the
// cost is unknown, which is stored as NULL with usage_complete = 0, never as $0.
export function priceResult(result: StageRunResult): {
  cached: number;
  costUsd: number | null;
  usageComplete: boolean;
} {
  const cached = result.tokensCached ?? 0;
  const priced =
    result.costReported === false
      ? costFor(result.model, { tokensIn: result.tokensIn, tokensOut: result.tokensOut, tokensCached: cached })
      : result.costUsd;
  const usageComplete = result.usageComplete !== false && priced !== undefined;
  const costUsd = usageComplete ? (priced ?? null) : null;
  return { cached, costUsd, usageComplete };
}

// What the thread's triage and plan said about the issue's size and risk; triage has nothing to read yet.
// Only trusted comments count, so an outside commenter cannot pick the model by pasting a marker.
export function scopeOf(issue: GhIssue, stage: string): { scope?: IssueScope } {
  if (stage === "triage") return {};
  const markers = parseDataMarkers(issue.comments.filter(isTrusted));
  const scope = scopeFrom(latestDataFor(markers, "plan"), latestDataFor(markers, "triage"));
  return scope ? { scope } : {};
}

export function planOf(issue: GhIssue): unknown {
  return latestDataFor(parseDataMarkers(issue.comments.filter(isTrusted)), "plan");
}

export async function runStage(
  deps: WatchDeps,
  config: FactoryConfig,
  issue: GhIssue,
  stage: StageName,
  worktree: string,
  extra: Omit<Partial<StageRunOptions>, "mcp"> & { readonly mcp?: readonly string[] } = {},
): Promise<StageRunResult> {
  const issueNumber = issue.number;
  // Read from the clone of the base branch, never the worktree: an earlier step's agent can write
  // the worktree, and a server entry is a command this step would launch. A missing name throws
  // before anything is recorded or spent.
  const { mcp: mcpNames, ...rest } = extra;
  const mcp = mcpNames?.length ? mcpServersFor(deps.cloneDir, mcpNames) : undefined;
  // Clearing after rehydrate means this stage never starts with a stale copy of its own last attempt
  // (audit finding #9); rehydrate only repopulates earlier stages' artifacts.
  await rehydrate(worktree, issue);
  await writeIssueSnapshot(worktree, issue);
  await clearStageArtifacts(worktree, issueNumber, stage);

  deps.state.upsertRun({
    issue: issueNumber,
    repo: config.repo,
    title: issue.title,
    stage: stage as Stage,
    status: "running",
    config_hash: configHash(config),
  });
  const run = deps.state.getRun(config.repo, issueNumber)!;
  const files = await stageFiles(deps, issueNumber);
  const startedAt = new Date();
  const result = await deps.executor.runStage({
    stage,
    issue: issueNumber,
    cwd: worktree,
    hiddenPaths: await hiddenPaths(deps.setupRunner ?? new ShellSetupRunner(), config, worktree),
    maxBudgetUsd: config.maxBudgetUsd[stage],
    timeoutMinutes: config.stageTimeoutMinutes,
    maxToolCalls: config.maxToolCalls,
    agentCommands: config.agentCommands,
    type: issueType(config.routes, labelsOf(issue)),
    ...scopeOf(issue, stage),
    ...files,
    ...rest,
    ...(mcp ? { mcp } : {}),
  });
  for (const e of result.events)
    deps.state.appendEvent(
      run.id,
      stage as Stage,
      e.kind === "truncated" ? TRUNCATION_KIND : e.kind,
      e.text ?? e.toolName ?? "",
    );
  const finishedAt = new Date();
  const { cached, costUsd, usageComplete } = priceResult(result);
  deps.state.recordStageRun({
    repo: config.repo,
    issue: issueNumber,
    stage: stage as Stage,
    agent: result.agent ?? "claude", // ReplayExecutor reports none
    model: result.model ?? null,
    started_at: startedAt.toISOString(),
    finished_at: finishedAt.toISOString(),
    duration_ms: finishedAt.getTime() - startedAt.getTime(),
    tool_calls: result.toolCalls,
    tokens_in: result.tokensIn,
    tokens_out: result.tokensOut,
    tokens_cached: cached,
    tokens_cache_write: result.tokensCacheWrite ?? 0,
    cost_usd: costUsd,
    usage_complete: usageComplete ? 1 : 0,
    exit_code: result.exitCode,
    killed_reason: result.killedReason ?? null,
    session_id: result.sessionId ?? null,
    config_hash: configHash(config),
  });
  await recordSpend(deps, config, {
    issue: issueNumber,
    stage,
    costUsd,
    tokensIn: result.tokensIn,
    tokensOut: result.tokensOut,
    at: startedAt.toISOString(),
  });
  deps.state.updateRun(config.repo, issueNumber, {
    tool_calls: run.tool_calls + result.toolCalls,
    tokens_in: run.tokens_in + result.tokensIn,
    tokens_out: run.tokens_out + result.tokensOut,
    cost_usd: run.cost_usd + (costUsd ?? 0),
  });
  await shipStage(deps.blobs, config.repo, issueNumber, worktree, files.transcriptFile, deps.state);
  if (result.killedReason === OPERATOR_TAKEOVER) throw new OperatorTakeover(stage as Stage);
  return result;
}

// The machine's tally and the shared store, after stage_runs. A shared store
// that can't be written is logged, not fatal: the stage's work is done, and
// SQLite still has the row.
export async function recordSpend(
  deps: Pick<WatchDeps, "machine" | "spend">,
  config: FactoryConfig,
  e: SpendEntry,
): Promise<void> {
  if (e.costUsd !== null) deps.machine?.spend.record(config.repo, e.costUsd);
  await deps.spend
    ?.record(e)
    .catch((err) => console.error(`[spend] #${e.issue} ${e.stage}: ${err instanceof Error ? err.message : err}`));
}

// The transcript and live-file paths for a stage, and the issue's window
// opened on the transcript. Both are optional; a view error is only logged.
export async function stageFiles(
  deps: WatchDeps,
  issueNumber: number,
): Promise<{ transcriptFile?: string; liveFile?: string }> {
  if (!deps.runFiles) return {};
  const transcriptFile = deps.runFiles.transcript(issueNumber);
  if (deps.view) {
    await deps.view.show(issueNumber, transcriptFile).catch((e) => console.error(`[tmux] show #${issueNumber}: ${e}`));
  }
  return { transcriptFile, liveFile: deps.runFiles.live(issueNumber) };
}

// Plan v2.10.0 item 3: a read-only stage after a final outcome (merged,
// rejected, or given up on after verify rejections). Never goes through
// runStage: that wrapper's upsertRun would put an already-terminal run back
// to "running", and retro's cost never rolls into runs.cost_usd (spendSummary
// sums stage_runs, not runs, so the spend caps still see it via recordStageRun).
// `existingId` is set only when a row was queued earlier (the dashboard's
// operator-merge route, which has no Executor to run this itself) and is now
// being drained by runQueuedRetros; the three watch.ts triggers queue and run
// in the same call.
export async function runRetro(
  deps: WatchDeps,
  config: FactoryConfig,
  issue: GhIssue,
  outcome: RetroTrigger,
  existingId?: number,
): Promise<void> {
  const id = existingId ?? deps.state.queueRetro(config.repo, issue.number, outcome);
  const issueNumber = issue.number;
  const worktree = worktreeFor(deps, issueNumber);
  try {
    await rehydrate(worktree, issue);
    await writeIssueSnapshot(worktree, issue);
    await clearStageArtifacts(worktree, issueNumber, "retro");
    const startedAt = new Date();
    const result = await deps.executor.runStage({
      stage: "retro",
      issue: issueNumber,
      cwd: worktree,
      maxBudgetUsd: config.maxBudgetUsd.retro,
      timeoutMinutes: config.stageTimeoutMinutes,
      maxToolCalls: config.maxToolCalls,
      agentCommands: config.agentCommands,
      ...(deps.runFiles
        ? { transcriptFile: deps.runFiles.transcript(issueNumber), liveFile: deps.runFiles.live(issueNumber) }
        : {}),
    });
    const finishedAt = new Date();
    const { cached, costUsd, usageComplete } = priceResult(result);
    deps.state.recordStageRun({
      repo: config.repo,
      issue: issueNumber,
      stage: "retro" as Stage,
      agent: result.agent ?? "claude",
      model: result.model ?? null,
      started_at: startedAt.toISOString(),
      finished_at: finishedAt.toISOString(),
      duration_ms: finishedAt.getTime() - startedAt.getTime(),
      tool_calls: result.toolCalls,
      tokens_in: result.tokensIn,
      tokens_out: result.tokensOut,
      tokens_cached: cached,
      tokens_cache_write: result.tokensCacheWrite ?? 0,
      cost_usd: costUsd,
      usage_complete: usageComplete ? 1 : 0,
      exit_code: result.exitCode,
      killed_reason: result.killedReason ?? null,
      session_id: result.sessionId ?? null,
      config_hash: configHash(config),
    });
    await recordSpend(deps, config, {
      issue: issueNumber,
      stage: "retro",
      costUsd,
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
      at: startedAt.toISOString(),
    });
    const art = await readStageArtifacts(worktree, issueNumber, "retro");
    deps.state.completeRetro(id, art.json as RetroArtifact | undefined);
  } catch (err) {
    console.error(`retro failed for #${issue.number}:`, err);
    deps.state.completeRetro(id, undefined, "failed");
  }
}

// Drains rows the dashboard's operator-merge route queued but could not run
// itself. Called once per pollOnce tick.
export async function runQueuedRetros(deps: WatchDeps, config: FactoryConfig): Promise<void> {
  for (const row of deps.state.listQueuedRetros(config.repo)) {
    try {
      const issue = await deps.github.getIssue(config.repo, row.issue);
      // The dashboard's merge route queues "merged" after the operator merged the PR.
      if (row.outcome === "merged")
        emitEvent(
          deps.bus,
          "factory.pr.merged",
          { repo: config.repo, issue: row.issue, by: "operator" },
          `issue/${row.issue}`,
        );
      await runRetro(deps, config, issue, row.outcome, row.id);
    } catch (err) {
      console.error(`queued retro failed for #${row.issue}:`, err);
      deps.state.completeRetro(row.id, undefined, "failed");
    }
  }
}

// A stage's JSON, or why it cannot be used: an unknown field is refused, and
// an `outcome` of blocked or failed stops the run where the agent said it did.
export type StepStage = "triage" | "plan" | "build";
export function stageJson<T extends { outcome?: "complete" | "blocked" | "failed"; summary?: string }>(
  stage: StepStage,
  raw: unknown,
  types?: readonly string[],
): { json?: T; problem?: string } {
  if (raw === undefined) return {};
  const checked = validateStepJson(stage, raw, types);
  return checked.ok ? { json: raw as T } : { problem: checked.reason };
}

export async function stopStep(
  deps: WatchDeps,
  config: FactoryConfig,
  issueNumber: number,
  from: string,
  stop: { status: "needs-human" | "failed"; reason: string },
): Promise<Outcome> {
  await moveLabel(deps, config, issueNumber, from, stop.status === "failed" ? LABEL.failed : LABEL.needsHuman);
  finish(deps, config, issueNumber, stop.status, stop.reason);
  return stop.status;
}

export interface RunCtx {
  rejectRound: number;
  questionRound: number;
  // Why the last attempt was sent back, for the rebuild that follows a reject.
  failure?: string;
}

// How much of a failure a rebuild sees: the end of it, where the error is.
export const FAILURE_TAIL_BYTES = 12 * 1024;

export function failureTail(text: string): string {
  const bytes = Buffer.from(text);
  return bytes.length <= FAILURE_TAIL_BYTES
    ? text
    : bytes
        .subarray(bytes.length - FAILURE_TAIL_BYTES)
        .toString()
        .replace(/^\uFFFD+/, "");
}

export const EPOCH = "1970-01-01T00:00:00.000Z";

// Why a daily cap holds back new work now: the one resolver for intake, dispatch and minions, over the
// repo's cap (every worker's spend) and this machine's cap across all its repos.
export type SpendDeps = Pick<WatchDeps, "state" | "spend" | "machine" | "spendPolicy">;
export async function spendCapHit(deps: SpendDeps, config: FactoryConfig): Promise<string | undefined> {
  const repoDailyUsd = config.spend.dailyUsd;
  if (repoDailyUsd !== undefined && (await repoSpendToday(deps, config)).costUsd >= repoDailyUsd)
    return `the repo's daily spend cap ($${repoDailyUsd}) is reached`;
  const machineDailyUsd = deps.machine?.config.dailyUsd;
  if (machineDailyUsd !== undefined && deps.machine!.spend.todayUsd() >= machineDailyUsd)
    return `this machine's daily spend cap ($${machineDailyUsd}) is reached`;
  return deps.spendPolicy?.breached(config.repo, startOfTodayUtc());
}

// The repo's spend today: every worker's, from the shared store when there is one.
export async function repoSpendToday(deps: SpendDeps, config: FactoryConfig): Promise<SpendTotal> {
  return larger(deps.state.spendSummary(config.repo, startOfTodayUtc()), await deps.spend?.since(startOfTodayUtc()));
}

// This machine's own spend is always in SQLite, so a shared store that missed
// a write (an outage, a missing label) can never read lower than it.
function larger(local: SpendTotal, shared: SpendTotal | undefined): SpendTotal {
  if (!shared) return local;
  return {
    costUsd: Math.max(local.costUsd, shared.costUsd),
    unreportedRuns: Math.max(local.unreportedRuns, shared.unreportedRuns),
  };
}

export function startOfTodayUtc(): string {
  return `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`;
}

// Checked before every stage (plan v2.7.0 item 7): an issue's own lifetime
// spend and unreported-run count, this repo's spend today, and — when a
// machine is configured — the whole machine's spend today. The first
// breached cap wins and its message is what parks the issue.
export async function checkSpendCap(
  deps: WatchDeps,
  config: FactoryConfig,
  issueNumber: number,
): Promise<string | undefined> {
  const { perIssueUsd, dailyUsd, maxUnreportedRuns } = config.spend;
  const perIssue = larger(
    deps.state.spendSummary(config.repo, EPOCH, issueNumber),
    await deps.spend?.issue(issueNumber),
  );
  if (perIssueUsd !== undefined && perIssue.costUsd >= perIssueUsd) {
    return `this issue has spent $${perIssue.costUsd.toFixed(2)}, at or over its perIssueUsd cap of $${perIssueUsd.toFixed(2)}`;
  }
  if (maxUnreportedRuns !== undefined && perIssue.unreportedRuns >= maxUnreportedRuns) {
    return `this issue has ${perIssue.unreportedRuns} stage run(s) with unknown cost, at or over the maxUnreportedRuns cap of ${maxUnreportedRuns}`;
  }
  const repoToday = await repoSpendToday(deps, config);
  if (dailyUsd !== undefined && repoToday.costUsd >= dailyUsd) {
    return `${config.repo} has spent $${repoToday.costUsd.toFixed(2)} today, at or over its dailyUsd cap of $${dailyUsd.toFixed(2)}`;
  }
  const machineDailyUsd = deps.machine?.config.dailyUsd;
  const machineToday = deps.machine?.spend.todayUsd() ?? 0;
  if (machineDailyUsd !== undefined && machineToday >= machineDailyUsd)
    return `the machine has spent $${machineToday.toFixed(2)} today, at or over its dailyUsd cap of $${machineDailyUsd.toFixed(2)}`;
  return deps.spendPolicy?.breached(config.repo, startOfTodayUtc());
}
