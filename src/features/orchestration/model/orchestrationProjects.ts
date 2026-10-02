import { invoke } from "@tauri-apps/api/core";
import { isEqualOrInside, pathKey, projectName } from "../../../shared/lib/paths";
import {
  knownProjectPaths,
  loadArchivedProjects,
  isLocalProject,
} from "../../projects/model/recents";
import type { LinkedProject } from "./orchestrationState";

const KEY = "monocode.orchestrationProjects";
const EMPTY: readonly string[] = [];
const listeners = new Set<() => void>();
let cache: Record<string, readonly string[]> | undefined;

function selections(): Record<string, readonly string[]> {
  if (cache) return cache;
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    cache = Object.fromEntries(
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? Object.entries(parsed).filter(([, paths]) =>
            Array.isArray(paths) && paths.every((path) => typeof path === "string"),
          )
        : [],
    );
  } catch {
    cache = {};
  }
  return cache;
}

/** Stable composer selection, kept per lead without changing the session schema. */
export function selectedOrchestrationProjects(sessionId: string): readonly string[] {
  const current = selections();
  return Object.prototype.hasOwnProperty.call(current, sessionId)
    ? current[sessionId]
    : EMPTY;
}

export function setOrchestrationProjects(sessionId: string, paths: string[]) {
  cache = { ...selections(), [sessionId]: paths };
  try {
    localStorage.setItem(KEY, JSON.stringify(cache));
  } catch {
    // Keep the in-memory selection when storage is unavailable.
  }
  for (const listener of listeners) listener();
}

export function subscribeOrchestrationProjects(listener: () => void) {
  listeners.add(listener);
  const changed = (event: StorageEvent) => {
    if (event.key !== KEY && event.key !== null) return;
    cache = undefined;
    listener();
  };
  window.addEventListener("storage", changed);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", changed);
  };
}

export const projectRootsOverlap = (a: string, b: string) =>
  isEqualOrInside(a, b) || isEqualOrInside(b, a);

/** Imported local projects that can be linked to this lead. */
export function availableOrchestrationProjects(projectCwd: string, checkoutCwd: string) {
  const archived = new Set(loadArchivedProjects().map((entry) => pathKey(entry.path)));
  return knownProjectPaths().filter(
    (root) =>
      isLocalProject(root) &&
      !archived.has(pathKey(root)) &&
      pathKey(root) !== pathKey(projectCwd) &&
      !projectRootsOverlap(root, checkoutCwd),
  );
}

/** Short, unique names captured with canonical roots before planning or starting. */
export function nameLinkedProjects(roots: string[]): LinkedProject[] {
  const names = new Set<string>();
  return roots.map((root) => {
    const base = projectName(root)
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "project";
    let name = base;
    for (let suffix = 2; names.has(name); suffix++) name = `${base}-${suffix}`;
    names.add(name);
    return { name, root };
  });
}

export async function canonicalProjectRoot(root: string): Promise<string> {
  const [canonical] = await invoke<string[]>("control_scopes", { cwd: root, files: ["."] });
  return invoke<string>("control_write_path", { path: canonical });
}

export function linkedProjectsPrompt(projects: LinkedProject[] | undefined): string {
  if (!projects?.length) return "";
  return `Linked projects (name and absolute root):\n${projects.map(({ name, root }) => `${name}: ${root}`).join("\n")}\nUse the optional project field with an exact linked name to target that project. Omit project for the lead checkout. files are relative to the selected project's root; a task never mixes projects. A linked project may itself hold several Git repositories: keep each task inside one repository, using its prefix in files. Review integrates changes into that project's working copy. Combine cross-project validation only after the relevant tasks are integrated.`;
}
