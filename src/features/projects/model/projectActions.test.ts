import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addProjectAction,
  clearProjectActions,
  lastRunProjectActionId,
  listProjectActions,
  projectActionsRevision,
  projectActionShortcut,
  rebaseProjectActions,
  removeProjectAction,
  setLastRunProjectAction,
  setProjectActionShortcut,
  subscribeProjectActions,
  updateProjectAction,
} from "./projectActions";
import { rebaseProjectData } from "./projectData";

const value = {
  name: "Build",
  command: "npm run build",
  runOnWorktreeCreate: false,
  waitBeforeAgent: false,
};
let storage: Map<string, string>;
beforeEach(() => {
  storage = new Map();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  });
  vi.stubGlobal("window", new EventTarget());
});
afterEach(() => vi.unstubAllGlobals());

describe("project actions", () => {
  it("adds, edits and removes actions by normalized project path", () => {
    expect(listProjectActions(undefined)).toEqual([]);
    const action = addProjectAction("/repo/a/", value);
    expect(listProjectActions("/repo/b")).toEqual([]);
    expect(listProjectActions("/repo/a")).toEqual([action]);
    updateProjectAction("/repo/a", action.id, {
      ...value,
      name: "Test",
      command: "npm test",
      icon: "Terminal",
    });
    expect(listProjectActions("/repo/a")[0]).toMatchObject({
      id: action.id,
      name: "Test",
      command: "npm test",
      icon: "Terminal",
    });
    setLastRunProjectAction("/repo/a", action.id);
    expect(lastRunProjectActionId("/repo/a")).toBe(action.id);
    removeProjectAction("/repo/a", action.id);
    expect(listProjectActions("/repo/a")).toEqual([]);
    expect(lastRunProjectActionId("/repo/a")).toBeUndefined();
  });

  it("rebases actions and last-run selection through project data", () => {
    const action = addProjectAction("/repo/a", value);
    setLastRunProjectAction("/repo/a", action.id);
    rebaseProjectData("/repo/a", "/repo/renamed");
    expect(listProjectActions("/repo/a")).toEqual([]);
    expect(listProjectActions("/repo/renamed")).toEqual([action]);
    expect(lastRunProjectActionId("/repo/renamed")).toBe(action.id);
    rebaseProjectActions("/repo/renamed", "/repo/renamed/");
    clearProjectActions("/repo/renamed");
    expect(listProjectActions("/repo/renamed")).toEqual([]);
  });

  it("shares shortcuts by exact action name across projects", () => {
    const first = addProjectAction("/repo/a", value);
    addProjectAction("/repo/b", { ...value, command: "cargo build" });
    setProjectActionShortcut("Build", "Shift+Option+KeyY");
    expect(projectActionShortcut(listProjectActions("/repo/b")[0].name)).toBe(
      "Option+Shift+KeyY",
    );
    expect(() => setProjectActionShortcut("Test", "Option+Shift+KeyY")).toThrow(
      "Already used",
    );
    updateProjectAction("/repo/a", first.id, { ...value, name: "Compile" });
    expect(projectActionShortcut("Compile")).toBeUndefined();
    expect(projectActionShortcut("Build")).toBe("Option+Shift+KeyY");
    clearProjectActions("/repo/b");
    expect(projectActionShortcut("Build")).toBe("Option+Shift+KeyY");
    setProjectActionShortcut("Build", undefined);
    expect(projectActionShortcut("Build")).toBeUndefined();
  });

  it("only waits when automatic execution is enabled", () => {
    expect(
      addProjectAction("/repo", { ...value, waitBeforeAgent: true })
        .waitBeforeAgent,
    ).toBe(false);
    expect(
      addProjectAction("/repo", {
        ...value,
        runOnWorktreeCreate: true,
        waitBeforeAgent: true,
      }).waitBeforeAgent,
    ).toBe(true);
  });

  it("ignores malformed entries and stale last-run IDs", () => {
    storage.set("monocode.projectActions.v1", "not json");
    expect(listProjectActions("/repo")).toEqual([]);
    storage.set(
      "monocode.projectActions.v1",
      JSON.stringify({
        "/repo": {
          actions: [
            null,
            { ...value, id: "valid", icon: "unknown" },
            { id: "missing-fields" },
          ],
          lastRunActionId: "removed",
        },
      }),
    );
    expect(listProjectActions("/repo")).toEqual([{ ...value, id: "valid" }]);
    expect(lastRunProjectActionId("/repo")).toBeUndefined();
  });

  it("notifies subscribers for actions, shortcuts, and storage changes", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeProjectActions(listener);
    const before = projectActionsRevision();
    addProjectAction("/repo", value);
    setProjectActionShortcut("Build", "Option+Shift+KeyY");
    expect(listener).toHaveBeenCalledTimes(2);
    const event = new Event("storage");
    Object.assign(event, { key: "monocode.projectActions.v1" });
    window.dispatchEvent(event);
    expect(listener).toHaveBeenCalledTimes(3);
    expect(projectActionsRevision()).toBeGreaterThan(before);
    unsubscribe();
    addProjectAction("/repo", value);
    expect(listener).toHaveBeenCalledTimes(3);
  });
});
