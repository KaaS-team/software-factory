// What an agent step says it is doing: working, blocked, done or error. The agent
// writes one JSON object (a status file or line); this parses it and reduces a
// list of reports to the latest state per step. A step that reports working and
// then goes silent past its timeout reads as unknown, never as working. Pure:
// no clock, no I/O; the caller passes `now`.

export const AGENT_STATES = ["working", "blocked", "done", "error"] as const;
export type AgentState = (typeof AGENT_STATES)[number];
export type ShownState = AgentState | "unknown";

export interface AgentReport {
  readonly step: string;
  readonly state: AgentState;
  readonly reason?: string;
  readonly at: number;
}

export type ParseResult =
  | { readonly ok: true; readonly report: AgentReport }
  | { readonly ok: false; readonly error: string };

const NEEDS_REASON: ReadonlySet<AgentState> = new Set(["blocked", "error"]);

export function parseAgentStatus(text: string, step: string, at: number): ParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: "status is not JSON" };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, error: "status must be a JSON object" };
  }
  const { state, reason } = raw as { state?: unknown; reason?: unknown };
  const known = AGENT_STATES.find((s) => s === state);
  if (known === undefined) {
    return { ok: false, error: `state must be one of ${AGENT_STATES.join(", ")}` };
  }
  const why = typeof reason === "string" ? reason.trim() : "";
  if (reason !== undefined && typeof reason !== "string") {
    return { ok: false, error: "reason must be a string" };
  }
  if (NEEDS_REASON.has(known) && why === "") {
    return { ok: false, error: `${known} needs a reason` };
  }
  return { ok: true, report: { step, state: known, ...(why ? { reason: why } : {}), at } };
}

export interface StepStatus {
  readonly step: string;
  readonly state: ShownState;
  readonly reason?: string;
  readonly at?: number;
}

// Latest report per step (by `at`, later input wins a tie). `steps` lists the
// steps to show, so one that never reported is unknown. A working report older
// than timeoutMs is unknown; blocked, done and error are answers, so they stay.
export function reduceStatus(
  reports: readonly AgentReport[],
  steps: readonly string[],
  now: number,
  timeoutMs: number,
): StepStatus[] {
  const latest = new Map<string, AgentReport>();
  for (const r of reports) {
    const prev = latest.get(r.step);
    if (prev === undefined || r.at >= prev.at) latest.set(r.step, r);
  }
  return steps.map((step): StepStatus => {
    const r = latest.get(step);
    if (r === undefined) return { step, state: "unknown" };
    if (r.state === "working" && now - r.at > timeoutMs) {
      return { step, state: "unknown", at: r.at };
    }
    return { step, state: r.state, ...(r.reason ? { reason: r.reason } : {}), at: r.at };
  });
}
