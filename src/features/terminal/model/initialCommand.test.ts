import { beforeEach, describe, expect, it, vi } from "vitest";
import { writePty } from "../../../platform/tauri/pty";
import { createProjectTerminal } from "../../projects/model/projectTerminal";
import {
  newTab,
  newTerminalFile,
  newTerminalWorkspaceTab,
} from "../../workspace/model/layout";
import {
  collectWorkspaceSnapshot,
  parseWorkspaceSnapshot,
} from "../../workspace/model/workspaceSnapshot";
import { collectWindowTransfer } from "../../../app/model/windowTransfer";
import { applyTerminalMeta } from "./terminalTab";
import { consumeInitialCommand } from "./initialCommand";

vi.mock("../../../platform/tauri/pty", () => ({ writePty: vi.fn() }));
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(writePty).mockResolvedValue(undefined);
});

describe("terminal initial commands", () => {
  it("writes the command with one carriage return exactly once, including remount races", async () => {
    const file = newTerminalFile("/repo", "Build", "/repo", "npm run build");
    await Promise.all([
      consumeInitialCommand(file.id, file.initialCommand),
      consumeInitialCommand(file.id, file.initialCommand),
    ]);
    await consumeInitialCommand(file.id, file.initialCommand);
    expect(writePty).toHaveBeenCalledExactlyOnceWith(
      file.id,
      "npm run build\r",
    );
  });

  it("does not replay a failed write", async () => {
    const file = newTerminalFile("/repo", "Build", "/repo", "build");
    vi.mocked(writePty).mockRejectedValueOnce(new Error("PTY closed"));
    await expect(
      consumeInitialCommand(file.id, file.initialCommand),
    ).rejects.toThrow("PTY closed");
    await consumeInitialCommand(file.id, file.initialCommand);
    expect(writePty).toHaveBeenCalledTimes(1);
  });

  it("clears the command without letting shell metadata replace the action title", () => {
    const file = newTerminalFile("/repo", "Build", "/repo", "build");
    const cleared = applyTerminalMeta(file, {
      initialCommandConsumed: true,
      title: "cmd",
    });
    expect(cleared.initialCommand).toBeUndefined();
    expect(cleared.path).toBe("Build");
  });

  it("strips pending commands from persisted, restored and transferred terminals", () => {
    const file = newTerminalFile("/repo", "Build", "/repo", "build");
    const terminalTab = newTerminalWorkspaceTab(file);
    const sessionTab = newTab("session");
    const dock = createProjectTerminal("/repo", file);
    const snapshot = collectWorkspaceSnapshot(
      [terminalTab, sessionTab],
      [],
      terminalTab.id,
      "/repo",
      new Map(),
      [dock],
    );
    expect(
      snapshot.tabs[0].terminalPanes[0].files[0].initialCommand,
    ).toBeUndefined();
    expect(
      snapshot.projectTerminals[0].pane.files[0].initialCommand,
    ).toBeUndefined();
    expect(snapshot.projectTerminals[0].pane.files[0].terminalTitle).toBe(
      "Build",
    );
    const restored = parseWorkspaceSnapshot({
      ...snapshot,
      projectTerminals: [dock],
    });
    expect(
      restored?.projectTerminals[0].pane.files[0].initialCommand,
    ).toBeUndefined();
    const transfer = collectWindowTransfer(
      [terminalTab],
      [],
      [terminalTab.id],
      terminalTab.id,
      new Set(),
      "/repo",
      [dock],
    );
    expect(
      transfer?.tabs[0].terminalPanes[0].files[0].initialCommand,
    ).toBeUndefined();
    expect(
      transfer?.projectTerminals?.[0].pane.files[0].initialCommand,
    ).toBeUndefined();
    expect(file.initialCommand).toBe("build");
  });
});
