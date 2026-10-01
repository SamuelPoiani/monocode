import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveKeybindingOverride } from "../../settings/model/settings";
import { addProjectAction, setProjectActionShortcut } from "./projectActions";
import { resolveProjectActionShortcut } from "./projectActionShortcuts";

const event = {
  code: "KeyY",
  key: "Y",
  metaKey: false,
  ctrlKey: false,
  altKey: true,
  shiftKey: true,
  isComposing: false,
};
beforeEach(() => {
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("project action shortcuts", () => {
  it("resolves only actions belonging to the current project and ignores composition", () => {
    const action = addProjectAction("/repo", {
      name: "Build",
      command: "npm run build",
      runOnWorktreeCreate: false,
      waitBeforeAgent: false,
    });
    setProjectActionShortcut("Build", "Option+Shift+KeyY");
    expect(resolveProjectActionShortcut("/repo", event)).toEqual(action);
    expect(resolveProjectActionShortcut("/other", event)).toBeNull();
    expect(
      resolveProjectActionShortcut("/repo", { ...event, isComposing: true }),
    ).toBeNull();
  });

  it("rejects built-in app shortcuts using either primary modifier", () => {
    for (const modifier of ["Command", "Control"]) {
      expect(() =>
        setProjectActionShortcut("Build", `${modifier}+KeyK`),
      ).toThrow("Already used");
      expect(() =>
        setProjectActionShortcut("Build", `${modifier}+Shift+KeyP`),
      ).toThrow("Already used");
    }
  });

  it("yields to an app shortcut rebound after the action was saved", () => {
    addProjectAction("/repo", {
      name: "Build",
      command: "npm run build",
      runOnWorktreeCreate: false,
      waitBeforeAgent: false,
    });
    setProjectActionShortcut("Build", "Option+Shift+KeyY");
    saveKeybindingOverride("App: Search", { shortcut: "Option+Shift+KeyY" });
    expect(resolveProjectActionShortcut("/repo", event)).toBeNull();
  });

  it("rejects a rebound non-app built-in shortcut as well", () => {
    saveKeybindingOverride("Terminal: New", { shortcut: "Option+Shift+KeyY" });
    expect(() =>
      setProjectActionShortcut("Build", "Option+Shift+KeyY"),
    ).toThrow("Already used");
  });
});
