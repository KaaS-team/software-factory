import type { AgentPreset } from "./types";

export const DEFAULT_AGENT = "claude";

/** The one place that falls back to claude's skills directory. */
export function skillsDirFor(preset?: AgentPreset): string {
  return preset?.skillsDir ?? ".claude/skills";
}
