// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import {
  orchestratorSessions,
  orchestratorStatus,
  setOrchestratorMode,
  subscribeOrchestratorMode,
} from "./orchestratorMode";
import type { OrchestrationRun } from "./orchestrationState";

const run = (status: OrchestrationRun["status"]) =>
  ({ leadId: "lead", status }) as OrchestrationRun;

describe("orchestrator mode", () => {
  it("persists per session and notifies only on change", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeOrchestratorMode(listener);
    setOrchestratorMode("lead", true);
    setOrchestratorMode("lead", true);
    expect(orchestratorSessions().has("lead")).toBe(true);
    expect(
      JSON.parse(localStorage.getItem("monocode.orchestratorSessions")!),
    ).toEqual(["lead"]);
    expect(listener).toHaveBeenCalledOnce();

    const before = orchestratorSessions();
    setOrchestratorMode("lead", false);
    expect(orchestratorSessions()).not.toBe(before);
    expect(orchestratorSessions().has("lead")).toBe(false);
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it("routes by the lead's run, then by the mode", () => {
    expect(orchestratorStatus([run("active")], "lead", false)).toBe("running");
    expect(orchestratorStatus([run("paused")], "lead", true)).toBe("paused");
    expect(orchestratorStatus([run("finished")], "lead", true)).toBe("idle");
    expect(orchestratorStatus([run("stopped")], "lead", false)).toBeUndefined();
    expect(orchestratorStatus([], "lead", true)).toBe("idle");
    expect(orchestratorStatus([run("active")], "other", false)).toBeUndefined();
  });
});
