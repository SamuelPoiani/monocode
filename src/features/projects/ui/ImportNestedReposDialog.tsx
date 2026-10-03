import { useState } from "react";
import { joinPath, pathKey, prettyCwd } from "../../../shared/lib/paths";
import { Modal } from "../../../shared/ui/Modal";

/**
 * What to open for a plain folder holding several repositories: the folder
 * itself as one project, the chosen repositories as projects of their own, or
 * nothing when the dialog is dismissed.
 */
export type NestedReposChoice =
  | { kind: "folder" }
  | { kind: "repos"; paths: string[] }
  | { kind: "cancel" };

export function ImportNestedReposDialog({
  root,
  repos,
  known,
  onClose,
}: {
  root: string;
  /** Repositories inside `root`, relative to it. */
  repos: string[];
  /** Path keys of projects already in the sidebar. */
  known: ReadonlySet<string>;
  onClose: (choice: NestedReposChoice) => void;
}) {
  const isKnown = (repo: string) => known.has(pathKey(joinPath(root, repo)));
  // Repositories already added start unticked; opening them again would only
  // switch to them.
  const [selected, setSelected] = useState(
    () => new Set(repos.filter((repo) => !isKnown(repo))),
  );
  const allSelected = selected.size === repos.length;

  const toggle = (repo: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(repo)) next.delete(repo);
      else next.add(repo);
      return next;
    });

  const importSelected = () =>
    onClose({
      kind: "repos",
      paths: repos
        .filter((repo) => selected.has(repo))
        .map((repo) => joinPath(root, repo)),
    });

  return (
    <Modal
      title="Import repositories?"
      description={prettyCwd(root)}
      size="md"
      fitViewport
      onClose={() => onClose({ kind: "cancel" })}
    >
      <div className="flex flex-col gap-3.5 p-4 text-[13px] leading-[1.5]">
        <p className="text-content/75">
          This folder isn’t a Git repository, but it holds{" "}
          {repos.length === 1 ? "one" : repos.length}{" "}
          {repos.length === 1 ? "repository" : "repositories"}. Each one works
          best as its own project.
        </p>
        <div className="rounded-lg border border-content/10">
          <div className="flex items-center justify-between gap-2 border-b border-content/8 px-3 py-2 text-[12px] text-content/55">
            <span>
              {selected.size} of {repos.length} selected
            </span>
            <button
              type="button"
              onClick={() =>
                setSelected(allSelected ? new Set() : new Set(repos))
              }
              className="rounded px-1.5 py-0.5 text-content/65 hover:bg-content/8 hover:text-content"
            >
              {allSelected ? "Select none" : "Select all"}
            </button>
          </div>
          <ul className="max-h-[min(320px,45dvh)] overflow-y-auto py-1">
            {repos.map((repo) => (
              <li key={repo}>
                <label className="flex cursor-pointer items-center gap-2.5 px-3 py-1.5 hover:bg-content/5">
                  <input
                    type="checkbox"
                    checked={selected.has(repo)}
                    onChange={() => toggle(repo)}
                    className="accent-accent"
                  />
                  <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-content/85">
                    {repo}
                  </span>
                  {isKnown(repo) && (
                    <span className="shrink-0 text-[11px] text-content/40">
                      Already added
                    </span>
                  )}
                </label>
              </li>
            ))}
          </ul>
        </div>
        <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={() => onClose({ kind: "folder" })}
            className="rounded-md px-3 py-1.5 text-[12px] text-content/70 hover:bg-content/8 hover:text-content active:scale-[0.97]"
          >
            Open folder as one project
          </button>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => onClose({ kind: "cancel" })}
              className="rounded-md px-3 py-1.5 text-[12px] hover:bg-content/8 active:scale-[0.97]"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={selected.size === 0}
              onClick={importSelected}
              className="rounded-md bg-content px-3 py-1.5 text-[12px] font-medium text-background-base disabled:opacity-40 active:scale-[0.97]"
            >
              {selected.size === 1
                ? "Import 1 project"
                : `Import ${selected.size} projects`}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
