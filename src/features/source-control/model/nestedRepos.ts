import { invoke } from "@tauri-apps/api/core";
import { pathKey } from "../../../shared/lib/paths";

const KEY = "monocode.nestedChangesRepo.v1";
/** Folders whose composer is focused on the selected repository; absent
 * folders show all of their repositories. */
const COMPOSER_FOCUS_KEY = "monocode.nestedComposerFocus.v1";
const FOCUSED = "repo";
const listeners = new Set<() => void>();

export function subscribeNestedChangesRepo(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

type StoredRepos = Record<string, string>;

/**
 * Repositories inside a plain folder, as `/`-separated paths relative to it;
 * null when the folder is itself inside a repository.
 */
export function nestedGitRepos(root: string) {
  return invoke<string[] | null>("git_nested_repos", { root });
}

function readAll(key = KEY): StoredRepos {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(([, repo]) => typeof repo === "string"),
    );
  } catch {
    return {};
  }
}

function writeAll(repos: StoredRepos, key = KEY): void {
  try {
    localStorage.setItem(key, JSON.stringify(repos));
  } catch {
    // private mode / quota
  }
  for (const listener of listeners) listener();
}

/** The nested repository whose changes a plain folder last showed. */
export function loadNestedChangesRepo(root: string): string | undefined {
  return readAll()[pathKey(root)];
}

export function saveNestedChangesRepo(root: string, repo: string): void {
  writeAll({ ...readAll(), [pathKey(root)]: repo });
}

/** The composer of `root` last focused on one repository rather than all. */
export function loadNestedComposerFocus(root: string): boolean {
  return readAll(COMPOSER_FOCUS_KEY)[pathKey(root)] === FOCUSED;
}

export function saveNestedComposerFocus(root: string, focused: boolean): void {
  const stored = readAll(COMPOSER_FOCUS_KEY);
  const key = pathKey(root);
  if ((stored[key] === FOCUSED) === focused) return;
  if (focused) stored[key] = FOCUSED;
  else delete stored[key];
  writeAll(stored, COMPOSER_FOCUS_KEY);
}

export function clearNestedChangesRepo(root: string): void {
  const key = pathKey(root);
  for (const storeKey of [KEY, COMPOSER_FOCUS_KEY]) {
    const repos = readAll(storeKey);
    if (!Object.prototype.hasOwnProperty.call(repos, key)) continue;
    delete repos[key];
    writeAll(repos, storeKey);
  }
}

export function rebaseNestedChangesRepo(from: string, to: string): void {
  const oldKey = pathKey(from);
  const newKey = pathKey(to);
  if (oldKey === newKey) return;
  for (const storeKey of [KEY, COMPOSER_FOCUS_KEY]) {
    const repos = readAll(storeKey);
    if (!Object.prototype.hasOwnProperty.call(repos, oldKey)) continue;
    repos[newKey] = repos[oldKey];
    delete repos[oldKey];
    writeAll(repos, storeKey);
  }
}
