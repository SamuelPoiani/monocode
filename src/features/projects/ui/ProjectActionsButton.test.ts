// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TitleBar } from "../../../app/shell/TitleBar";
import {
  addProjectAction,
  listProjectActions,
  projectActionShortcut,
  setLastRunProjectAction,
  setProjectActionShortcut,
  type ProjectAction,
} from "../model/projectActions";
import {
  ProjectActionsButton,
  WorkspaceTitleActions,
} from "./ProjectActionsButton";

vi.mock("../../../app/shell/WindowControls", () => ({
  WindowControls: () => null,
}));
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function button(label: string): HTMLButtonElement {
  return [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (node) =>
      node.textContent === label || node.getAttribute("aria-label") === label,
  )!;
}

function type(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype =
    input instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

it("adds an action with a shortcut and gates worktree waiting", () => {
  act(() =>
    root.render(
      createElement(ProjectActionsButton, { project: "/repo", onRun: vi.fn() }),
    ),
  );
  expect(container.querySelectorAll("button")).toHaveLength(1);
  act(() => button("Add action").click());
  expect(document.body.textContent).toContain("Add Action");
  expect(button("Save action").disabled).toBe(true);
  expect(button("Wait for it to finish before the agent starts").disabled).toBe(
    true,
  );
  act(() => {
    type(
      document.querySelector<HTMLInputElement>("#project-action-name")!,
      "Build",
    );
    type(
      document.querySelector<HTMLTextAreaElement>("#project-action-command")!,
      "npm run build",
    );
    button("Run automatically on worktree creation").click();
  });
  expect(button("Save action").disabled).toBe(false);
  expect(button("Wait for it to finish before the agent starts").disabled).toBe(
    false,
  );
  act(() => button("Wait for it to finish before the agent starts").click());
  const recorder = document.querySelector<HTMLInputElement>(
    "#project-action-shortcut",
  )!;
  act(() => recorder.focus());
  act(() =>
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        code: "KeyY",
        key: "Y",
        altKey: true,
        shiftKey: true,
        cancelable: true,
      }),
    ),
  );
  act(() => button("Save action").click());
  expect(listProjectActions("/repo")[0]).toMatchObject({
    name: "Build",
    command: "npm run build",
    runOnWorktreeCreate: true,
    waitBeforeAgent: true,
  });
  expect(projectActionShortcut("Build")).toBe("Option+Shift+KeyY");
  expect(container.querySelectorAll("button")).toHaveLength(2);
});

it("runs the same selected action from the sidebar controls and title bar", () => {
  const first = addProjectAction("/repo", {
    name: "Build",
    command: "build",
    runOnWorktreeCreate: false,
    waitBeforeAgent: false,
  });
  const last = addProjectAction("/repo", {
    name: "Test",
    command: "test",
    runOnWorktreeCreate: false,
    waitBeforeAgent: false,
  });
  setLastRunProjectAction("/repo", last.id);
  setProjectActionShortcut("Test", "Option+Shift+KeyY");
  const onRun = vi.fn((action: ProjectAction) =>
    setLastRunProjectAction("/repo", action.id),
  );
  act(() =>
    root.render(
      createElement(
        "div",
        null,
        createElement(WorkspaceTitleActions, {
          project: "/repo",
          onRunAction: onRun,
        }),
        createElement(TitleBar, {
          tabs: [],
          activeId: "",
          cwd: "/repo",
          projectRailOpen: false,
          sessionSidebarOpen: false,
          onToggleSidebar: vi.fn(),
          onSelect: vi.fn(),
          onNew: vi.fn(),
          onClose: vi.fn(),
          onCloseMany: vi.fn(),
          onReorder: vi.fn(),
          onRunProjectAction: onRun,
        }),
      ),
    ),
  );
  const plays = [
    ...container.querySelectorAll<HTMLButtonElement>(
      'button[aria-label^="Run Test"]',
    ),
  ];
  expect(plays).toHaveLength(2);
  expect(plays[0].title).toContain("Alt+Shift+Y");
  act(() => plays.forEach((play) => play.click()));
  expect(onRun).toHaveBeenCalledTimes(2);
  expect(onRun).toHaveBeenLastCalledWith(last);
  act(() => button("Project actions").click());
  act(() => button("Build").click());
  expect(onRun).toHaveBeenLastCalledWith(first);
  expect(
    container.querySelectorAll('button[aria-label="Run Build"]'),
  ).toHaveLength(2);
});

it("offers edit/delete and rejects app shortcuts in the recorder", () => {
  const action = addProjectAction("/repo", {
    name: "Build",
    command: "build",
    runOnWorktreeCreate: false,
    waitBeforeAgent: false,
  });
  setProjectActionShortcut("Build", "Option+Shift+KeyY");
  act(() =>
    root.render(
      createElement(ProjectActionsButton, { project: "/repo", onRun: vi.fn() }),
    ),
  );
  act(() => button("Project actions").click());
  act(() => button("Edit Build").click());
  expect(document.body.textContent).toContain("Edit Action");
  const recorder = document.querySelector<HTMLInputElement>(
    "#project-action-shortcut",
  )!;
  act(() => recorder.focus());
  act(() =>
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        code: "KeyK",
        key: "k",
        ctrlKey: true,
        cancelable: true,
      }),
    ),
  );
  expect(document.querySelector('[role="alert"]')?.textContent).toContain(
    "Already used",
  );
  act(() =>
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        code: "Backspace",
        key: "Backspace",
        cancelable: true,
      }),
    ),
  );
  act(() => button("Save action").click());
  expect(projectActionShortcut("Build")).toBeUndefined();
  expect(listProjectActions("/repo")[0].id).toBe(action.id);
  act(() => button("Project actions").click());
  act(() => button("Edit Build").click());
  act(() => button("Delete").click());
  expect(listProjectActions("/repo")).toEqual([]);
  expect(container.querySelectorAll("button")).toHaveLength(1);
});

it("hides Actions for remote and projectless workspaces", () => {
  for (const project of ["remote://host/repo", "~"]) {
    act(() =>
      root.render(
        createElement(WorkspaceTitleActions, { project, onRunAction: vi.fn() }),
      ),
    );
    expect(container.querySelector('[aria-label="Add action"]')).toBeNull();
  }
});
