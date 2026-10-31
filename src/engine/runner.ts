// Walks a workflow from one step until the issue stops: a step parks or
// finishes it, or a park edge hands it to a human. Called for a fresh
// factory:ready pickup, a resume or a retry; `ctx` carries the round counts
// deriveIssueState recovered, so a resumed run doesn't reset the caps.

import { tierToggles } from "../autonomy";
import type { FactoryConfig } from "../config";
import { OPERATOR_TAKEOVER } from "../executor";
import { evalExpr } from "../core/expr";
import type { Edge, Step, Workflow } from "../core/workflow";
import { latestDataFor, PARK_WINDOW, parseDataMarkers } from "../derive";
import type { GhIssue } from "../github";
import { LABEL } from "../labels";
import { McpError } from "../mcp";
import {
  checkSpendCap,
  finish,
  moveLabel,
  OperatorTakeover,
  postComment,
  stopStep,
  type Outcome,
  type RunCtx,
  type WatchDeps,
} from "./common";
import { RuntimeMissing } from "./steps";
import { ALL_STEP_TYPES as STEP_TYPES } from "./registry";
import { emitEvent } from "./bus";
import { readJournal } from "./journal";
import { lateRoute } from "./late-route";
import { holdForOverlap } from "../overlap";
import { guardPlan } from "../plan-guard";
import { unmetDeps } from "../plan-deps";
import { isPlannedBody } from "./import-plan";

// Outcomes that leave the issue waiting on a person; each emits factory.issue.parked.
const PARKED: ReadonlySet<Outcome> = new Set(["needs-info", "needs-human", "awaiting-approval", "failed"]);
// Outcomes where this worker did not run the issue to a stop, so no run ended.
const NOT_A_RUN: ReadonlySet<Outcome> = new Set(["waiting", "lost-claim", "untrusted"]);

export async function runWorkflow(
  deps: WatchDeps,
  config: FactoryConfig,
  workflow: Workflow,
  issue: GhIssue,
  startStep: string,
  worktree: string,
  ctx: RunCtx = { rejectRound: 0, questionRound: 0 },
): Promise<Outcome> {
  if (!workflow.steps[startStep]) throw new Error(`workflow ${workflow.name} has no step "${startStep}"`);
  const at = { step: startStep, workflow };
  const base = () => ({ repo: config.repo, issue: issue.number, workflow: at.workflow.name, sha: at.workflow.sha });
  const subject = `issue/${issue.number}`;
  let outcome: Outcome;
  try {
    outcome = await walk(deps, config, issue, at, worktree, ctx);
  } catch (e) {
    emitEvent(
      deps.bus,
      "factory.step.failed",
      { ...base(), step: at.step, error: e instanceof Error ? e.message : String(e) },
      subject,
    );
    throw e;
  }
  if (PARKED.has(outcome)) emitEvent(deps.bus, "factory.issue.parked", { ...base(), step: at.step, outcome }, subject);
  if (outcome === "shipped" && at.workflow.emit)
    emitEvent(deps.bus, "factory.workflow.emitted", { ...base(), emit: at.workflow.emit }, subject);
  if (!NOT_A_RUN.has(outcome))
    emitEvent(deps.bus, "factory.run.completed", { ...base(), step: at.step, outcome }, subject);
  return outcome;
}

