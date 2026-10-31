// Ported from owainlewis/machinist@3943516 internal/runner/runner.go:190-240 (MIT, Copyright (c) 2026 Owain Lewis). Deviations: the process-group kill is process_unix.go, and TypeScript on Bun (`detached` is setsid); the event cap and 1 MiB line cap follow events.go and codex_usage.go; the tool-call cap and stderr tail are the factory's own (audit finding #15).
// The one executor: spawn an agent CLI, feed the prompt, parse its output, kill the process group on timeout or runaway tool calls.

import { crossModel } from "../review-models";
import { tierFor } from "../core/model-tier";
import { DEFAULT_AGENT } from "./default";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { JSON_FILENAMES, runDir } from "../artifacts";
import type { RouteConfig } from "../config";
import { buildContextPack } from "../context";
import {
  aggregateStageEvents,
  OPERATOR_TAKEOVER,
  type Executor,
  type StageEvent,
  type StageRunOptions,
  type StageRunResult,
} from "../executor";
import { plain } from "../display";
import { streamPath, takeoverMarker } from "../paths";
import { McpError } from "../mcp";
import { gatewaySanitizedEnv, sanitizeEnv } from "./env";
import { gatewayHost, type LlmGateway, mintStageKey, revokeKey } from "./gateway";
import { renderPrompt } from "./prompt";
import { provideDefaults } from "../harness-defaults";
import { PRESETS } from "./presets";
import { structuredCommand } from "./structured";
import { replySchema, stageSchema } from "../schemas";
import { typesFor } from "../labels";
import { writeReply } from "./reply";
import type { FixtureRecorder } from "./record";
import { type AgentConfig, type AgentPreset, type StageAgents, stagePolicy } from "./types";
import { portEnv } from "../port";
import { guestGit } from "../adapters/microsandbox/execution";
import { type AgentSandbox, forGateway, removeSandbox, sandboxArgv } from "./agent-sandbox";

const DEFAULT_TIMEOUT_MINUTES = 15;
const STDERR_KEEP_BYTES = 64 * 1024;
export const MAX_ARG_BYTES = 120 * 1024;
// What the stop-artifact hook checks: only the stages whose file watch.ts requires and
// validates (pr and retro owe none), and a stopped verify owes nothing but its outcome.
export function stopArtifactSpec(
  stage: StageRunOptions["stage"],
  types: readonly string[],
): Record<string, unknown> | undefined {
  if (stage !== "triage" && stage !== "plan" && stage !== "build" && stage !== "verify") return undefined;
  return { file: JSON_FILENAMES[stage], schema: stageSchema(stage, types), stoppedOwesOnlyOutcome: stage === "verify" };
}

export const MAX_EVENT_LINE_BYTES = 1 << 20;
export const MAX_RECORDED_OUTPUT_BYTES = 64 << 20;

// One transcript line per event, the same text `factory logs` prints. A path inside the stage's
// worktree prints relative to it: the watcher reads src/csv.ts, never the operator's home folder.
// The 90 character cap applies after, so a long command keeps its tail, not the absolute prefix.
export function renderEvent(e: StageEvent, cwd?: string): string | undefined {
  if (e.kind === "tool_use") {
    const rel = e.toolTarget && cwd ? e.toolTarget.split(`${cwd}/`).join("") : e.toolTarget;
    const target = rel && rel.length > 90 ? `${rel.slice(0, 89)}…` : rel;
    return `> ${e.toolName ?? "tool"}${target ? ` ${plain(target)}` : ""}`;
  }
  if (e.kind === "text" || e.kind === "truncated") return e.text ? plain(e.text) : undefined;
  if (e.kind === "session") return `session ${e.sessionId}`;
  if (e.kind === "startup_error") return `startup error: ${plain(e.text ?? "")}`;
  // One "denied" line per refused call, so scripts/e2e-score.ts can count them.
  if (e.kind === "result")
    return [
      `result ${e.text ?? ""}${e.costUsd === undefined ? "" : ` $${e.costUsd.toFixed(3)}`}`.trim(),
      ...(e.denials ?? []).map((d) => `denied ${plain(d)}`),
    ].join("\n");
  return undefined;
}

// Best effort: a full disk or a removed directory never fails a stage.
function append(file: string | undefined, text: string): void {
  if (!file) return;
  try {
    appendFileSync(file, text);
  } catch {}
}

export interface ResolvedAgent {
  readonly name: string;
  readonly config: AgentConfig;
  readonly preset?: AgentPreset;
}

