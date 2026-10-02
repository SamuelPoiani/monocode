import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import {
  loadLinkedProjectFiles,
  peekLinkedProjectFiles,
  subscribeProjectFiles,
} from "../../files/model/fileIndex";
import type { MentionProject } from "../../files/model/fileMentions";
import type { ProjectFile } from "../../../platform/tauri/fs";
import { orchestrator } from "../../orchestration/model/orchestration";
import {
  selectedOrchestrationProjects,
  subscribeOrchestrationProjects,
} from "../../orchestration/model/orchestrationProjects";
import {
  subscribeArchivedProjects,
  subscribeProjectPathsChanged,
} from "../../projects/model/recents";

const EMPTY_PROJECTS: MentionProject[] = [];
const EMPTY_FILES: { name: string; files: ProjectFile[] }[] = [];

/** Use the same canonical names as planning, and the fixed names of a live run. */
export function useLinkedMentionProjects(input: {
  sessionId?: string;
  checkoutCwd: string;
  enabled: boolean;
  pickerOpen: boolean;
}) {
  const paths = useSyncExternalStore(subscribeOrchestrationProjects, () =>
    selectedOrchestrationProjects(input.sessionId ?? ""),
  );
  const runs = useSyncExternalStore(
    orchestrator.subscribe,
    orchestrator.snapshot,
  );
  const run = runs.find((entry) => entry.leadId === input.sessionId);
  const fixed =
    run?.status === "active" || run?.status === "paused"
      ? (run.linkedProjects ?? EMPTY_PROJECTS)
      : undefined;
  const enabled = input.enabled && !!input.sessionId;
  const [revision, setRevision] = useState(0);
  const key = JSON.stringify([
    enabled,
    input.sessionId,
    input.checkoutCwd,
    paths,
    revision,
  ]);
  const [resolved, setResolved] = useState<{
    key: string;
    projects: MentionProject[];
    error?: string;
  }>({ key: "", projects: EMPTY_PROJECTS });

  useEffect(() => {
    const changed = () => setRevision((value) => value + 1);
    const stopPaths = subscribeProjectPathsChanged(changed);
    const stopArchived = subscribeArchivedProjects(changed);
    return () => {
      stopPaths();
      stopArchived();
    };
  }, []);

  useEffect(() => {
    if (!enabled || fixed || !paths.length) return;
    let cancelled = false;
    void orchestrator
      .linkedProjects(input.sessionId!, input.checkoutCwd)
      .then((projects) => {
        if (!cancelled) setResolved({ key, projects });
      })
      .catch((reason: unknown) => {
        if (!cancelled)
          setResolved({
            key,
            projects: EMPTY_PROJECTS,
            error: reason instanceof Error ? reason.message : String(reason),
          });
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, fixed, input.checkoutCwd, input.sessionId, key, paths.length]);

  const projects = !enabled
    ? EMPTY_PROJECTS
    : (fixed ??
      (paths.length && resolved.key === key
        ? resolved.projects
        : EMPTY_PROJECTS));
  const filesKey = JSON.stringify(projects);
  const [indexed, setIndexed] = useState<{
    key: string;
    files: typeof EMPTY_FILES;
    loading: boolean;
    error?: string;
  }>({ key: "", files: EMPTY_FILES, loading: false });
  const cachedFiles = useMemo(
    () =>
      projects.map(({ name, root }) => ({
        name,
        files: peekLinkedProjectFiles(root) ?? [],
      })),
    [projects],
  );

  useEffect(() => {
    if (!projects.length) return;
    let cancelled = false;
    const readFiles = () =>
      projects.map(({ name, root }) => ({
        name,
        files: peekLinkedProjectFiles(root) ?? [],
      }));
    setIndexed({
      key: filesKey,
      files: readFiles(),
      loading: input.pickerOpen,
    });
    const stop = subscribeProjectFiles(() => {
      if (!cancelled)
        setIndexed((current) => ({
          ...current,
          key: filesKey,
          files: readFiles(),
        }));
    });
    if (input.pickerOpen) {
      void Promise.allSettled(
        projects.map(({ root }) => loadLinkedProjectFiles(root, true)),
      ).then((results) => {
        if (cancelled) return;
        const failed = results.flatMap((result, index) =>
          result.status === "rejected" ? [projects[index].name] : [],
        );
        setIndexed({
          key: filesKey,
          files: readFiles(),
          loading: false,
          error: failed.length
            ? `Could not index linked projects: ${failed.join(", ")}`
            : undefined,
        });
      });
    }
    return () => {
      cancelled = true;
      stop();
    };
  }, [filesKey, input.pickerOpen, projects]);

  const resolving =
    enabled && !fixed && paths.length > 0 && resolved.key !== key;
  return {
    files: !projects.length
      ? EMPTY_FILES
      : indexed.key === filesKey
        ? indexed.files
        : cachedFiles,
    loading:
      resolving ||
      (projects.length > 0 && (indexed.key !== filesKey || indexed.loading)),
    error: enabled
      ? ((resolved.key === key && !fixed ? resolved.error : undefined) ??
        (projects.length && indexed.key === filesKey
          ? indexed.error
          : undefined))
      : undefined,
  };
}