async function walk(
  deps: WatchDeps,
  config: FactoryConfig,
  issue: GhIssue,
  at: { step: string; workflow: Workflow },
  worktree: string,
  ctx: RunCtx,
): Promise<Outcome> {
  let workflow = at.workflow;
  let step: Step = workflow.steps[at.step]!;
  const base = () => ({ repo: config.repo, issue: issue.number, workflow: workflow.name, sha: workflow.sha });
  const subject = `issue/${issue.number}`;
  const issueNumber = issue.number;
  // What `if:` reads: each step's JSON, seeded from the thread so a resumed run sees earlier steps.
  const markers = parseDataMarkers(issue.comments);
  const facts: Record<string, unknown> = {};
  for (const id of Object.keys(workflow.steps)) {
    const seen = latestDataFor(markers, id);
    if (seen !== undefined) facts[id] = seen;
  }
  const scope = async (at: { uses?: string }) => ({
    ...facts,
    toggles: {
      autoApproveLowRisk: deps.state.getToggle("auto_approve_low_risk", config.riskPolicy.autoApproveLowRisk),
      ...(at.uses === "plan"
        ? await tierToggles(
            deps.github,
            config.repo,
            config.merge,
            (facts.plan as { risk?: unknown } | undefined)?.risk,
          )
        : { tiered: false, tierApproves: false }),
    },
    config,
  });
  // Steps the journal shows finished are not run again; a park edge is passed only once its token was approved.
  const journal = readJournal(deps.state, issueNumber, workflow);
  const held = step.label;
  for (let done = journal.finished.get(step.id); done?.result === "next"; done = journal.finished.get(step.id)) {
    if (done.facts !== undefined) facts[step.id] = done.facts;
    const edge = pickEdge(step.next, await scope(step));
    if ("park" in edge && !journal.approved.has(step.id)) break;
    step = workflow.steps["park" in edge ? edge.approve : edge.to]!;
  }
  if (step.label !== held) await moveLabel(deps, config, issueNumber, held, step.label);

  // A fresh planned run (the issue body or an operator-passed spec) is read before any step runs.
  if (journal.finished.size === 0 && isPlannedBody(issue.body ?? "")) {
    const plain = guardPlan(issue.body ?? "", config);
    const unmet = plain.ok ? await unmetDeps(issue.body ?? "", deps.github, config.repo, worktree) : [];
    const guard = unmet.length ? { ok: false as const, reasons: unmet } : plain;
    if (!guard.ok) {
      await postComment(
        deps,
        config,
        issueNumber,
        ["Refused: the planned body is not a plan yet.", "", ...guard.reasons.map((r) => `- ${r}`)].join("\n"),
        { stage: "plan-guard", json: { ok: false, reasons: guard.reasons } },
      );
      return await stopStep(deps, config, issueNumber, step.label, {
        status: "needs-human",
        reason: `plan guard: ${guard.reasons.length} reason(s)`,
      });
    }
  }

  // A fresh run proves it can push before any step spends: a refusal stops it with the plain reason.
  if (journal.finished.size === 0 && deps.pushProbe) {
    const probe = await deps.pushProbe(worktree, `issue-${issueNumber}-${Date.now()}`);
    if (!probe.ok) {
      await postComment(
        deps,
        config,
        issueNumber,
        `Stopped before any work: this session cannot push (${probe.reason}). Fix the access and \`/factory retry\`.`,
        { stage: "push-probe", json: { ok: false, reason: probe.reason } },
      );
      return await stopStep(deps, config, issueNumber, step.label, {
        status: "needs-human",
        reason: `push probe: ${probe.reason}`,
      });
    }
  }

  try {
    for (;;) {
      // The lease lapsed and another worker may hold it now: stop here, between steps, with the label as it is.
      if (deps.leases?.held.get(issueNumber)?.lost) return "waiting";
      const overBudget = await checkSpendCap(deps, config, issueNumber);
      if (overBudget) {
        // The amounts are operator detail: the inbox and the hidden marker carry them, the visible text does not.
        await postComment(
          deps,
          config,
          issueNumber,
          "Parked: a spend cap is reached. An operator can raise it and `/factory retry`.",
          { stage: "budget", json: { reason: overBudget } },
        );
        return await stopStep(deps, config, issueNumber, step.label, { status: "needs-human", reason: overBudget });
      }
      at.step = step.id;
      emitEvent(deps.bus, "factory.step.started", { ...base(), step: step.id, uses: step.uses }, subject);
      const result = await STEP_TYPES[step.uses]!.run({ deps, config, issue, worktree, ctx, step, workflow });
      if (result.kind === "stop" && result.outcome === "failed")
        emitEvent(deps.bus, "factory.step.failed", { ...base(), step: step.id, outcome: result.outcome }, subject);
      else
        emitEvent(
          deps.bus,
          "factory.step.completed",
          {
            ...base(),
            step: step.id,
            result: result.kind === "stop" ? result.outcome : result.kind,
            ...(result.kind === "next" && result.facts !== undefined ? { facts: result.facts } : {}),
          },
          subject,
        );
      if (result.kind === "stop") return result.outcome;
      if (result.kind === "reject") {
        const back: Step = workflow.steps[step.reject!]!;
        await moveLabel(deps, config, issueNumber, step.label, back.label);
        step = back;
        continue;
      }
      if (result.facts !== undefined) facts[step.id] = result.facts;
      const from = step.label;
      const routed = step.uses === "triage" ? await lateRoute(deps, config, workflow, issue, result.facts) : undefined;
      if (routed) {
        workflow = at.workflow = routed.workflow;
        step = routed.step;
        facts[step.id] = result.facts;
      }
      const edge = pickEdge(step.next, await scope(step));
      if ("park" in edge) {
        await moveLabel(deps, config, issueNumber, from, LABEL.awaitingApproval);
        const token = crypto.randomUUID();
        emitEvent(deps.bus, "factory.approval.requested", { ...base(), step: step.id, token }, subject);
        if (edge.after) {
          const at = new Date((deps.now?.() ?? new Date()).getTime() + edge.after).toISOString();
          await postComment(
            deps,
            config,
            issueNumber,
            `This goes on to ${edge.approve} by itself at ${at} unless a maintainer comments first. \`/factory approve\` goes now; any other comment holds it for a person.`,
            { stage: PARK_WINDOW, json: { step: step.id } },
          );
        }
        finish(deps, config, issueNumber, "awaiting-approval");
        return "awaiting-approval";
      }
      const to: Step = workflow.steps[edge.to]!;
      if (step.uses === "plan" && to.uses === "build") {
        const files = (facts.plan as { files?: string[] } | undefined)?.files ?? [];
        if (await holdForOverlap(deps, config, issueNumber, files, from)) return "awaiting-approval";
      }
      await moveLabel(deps, config, issueNumber, from, to.label);
      step = to;
    }
  } catch (e) {
    if (e instanceof McpError || e instanceof RuntimeMissing)
      emitEvent(deps.bus, "factory.step.failed", { ...base(), step: step.id, error: e.message }, subject);
    if (e instanceof McpError) {
      // A server the step names is not in the base branch's .factory/mcp.json: nothing ran, so a retry after the fix is free.
      await postComment(
        deps,
        config,
        issueNumber,
        `Stopped before ${step.id}: ${e.message}. Add it to .factory/mcp.json or drop it from the step, then \`/factory retry\`.`,
        { stage: "mcp", json: { step: step.id, problem: e.message } },
      );
      return await stopStep(deps, config, issueNumber, step.label, { status: "failed", reason: e.message });
    }
    if (e instanceof RuntimeMissing) {
      await postComment(
        deps,
        config,
        issueNumber,
        `Stopped before ${step.id}: ${e.message}. Add it to FACTORY_HOME/machine.json runtimes or drop it from the step, then \`/factory retry\`.`,
        { stage: "runtime", json: { step: step.id, problem: e.message } },
      );
      return await stopStep(deps, config, issueNumber, step.label, { status: "failed", reason: e.message });
    }
    if (!(e instanceof OperatorTakeover)) throw e;
    // Not a failure and not a retry: the operator owns the session now, and
    // `/factory retry` (or `factory takeover`'s hand-back) re-enters this step.
    await moveLabel(deps, config, issueNumber, step.label, LABEL.needsHuman);
    await postComment(
      deps,
      config,
      issueNumber,
      `Taken over by an operator during ${step.id}. Comment \`/factory retry\` to hand it back; the factory resumes at ${step.id} with whatever is in the worktree.`,
      { stage: "takeover", json: { stage: step.id } },
    );
    finish(deps, config, issueNumber, "needs-human", OPERATOR_TAKEOVER);
    return "needs-human";
  }
}

// The first edge whose `if:` holds; parseWorkflow guarantees the last has none.
function pickEdge(edges: readonly Edge[], scope: Readonly<Record<string, unknown>>): Edge {
  return edges.find((e) => !e.if || Boolean(evalExpr(e.if, scope)))!;
}

// The park edge of the step an issue awaiting approval parked on, for /factory approve and revise.
export function parkEdgeOf(workflow: Workflow, stepId: string): Extract<Edge, { park: string }> | undefined {
  return workflow.steps[stepId]?.next.find((e): e is Extract<Edge, { park: string }> => "park" in e);
}
