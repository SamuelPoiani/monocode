import { joinPath, pathKey } from "../../../shared/lib/paths";
import { SearchableSelect } from "../../../shared/ui/SearchableSelect";
import { BranchPicker } from "./BranchPicker";

/** Nested repositories are child folders, so `.` never names one. */
const ALL_REPOS = ".";

/**
 * Picks one repository of a multi-repo project folder, or all of them. Only a
 * single repository has branches to show.
 */
export function NestedRepoBranchPicker({
  root,
  repos,
  selectedRepo,
  onRepoChange,
  enabled = true,
  onChange,
  onClose,
}: {
  root: string;
  repos: string[];
  /** Undefined while the whole folder is selected. */
  selectedRepo: string | undefined;
  onRepoChange: (repo: string | undefined) => void;
  enabled?: boolean;
  onChange?: () => void;
  onClose?: () => void;
}) {
  const cwd = selectedRepo ? joinPath(root, selectedRepo) : undefined;
  return (
    <>
      <div className="flex min-w-0 shrink-0 [&>div>button]:h-6">
        <SearchableSelect
          label="Repository"
          value={selectedRepo ?? ALL_REPOS}
          options={[
            { value: ALL_REPOS, label: "All repositories" },
            ...repos.map((repo) => ({ value: repo, label: repo })),
          ]}
          onChange={(value) =>
            onRepoChange(value === ALL_REPOS ? undefined : value)
          }
          disabled={!enabled}
          searchPlaceholder="Search repositories…"
          emptyLabel="No matching repositories"
          searchable={repos.length > 8}
          variant="pill"
        />
      </div>
      {cwd ? (
        <BranchPicker
          key={pathKey(cwd)}
          cwd={cwd}
          enabled={enabled}
          onChange={onChange}
          onClose={onClose}
        />
      ) : null}
    </>
  );
}
