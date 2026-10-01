import type { HarnessId } from "../../sessions/model/session";
import type { GitFileDiffKind, GitHistoryCommit } from "../../../platform/tauri/fs";
import { GitChangesPanel } from "./GitChangesPanel";

type Props = {
  cwd: string;
  repos?: string[];
  repo?: string;
  onRepoChange?: (repo: string) => void;
  enabled: boolean;
  textHarness?: HarnessId;
  selectedPath?: string;
  selectedKind?: GitFileDiffKind;
  selectedSha?: string;
  onOpenFile: (path: string, kind: GitFileDiffKind) => void;
  onOpenAllChanges: (kind: GitFileDiffKind) => void;
  onOpenCommit: (commit: GitHistoryCommit) => void;
};

export function SourceControl({
  cwd,
  repos,
  repo,
  onRepoChange,
  enabled,
  textHarness,
  selectedPath,
  selectedKind,
  selectedSha,
  onOpenFile,
  onOpenAllChanges,
  onOpenCommit,
}: Props) {
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
      <GitChangesPanel
        key={cwd}
        cwd={cwd}
        repos={repos}
        repo={repo}
        onRepoChange={onRepoChange}
        enabled={enabled}
        textHarness={textHarness}
        selectedPath={selectedPath}
        selectedKind={selectedKind}
        selectedSha={selectedSha}
        onOpenFile={onOpenFile}
        onOpenAllChanges={onOpenAllChanges}
        onOpenCommit={onOpenCommit}
      />
    </div>
  );
}
