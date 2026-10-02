import { useCallback, useEffect, useMemo, useState } from "react";
import { joinPath, pathKey } from "../../../shared/lib/paths";
import {
  loadNestedChangesRepo,
  loadNestedComposerFocus,
  nestedGitRepos,
  saveNestedChangesRepo,
  saveNestedComposerFocus,
  subscribeNestedChangesRepo,
} from "../model/nestedRepos";

export type NestedGitRepos = {
  /** Repositories nested in the plain folder `root`, relative to it; null
   * when `root` is a repository itself or has not been scanned yet. */
  repos: string[] | null;
  /** The first scan for the current root has finished. */
  scanned: boolean;
  /** The nested repository whose changes are shown. */
  selected: string | undefined;
  selectedCwd: string | undefined;
  /** `focusedCwd` is one of the nested repositories. */
  focused: boolean;
  select: (repo: string) => void;
  /** The composer is focused on `selected` rather than every repository. */
  composerFocused: boolean;
  setComposerFocused: (focused: boolean) => void;
};

function sameRepos(a: string[] | null, b: string[] | null): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  return a.every((repo, index) => repo === b[index]);
}

/**
 * Lets the Changes panel of a plain project folder show one of the
 * repositories inside it at a time. Focusing a tab from one of them (a diff
 * opened from the panel) selects that repository.
 */
export function useNestedGitRepos(
  root: string | undefined,
  focusedCwd: string | undefined,
  enabled: boolean,
): NestedGitRepos {
  const active = enabled && Boolean(root) && root !== "~";
  const [scan, setScan] = useState<{ root: string; repos: string[] | null }>();
  const [version, setVersion] = useState(0);

  useEffect(
    () => subscribeNestedChangesRepo(() => setVersion((value) => value + 1)),
    [],
  );

  useEffect(() => {
    if (!active || !root) return;
    let cancelled = false;
    const load = () => {
      void nestedGitRepos(root)
        .catch(() => null)
        .then((repos) => {
          if (cancelled) return;
          setScan((prev) =>
            prev?.root === root && sameRepos(prev.repos, repos)
              ? prev
              : { root, repos },
          );
        });
    };
    load();
    window.addEventListener("focus", load);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", load);
    };
  }, [active, root]);

  const scanned = active && scan?.root === root;
  const repos = active && scan && scan.root === root ? scan.repos : null;
  const saved = useMemo(
    () => (root ? loadNestedChangesRepo(root) : undefined),
    // `version` re-reads the choice whenever any picker saves it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [root, version],
  );
  const composerFocused = useMemo(
    () => (root ? loadNestedComposerFocus(root) : false),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [root, version],
  );
  const selected = repos?.length
    ? saved && repos.includes(saved)
      ? saved
      : repos[0]
    : undefined;
  const focusedRepo =
    root && focusedCwd
      ? repos?.find(
          (repo) => pathKey(joinPath(root, repo)) === pathKey(focusedCwd),
        )
      : undefined;

  const select = useCallback(
    (repo: string) => {
      if (!root) return;
      saveNestedChangesRepo(root, repo);
    },
    [root],
  );
  const setComposerFocused = useCallback(
    (focused: boolean) => {
      if (root) saveNestedComposerFocus(root, focused);
    },
    [root],
  );

  useEffect(() => {
    if (focusedRepo && focusedRepo !== saved) select(focusedRepo);
    // Only a newly focused tab moves the selection, so picking another
    // repository while that tab stays focused is not undone.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusedRepo]);

  return {
    repos,
    scanned,
    selected,
    selectedCwd: root && selected ? joinPath(root, selected) : undefined,
    focused: focusedRepo != null,
    select,
    composerFocused,
    setComposerFocused,
  };
}