// `routes[type].stages[stage]`, then `stages[stage]`, then `stages.default`,
// then "claude" (plan v2.7.0 item 1). Triage runs before the type is known,
// so it always uses `stages.triage` regardless of what `type` is passed.
export function resolveRoute(
  agents: Record<string, AgentConfig>,
  stages: StageAgents,
  routes: Readonly<Record<string, RouteConfig>> | undefined,
  stage: keyof StageAgents & string,
  type: string | undefined,
): ResolvedAgent {
  const routed = stage !== "triage" && type ? routes?.[type]?.stages?.[stage] : undefined;
  const name = routed ?? stages[stage] ?? stages.default ?? DEFAULT_AGENT;
  return resolveAgentByName(agents, name, stage);
}

export function resolveAgent(
  agents: Record<string, AgentConfig>,
  stages: StageAgents,
  stage: keyof StageAgents & string,
): ResolvedAgent {
  return resolveRoute(agents, stages, undefined, stage, undefined);
}

export function resolveAgentByName(agents: Record<string, AgentConfig>, name: string, stage: string): ResolvedAgent {
  const config = agents[name];
  if (!config) throw new Error(`stage ${stage} uses agent "${name}", which is not in config.agents`);
  const preset = config.preset ? PRESETS[config.preset] : undefined;
  if (config.preset && !preset) throw new Error(`agent "${name}": unknown preset "${config.preset}"`);
  // A bare `codex exec` or `claude -p` command still gets its JSON flag and parser.
  const found = !preset && config.command ? structuredCommand(name, config.command) : undefined;
  if (found) return { name, config: { ...config, command: found.command }, preset: PRESETS[found.preset] };
  return { name, config, preset };
}

// The agent with `model` swapped for its tier's, so every preset and {{model}} see one model.
function withTier(agent: ResolvedAgent, opts: Pick<StageRunOptions, "scope" | "rejects" | "model">): ResolvedAgent {
  if (opts.model && agent.preset?.name === "claude")
    return { ...agent, config: { ...agent.config, model: opts.model } };
  const tier = tierFor(opts.scope, opts.rejects);
  const model = tier && agent.config.models?.[tier];
  return model ? { ...agent, config: { ...agent.config, model } } : agent;
}

// Placeholders in a config command. Anything else is passed through verbatim.
export function renderCommand(
  command: readonly string[],
  values: { prompt: string; promptFile: string; model: string },
): { argv: string[]; usesStdin: boolean } {
  let usesStdin = true;
  const argv = command.map((part) =>
    part.replace(/\{\{(prompt|promptFile|model)\}\}/g, (_m, key: "prompt" | "promptFile" | "model") => {
      if (key !== "model") usesStdin = false;
      return values[key];
    }),
  );
  return { argv, usesStdin };
}

export class CommandExecutor implements Executor {
  constructor(
    private readonly agents: Record<string, AgentConfig>,
    private readonly stages: StageAgents,
    private readonly routes: Readonly<Record<string, RouteConfig>> = {},
    private readonly recorder?: FixtureRecorder,
    // machine.json `agentRuntime`: every agent this executor starts runs in this microVM or container.
    private readonly vm?: AgentSandbox,
    // machine.json `llmGateway`: every stage run gets its own key, capped at its maxBudgetUsd.
    private readonly gateway?: LlmGateway,
    // The env vars the runner's own tracker and runtime keys live in (tokenEnvNames); no agent sees them.
    private readonly secretEnv: readonly string[] = [],
  ) {}

  async runStage(opts: StageRunOptions): Promise<StageRunResult> {
    const route = (s: StageRunOptions["stage"]) =>
      withTier(resolveRoute(this.agents, this.stages, this.routes, s, opts.type), opts);
    const agent = opts.agent
      ? withTier(resolveAgentByName(this.agents, opts.agent, opts.stage), { model: opts.model })
      : crossModel(route(opts.stage), opts.stage === "verify" ? route("build") : undefined, opts.reviewer);
    if (this.gateway && !agent.preset?.gateway) {
      const able = Object.values(PRESETS)
        .filter((p) => p.gateway)
        .map((p) => p.name);
      throw new Error(
        `${agent.name}: machine.json names an llmGateway, and only these presets can call through one: ${able.join(", ")}`,
      );
    }
    const key =
      this.gateway &&
      (await mintStageKey(this.gateway, {
        maxBudgetUsd: opts.maxBudgetUsd,
        timeoutMinutes: opts.timeoutMinutes ?? DEFAULT_TIMEOUT_MINUTES,
        issue: opts.issue,
        stage: opts.stage,
      }));
    const scratch = mkdtempSync(join(tmpdir(), `factory-scratch-${opts.issue}-`));
    try {
      return await this.spawnStage(opts, agent, scratch, key);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
      if (opts.liveFile) rmSync(opts.liveFile, { force: true });
      if (this.gateway && key) await revokeKey(this.gateway, key);
    }
  }

