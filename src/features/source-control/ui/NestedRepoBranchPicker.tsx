import { joinPath, pathKey } from "../../../shared/lib/paths";
import { SearchableSelect } from "../../../shared/ui/SearchableSelect";
import { BranchPicker } from "./BranchPicker";

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
  selectedRepo: string;
  onRepoChange: (repo: string) => void;
  enabled?: boolean;
  onChange?: () => void;
  onClose?: () => void;
}) {
  const cwd = joinPath(root, selectedRepo);
  return (
    <>
      <div className="flex min-w-0 shrink-0 [&>div>button]:h-6">
        <SearchableSelect
          label="Repository"
          value={selectedRepo}
          options={repos.map((repo) => ({ value: repo, label: repo }))}
          onChange={onRepoChange}
          disabled={!enabled}
          searchPlaceholder="Search repositories…"
          emptyLabel="No matching repositories"
          searchable={repos.length > 8}
          variant="pill"
        />
      </div>
      <BranchPicker
        key={pathKey(cwd)}
        cwd={cwd}
        enabled={enabled}
        onChange={onChange}
        onClose={onClose}
      />
    </>
  );
}
