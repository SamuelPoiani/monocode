import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runProjectAction } from "../../../platform/tauri/projectActions";
import { createWorktree } from "../../source-control/model/worktrees";
import { addProjectAction } from "./projectActions";
import {
  notifyWorktreeActions,
  runWorktreeActions,
  subscribeWorktreeActions,
} from "./worktreeActions";

vi.mock("../../../platform/tauri/projectActions", () => ({
  runProjectAction: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => ({ path: "/tree" })),
}));
vi.mock("../../../platform/tauri/fs", () => ({ notifyGitChanged: vi.fn() }));
const value = {
  name: "Setup",
  command: "setup",
  runOnWorktreeCreate: true,
  waitBeforeAgent: true,
};
beforeEach(() => {
  const data = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => data.set(key, value),
  });
  vi.mocked(runProjectAction).mockResolvedValue({
    exitCode: 0,
    output: "",
    timedOut: false,
  });
});
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

it("awaits waiting actions sequentially before creation resolves", async () => {
  addProjectAction("/repo", value);
  addProjectAction("/repo", { ...value, name: "Second", command: "second" });
  addProjectAction("/repo", {
    ...value,
    name: "Watch",
    waitBeforeAgent: false,
  });
  addProjectAction("/repo", {
    ...value,
    name: "Manual",
    runOnWorktreeCreate: false,
  });
  let finish!: () => void;
  vi.mocked(runProjectAction).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = () =>
          resolve({ exitCode: 0, output: "ready", timedOut: false });
      }),
  );
  const openTerminal = vi.fn();
  const onError = vi.fn();
  const unsubscribe = subscribeWorktreeActions(({ project, cwd }) =>
    runWorktreeActions(project, cwd, { openTerminal, onError }),
  );
  try {
    let dispatched = false;
    const preparing = createWorktree("/repo", "branch", "HEAD", false).then(
      () => {
        dispatched = true;
      },
    );
    await vi.waitFor(() => expect(runProjectAction).toHaveBeenCalledTimes(1));
    expect(dispatched).toBe(false);
    finish();
    await preparing;
    expect(runProjectAction).toHaveBeenNthCalledWith(2, "/tree", "second");
    expect(openTerminal).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ name: "Watch" }),
      "/tree",
      "/repo",
    );
    expect(dispatched).toBe(true);
    expect(onError).not.toHaveBeenCalled();
  } finally {
    unsubscribe();
  }
});

it("reports output and continues after failure, timeout, or spawn rejection", async () => {
  for (const name of ["Fail", "Timeout", "Reject", "Ready"])
    addProjectAction("/repo", { ...value, name });
  vi.mocked(runProjectAction)
    .mockResolvedValueOnce({
      exitCode: 7,
      output: "missing dependency",
      timedOut: false,
    })
    .mockResolvedValueOnce({
      exitCode: null,
      output: "partial output",
      timedOut: true,
    })
    .mockRejectedValueOnce(new Error("spawn failed"));
  const onError = vi.fn();
  await runWorktreeActions("/repo", "/tree", {
    openTerminal: vi.fn(),
    onError,
  });
  expect(runProjectAction).toHaveBeenCalledTimes(4);
  expect(onError).toHaveBeenNthCalledWith(
    1,
    expect.stringContaining("missing dependency"),
  );
  expect(onError).toHaveBeenNthCalledWith(
    2,
    expect.stringContaining("timed out"),
  );
  expect(onError).toHaveBeenNthCalledWith(
    3,
    expect.stringContaining("spawn failed"),
  );
});

it("allows creation without a mounted app listener", async () => {
  await expect(
    notifyWorktreeActions("/repo", "/tree"),
  ).resolves.toBeUndefined();
});
