import { invoke } from "@tauri-apps/api/core";
import { pathKey } from "../../../shared/lib/paths";

const KEY = "monocode.nestedChangesRepo.v1";
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

function readAll(): StoredRepos {
  try {
    const raw = localStorage.getItem(KEY);
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

function writeAll(repos: StoredRepos): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(repos));
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

export function clearNestedChangesRepo(root: string): void {
  const repos = readAll();
  const key = pathKey(root);
  if (!Object.prototype.hasOwnProperty.call(repos, key)) return;
  delete repos[key];
  writeAll(repos);
}

export function rebaseNestedChangesRepo(from: string, to: string): void {
  const oldKey = pathKey(from);
  const newKey = pathKey(to);
  if (oldKey === newKey) return;
  const repos = readAll();
  if (!Object.prototype.hasOwnProperty.call(repos, oldKey)) return;
  repos[newKey] = repos[oldKey];
  delete repos[oldKey];
  writeAll(repos);
}
