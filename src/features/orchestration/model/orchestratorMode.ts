import type { OrchestrationRun } from "./orchestrationState";

const KEY = "monocode.orchestratorSessions";

/**
 * How an Orchestrator-mode session routes its next message. "idle" asks the
 * lead for a new proposal; "running" and "paused" are follow-ups to the lead
 * of an active run, which already has its control access.
 */
export type OrchestratorStatus = "idle" | "running" | "paused";

const listeners = new Set<() => void>();
let cache: ReadonlySet<string> | undefined;

function load(): ReadonlySet<string> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return new Set(
      Array.isArray(parsed)
        ? parsed.filter((id): id is string => typeof id === "string")
        : [],
    );
  } catch {
    return new Set();
  }
}

/** Sessions with Orchestrator mode on. Stable until the next change. */
export function orchestratorSessions(): ReadonlySet<string> {
  cache ??= load();
  return cache;
}

export function setOrchestratorMode(sessionId: string, on: boolean) {
  const current = orchestratorSessions();
  if (current.has(sessionId) === on) return;
  const next = new Set(current);
  if (on) next.add(sessionId);
  else next.delete(sessionId);
  cache = next;
  try {
    localStorage.setItem(KEY, JSON.stringify([...next]));
  } catch {
    // Keep the in-memory mode when storage is unavailable.
  }
  for (const listener of listeners) listener();
}

export function subscribeOrchestratorMode(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * An active or paused run always shows its state, even for a lead confirmed
 * before Orchestrator mode was sticky. Otherwise the session is an
 * orchestrator only while its mode is on.
 */
export function orchestratorStatus(
  runs: readonly OrchestrationRun[],
  sessionId: string,
  modeOn: boolean,
): OrchestratorStatus | undefined {
  const run = runs.find((entry) => entry.leadId === sessionId);
  if (run?.status === "active") return "running";
  if (run?.status === "paused") return "paused";
  return modeOn ? "idle" : undefined;
}
