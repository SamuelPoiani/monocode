import { pathKey } from "../../../shared/lib/paths";
import { canonicalShortcut } from "../../quick-composer/model/quickComposerShortcut";
import { validateActionShortcut } from "../../settings/model/appShortcuts";

const KEY = "monocode.projectActions.v1";
const SHORTCUTS_KEY = "monocode.projectActionShortcuts.v1";
export const PROJECT_ACTIONS_CHANGE_EVENT = "monocode:project-actions-change";

export const PROJECT_ACTION_ICONS = [
  "Play",
  "Terminal",
  "Zap",
  "Wrench",
  "GitBranch",
  "RefreshCw",
] as const;
export type ProjectActionIcon = (typeof PROJECT_ACTION_ICONS)[number];
export type ProjectAction = {
  id: string;
  name: string;
  icon?: ProjectActionIcon;
  command: string;
  runOnWorktreeCreate: boolean;
  waitBeforeAgent: boolean;
};

type ProjectActions = { actions: ProjectAction[]; lastRunActionId?: string };
type Stored = Record<string, ProjectActions>;
let revision = 0;

export function projectActionsRevision(): number {
  return revision;
}

export function listProjectActions(
  project: string | undefined,
): ProjectAction[] {
  return project ? (readProjects()[pathKey(project)]?.actions ?? []) : [];
}

export function lastRunProjectActionId(project: string): string | undefined {
  return readProjects()[pathKey(project)]?.lastRunActionId;
}

export function addProjectAction(
  project: string,
  value: Omit<ProjectAction, "id">,
): ProjectAction {
  const action = normalizeAction({ ...value, id: crypto.randomUUID() });
  if (!action) throw new Error("Name and command are required");
  update(project, (current) => ({
    ...current,
    actions: [...current.actions, action],
  }));
  return action;
}

export function updateProjectAction(
  project: string,
  id: string,
  value: Omit<ProjectAction, "id">,
): void {
  const action = normalizeAction({ ...value, id });
  if (!action) throw new Error("Name and command are required");
  update(project, (current) => ({
    ...current,
    actions: current.actions.map((entry) => (entry.id === id ? action : entry)),
  }));
}

export function removeProjectAction(project: string, id: string): void {
  update(project, (current) => ({
    actions: current.actions.filter((action) => action.id !== id),
    ...(current.lastRunActionId !== id
      ? { lastRunActionId: current.lastRunActionId }
      : {}),
  }));
}

export function setLastRunProjectAction(project: string, id: string): void {
  update(project, (current) =>
    current.actions.some((action) => action.id === id)
      ? { ...current, lastRunActionId: id }
      : current,
  );
}

export function clearProjectActions(project: string): void {
  const all = readProjects();
  if (!(pathKey(project) in all)) return;
  delete all[pathKey(project)];
  write(KEY, all);
}

export function rebaseProjectActions(from: string, to: string): void {
  const fromKey = pathKey(from);
  const toKey = pathKey(to);
  const all = readProjects();
  if (fromKey === toKey || !(fromKey in all)) return;
  all[toKey] = all[fromKey];
  delete all[fromKey];
  write(KEY, all);
}

export function projectActionShortcut(name: string): string | undefined {
  return readShortcuts()[name.trim()];
}

export function validateProjectActionShortcut(
  name: string,
  chord: string,
): string {
  const canonical = validateActionShortcut(chord);
  for (const [owner, shortcut] of Object.entries(readShortcuts())) {
    if (owner !== name.trim() && shortcut === canonical) {
      throw new Error(`Already used by action ${owner}`);
    }
  }
  return canonical;
}

/** Shortcut names survive removing projects so other projects keep their bindings. */
export function setProjectActionShortcut(
  name: string,
  chord: string | undefined,
): void {
  const shortcuts = readShortcuts();
  const key = name.trim();
  if (!key) return;
  if (chord) shortcuts[key] = validateProjectActionShortcut(key, chord);
  else delete shortcuts[key];
  write(SHORTCUTS_KEY, shortcuts);
}

export function subscribeProjectActions(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const storage = (event: StorageEvent) => {
    if (event.key !== KEY && event.key !== SHORTCUTS_KEY && event.key !== null)
      return;
    revision += 1;
    listener();
  };
  window.addEventListener(PROJECT_ACTIONS_CHANGE_EVENT, listener);
  window.addEventListener("storage", storage);
  return () => {
    window.removeEventListener(PROJECT_ACTIONS_CHANGE_EVENT, listener);
    window.removeEventListener("storage", storage);
  };
}

function update(
  project: string,
  change: (value: ProjectActions) => ProjectActions,
): void {
  const all = readProjects();
  const key = pathKey(project);
  const next = change(all[key] ?? { actions: [] });
  if (next.actions.length) all[key] = next;
  else delete all[key];
  write(KEY, all);
}

function read(key: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? "{}");
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function readProjects(): Stored {
  const out: Stored = Object.create(null);
  for (const [key, value] of Object.entries(read(KEY))) {
    if (!value || typeof value !== "object") continue;
    const entry = value as ProjectActions;
    if (!Array.isArray(entry.actions)) continue;
    const actions = entry.actions
      .map(normalizeAction)
      .filter((action): action is ProjectAction => !!action);
    out[key] = {
      actions,
      ...(actions.some((action) => action.id === entry.lastRunActionId)
        ? { lastRunActionId: entry.lastRunActionId }
        : {}),
    };
  }
  return out;
}

function normalizeAction(value: unknown): ProjectAction | null {
  if (!value || typeof value !== "object") return null;
  const action = value as ProjectAction;
  if (
    typeof action.id !== "string" ||
    !action.id ||
    typeof action.name !== "string" ||
    !action.name.trim() ||
    typeof action.command !== "string" ||
    !action.command.trim()
  )
    return null;
  return {
    id: action.id,
    name: action.name.trim(),
    ...(PROJECT_ACTION_ICONS.includes(action.icon as ProjectActionIcon)
      ? { icon: action.icon }
      : {}),
    command: action.command,
    runOnWorktreeCreate: action.runOnWorktreeCreate === true,
    waitBeforeAgent:
      action.runOnWorktreeCreate === true && action.waitBeforeAgent === true,
  };
}

function readShortcuts(): Record<string, string> {
  const out: Record<string, string> = Object.create(null);
  for (const [name, chord] of Object.entries(read(SHORTCUTS_KEY))) {
    if (typeof chord !== "string" || !name.trim()) continue;
    const canonical = canonicalShortcut(chord);
    if (canonical) out[name.trim()] = canonical;
  }
  return out;
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // private mode / quota
  }
  revision += 1;
  if (typeof window !== "undefined")
    window.dispatchEvent(new CustomEvent(PROJECT_ACTIONS_CHANGE_EVENT));
}
