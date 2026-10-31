import { describe, expect, test } from "bun:test";
import { parseAgentStatus, reduceStatus } from "../src/agent-status";

const ok = (text: string) => {
  const r = parseAgentStatus(text, "build", 100);
  if (!r.ok) throw new Error(r.error);
  return r.report;
};
const err = (text: string) => {
  const r = parseAgentStatus(text, "build", 100);
  if (r.ok) throw new Error("expected a parse error");
  return r.error;
};

describe("parseAgentStatus", () => {
  test("accepts each of the four states", () => {
    expect(ok('{"state":"working"}')).toEqual({ step: "build", state: "working", at: 100 });
    expect(ok('{"state":"done"}').state).toBe("done");
    expect(ok('{"state":"blocked","reason":" need a key "}')).toEqual({
      step: "build",
      state: "blocked",
      reason: "need a key",
      at: 100,
    });
    expect(ok('{"state":"error","reason":"tests crash"}').state).toBe("error");
  });

  test("blocked and error need a reason", () => {
    expect(err('{"state":"blocked"}')).toBe("blocked needs a reason");
    expect(err('{"state":"error","reason":"  "}')).toBe("error needs a reason");
  });

  test("rejects bad input", () => {
    expect(err("nope")).toBe("status is not JSON");
    expect(err("[1]")).toBe("status must be a JSON object");
    expect(err('{"state":"idle"}')).toBe("state must be one of working, blocked, done, error");
    expect(err('{"state":"done","reason":3}')).toBe("reason must be a string");
  });
});

describe("reduceStatus", () => {
  const r = (step: string, state: "working" | "blocked" | "done" | "error", at: number, reason?: string) => ({
    step,
    state,
    at,
    ...(reason ? { reason } : {}),
  });

  test("keeps the latest report per step", () => {
    const out = reduceStatus(
      [r("a", "working", 10), r("a", "blocked", 20, "waiting on a human"), r("a", "working", 5)],
      ["a"],
      30,
      1000,
    );
    expect(out).toEqual([{ step: "a", state: "blocked", reason: "waiting on a human", at: 20 }]);
  });

  test("a blocked step shows blocked, not working", () => {
    const [s] = reduceStatus([r("a", "blocked", 1, "needs review")], ["a"], 10_000_000, 1000);
    expect(s).toEqual({ step: "a", state: "blocked", reason: "needs review", at: 1 });
  });

  test("a silent working step is unknown past its timeout, working before it", () => {
    const reports = [r("a", "working", 100)];
    expect(reduceStatus(reports, ["a"], 1100, 1000)).toEqual([{ step: "a", state: "working", at: 100 }]);
    expect(reduceStatus(reports, ["a"], 1101, 1000)).toEqual([{ step: "a", state: "unknown", at: 100 }]);
  });

  test("a step that never reported is unknown; extra reports are ignored", () => {
    expect(reduceStatus([r("x", "done", 1)], ["a"], 5, 1000)).toEqual([{ step: "a", state: "unknown" }]);
  });
});