  private async spawnStage(
    opts: StageRunOptions,
    agent: ResolvedAgent,
    scratch: string,
    key?: string,
  ): Promise<StageRunResult> {
    const artifactDir = join(opts.cwd, runDir(opts.issue));
    mkdirSync(artifactDir, { recursive: true });
    provideDefaults(opts.cwd, agent.preset?.skillsDir);

    const ownCommand = agent.config.command !== undefined && !agent.preset?.wrapsCommand;
    // A read-only stage on a preset that cannot write returns its file instead; a minion owes none.
    const readOnly =
      opts.prompt === undefined &&
      !stagePolicy(opts.stage).write &&
      agent.preset?.returnsArtifact === true &&
      !ownCommand;
    let argv: readonly string[];
    let stdin: string | undefined;
    const types = typesFor(this.routes);
    // The stop-artifact hook checks the stage's file against this before the agent stops.
    const spec = readOnly || opts.prompt !== undefined ? undefined : stopArtifactSpec(opts.stage, types);
    if (spec) writeFileSync(join(scratch, "artifact.schema.json"), JSON.stringify(spec));
    // A step that asked for MCP servers must get them, so an agent that cannot load them is an error, not a quiet run without.
    let mcpConfig: string | undefined;
    if (opts.mcp && Object.keys(opts.mcp).length > 0) {
      if (!agent.preset?.mcp || ownCommand)
        throw new McpError(
          `${agent.name}: this step names MCP servers (${Object.keys(opts.mcp).join(", ")}), and only the claude preset can load them`,
        );
      mcpConfig = join(scratch, "mcp.json");
      writeFileSync(mcpConfig, JSON.stringify({ mcpServers: opts.mcp }));
    }
    const skills = opts.type ? (this.routes[opts.type]?.skills ?? []) : [];
    const contextPack =
      opts.prompt !== undefined
        ? ""
        : await buildContextPack(opts.stage, opts.issue, opts.cwd, {
            skills,
            contextFile: agent.preset?.contextFile,
            skillsDir: agent.preset?.skillsDir,
          });
    const reply = agent.config.outputSchema && (spec || readOnly) ? join(scratch, "reply.schema.json") : undefined;
    if (reply) writeFileSync(reply, JSON.stringify(replySchema(opts.stage, types)));
    if (agent.preset?.ownsPrompt) {
      ({ argv, stdin } = agent.preset.command(opts, agent.config, contextPack, { mcpConfig, schemaFile: reply }));
    } else {
      const prompt = opts.prompt ?? (await renderPrompt(opts, readOnly, types, contextPack));
      if (ownCommand && agent.config.command) {
        const promptFile = join(scratch, "prompt.md");
        writeFileSync(promptFile, prompt);
        const rendered = renderCommand(agent.config.command, { prompt, promptFile, model: agent.config.model ?? "" });
        argv = rendered.argv;
        stdin = rendered.usesStdin ? prompt : undefined;
      } else if (agent.preset) {
        ({ argv, stdin } = agent.preset.command(opts, agent.config, prompt, { schemaFile: spec ? undefined : reply }));
      } else {
        throw new Error(`agent "${agent.name}" has neither a preset nor a command`);
      }
    }

    // Linux caps one argument at 128 KiB; past that spawn fails with E2BIG and no hint.
    const big = argv.find((a) => Buffer.byteLength(a) > MAX_ARG_BYTES);
    if (big !== undefined)
      throw new Error(
        `${agent.name}: the prompt is passed as an argument and is ${Buffer.byteLength(big)} bytes, over the ${MAX_ARG_BYTES} byte limit; configure a stdin agent or shorten the issue`,
      );

    if (opts.transcriptFile) mkdirSync(dirname(opts.transcriptFile), { recursive: true });
    append(opts.transcriptFile, `\n=== ${opts.stage} #${opts.issue} ${new Date().toISOString()} (${agent.name}) ===\n`);
    const streamFile = opts.transcriptFile ? streamPath(opts.transcriptFile) : undefined;
    let streamed = 0;
    append(
      streamFile,
      `${JSON.stringify({ type: "factory_stage", stage: opts.stage, issue: opts.issue, at: new Date().toISOString(), agent: agent.name })}\n`,
    );
    const marker = opts.liveFile ? takeoverMarker(opts.liveFile) : undefined;
    if (marker) rmSync(marker, { force: true });

    const stageEnv: Record<string, string> = {
      ...agent.preset?.env,
      FACTORY_ARTIFACT_DIR: artifactDir,
      FACTORY_ISSUE: String(opts.issue),
      FACTORY_STAGE: opts.stage,
      FACTORY_SCRATCH_DIR: scratch,
      FACTORY_HIDDEN_PATHS: (opts.hiddenPaths ?? []).join("\n"),
      ...portEnv(opts.cwd),
    };
    // Through a gateway the agent holds only its stage key: no provider key is passed on, in a VM or not.
    const via = key && this.gateway ? agent.preset?.gateway : undefined;
    const gatewayUrl = via ? { [via.baseUrl]: `${this.gateway!.url.replace(/\/$/, "")}${via.path ?? ""}` } : {};
    const vm = via && this.vm ? forGateway(this.vm) : this.vm;
    // In a VM the guest gets only stageEnv; msb reads the keys it injects from its own env.
    const vmName = vm && `factory-${opts.stage}-${opts.issue}-${crypto.randomUUID()}`;
    if (vm && stdin !== undefined) writeFileSync(join(scratch, "stdin"), stdin);
    const guestEnv = vm
      ? { ...stageEnv, ...gatewayUrl, ...guestGit(opts.cwd, scratch, opts.hiddenPaths ?? []) }
      : stageEnv;
    const proc = Bun.spawn(
      vm && vmName
        ? sandboxArgv(vm, {
            argv,
            cwd: opts.cwd,
            mounts: [scratch],
            env: guestEnv,
            stdinFile: stdin === undefined ? undefined : join(scratch, "stdin"),
            name: vmName,
            readOnly,
            forward: via ? [] : agent.preset?.envKeys,
            ...(via ? { secrets: [`${via.key}@${gatewayHost(this.gateway!)}`] } : {}),
          })
        : [...argv],
      {
        cwd: opts.cwd,
        stdin: stdin === undefined || this.vm ? "ignore" : new Blob([stdin]),
        stdout: "pipe",
        stderr: "pipe",
        detached: true, // its own process group, so a kill reaches the agent's children too
        env: {
          ...(via
            ? gatewaySanitizedEnv(process.env, this.secretEnv)
            : sanitizeEnv(process.env, agent.preset?.envKeys, this.secretEnv)),
          ...stageEnv,
          ...gatewayUrl,
          ...(via && key ? { [via.key]: key } : {}),
        },
      },
    );
    let sessionId: string | undefined;
    const writeLive = () => {
      if (!opts.liveFile) return;
      mkdirSync(dirname(opts.liveFile), { recursive: true });
      writeFileSync(
        opts.liveFile,
        JSON.stringify({
          pid: proc.pid,
          issue: opts.issue,
          stage: opts.stage,
          agent: agent.name,
          sessionId,
          transcriptFile: opts.transcriptFile,
        }),
      );
    };
    writeLive();
    let cancelRead: (() => void) | undefined;
    const killGroup = () => {
      // ESRCH means it already exited; that is the goal.
      try {
        process.kill(-proc.pid, "SIGKILL");
      } catch {
        proc.kill();
      }
      if (vm && vmName) removeSandbox(vm, vmName);
      // A descendant that left the group (setsid) can still hold the pipe open:
      // give the reader a moment to drain, then stop waiting for it.
      setTimeout(() => cancelRead?.(), 2000).unref();
    };
    const events: StageEvent[] = [];
    let toolCalls = 0;
    let killedReason: string | undefined;
    let usageComplete = agent.preset !== undefined;
    let recorded = 0;
    // Read alongside stdout, not after: an unread pipe can fill its OS buffer
    // and stall the child, and launch-time errors go to stderr only.
    const errReader = proc.stderr.getReader();
    const stderrPromise = (async () => {
      const dec = new TextDecoder();
      let text = "";
      for (;;) {
        const { done, value } = await errReader.read().catch(() => ({ done: true, value: undefined }));
        if (done) return text + dec.decode();
        text = (text + dec.decode(value, { stream: true })).slice(-STDERR_KEEP_BYTES);
      }
    })();

    const timeoutMinutes = opts.timeoutMinutes ?? DEFAULT_TIMEOUT_MINUTES;
    const timer = setTimeout(() => {
      killedReason = `stage exceeded stageTimeoutMinutes=${timeoutMinutes}`;
      killGroup();
    }, timeoutMinutes * 60_000);

    // A preset whose events span lines gets a fresh parser per stage run.
    const parseLine = agent.preset?.newParser?.() ?? agent.preset?.parseLine;
    const handle = (line: string) => {
      this.recorder?.line(opts.stage, line);
      // The live window's copy, raw so it keeps diffs and command output; `factory view` strips escapes.
      if (
        Buffer.byteLength(line) <= MAX_EVENT_LINE_BYTES &&
        (streamed += Buffer.byteLength(line)) <= MAX_RECORDED_OUTPUT_BYTES
      )
        append(streamFile, `${line}\n`);
      if (!agent.preset || !parseLine) {
        // No parser means no events: the window shows the raw output instead, under the same cap.
        recorded += Buffer.byteLength(line);
        if (recorded <= MAX_RECORDED_OUTPUT_BYTES) append(opts.transcriptFile, `${plain(line)}\n`);
        return;
      }
      if (Buffer.byteLength(line) > MAX_EVENT_LINE_BYTES) {
        // Dropped, not parsed; if it was the terminal usage event the count is gone.
        if (agent.preset.isUsageCandidate(line.slice(0, 4096))) usageComplete = false;
        return;
      }
      for (const e of parseLine(line)) {
        if (e.sessionId && e.sessionId !== sessionId) {
          sessionId = e.sessionId;
          writeLive();
        }
        recorded += Buffer.byteLength(e.text ?? "");
        if (recorded > MAX_RECORDED_OUTPUT_BYTES) {
          if (events.at(-1)?.kind !== "truncated") {
            events.push({
              kind: "truncated",
              text: `recording stopped after ${MAX_RECORDED_OUTPUT_BYTES} output bytes; the agent keeps running`,
            });
            append(opts.transcriptFile, `${events.at(-1)!.text}\n`);
          }
        } else {
          events.push(e);
          const line = renderEvent(e, opts.cwd);
          if (line !== undefined) append(opts.transcriptFile, `${line}\n`);
        }
        // Running on without the MCP servers or plugins it was configured with gives a wrong result, not a slower one.
        if (e.kind === "startup_error" && !killedReason) {
          killedReason = `agent startup failed: ${e.text}`;
          killGroup();
        }
        if (e.kind !== "tool_use") continue;
        toolCalls += 1;
        if (opts.maxToolCalls && toolCalls > opts.maxToolCalls && !killedReason) {
          killedReason = `stage exceeded maxToolCalls=${opts.maxToolCalls}`;
          killGroup();
        }
      }
    };

    try {
      const reader = proc.stdout.getReader();
      cancelRead = () => {
        void reader.cancel().catch(() => {});
        void errReader.cancel().catch(() => {});
      };
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) handle(line);
        // An unterminated line past the cap is dropped now, not buffered without bound.
        if (buffer.length > MAX_EVENT_LINE_BYTES) {
          if (agent.preset?.isUsageCandidate(buffer.slice(0, 4096))) usageComplete = false;
          buffer = "";
        }
      }
      if (buffer.trim()) handle(buffer);
    } finally {
      clearTimeout(timer);
    }

    const [exitCode, stderr] = await Promise.all([proc.exited, stderrPromise]);
    if (opts.liveFile) rmSync(opts.liveFile, { force: true });
    if (marker && existsSync(marker)) {
      killedReason = OPERATOR_TAKEOVER;
      rmSync(marker, { force: true });
    }
    append(opts.transcriptFile, `=== ${opts.stage} exit ${exitCode}${killedReason ? ` (${killedReason})` : ""} ===\n`);
    append(
      streamFile,
      `${JSON.stringify({ type: "factory_exit", stage: opts.stage, code: exitCode, ...(killedReason ? { reason: killedReason } : {}) })}\n`,
    );
    const stderrTail = stderr.trim().slice(-4000) || undefined;
    const base0 = aggregateStageEvents(events, exitCode, stderrTail);
    const base = {
      ...base0,
      agent: agent.name,
      model: agent.config.model ?? null,
      usageComplete: usageComplete && base0.usageComplete !== false,
    };
    if (readOnly && exitCode === 0 && !killedReason) {
      const problem = await writeReply(opts.cwd, opts.issue, opts.stage, base.finalMessage);
      // No file is left behind, so the runner reports "no valid <stage>.json".
      if (problem) base.events.push({ kind: "text", text: `read-only reply rejected: ${problem}` });
    }
    return killedReason ? { ...base, exitCode: exitCode || 1, killedReason } : base;
  }
}
