import { joinPath, pathKey, slash } from "../../../shared/lib/paths";
import type { OrchestrationChoice } from "./orchestrationPlan";
import type { HarnessId } from "../../sessions/model/session";

export type TaskStatus =
  | "queued"
  | "running"
  | "cancelling"
  | "completed"
  | "failed"
  | "blocked"
  | "interrupted"
  | "cancelled";

export type WorkspacePolicy =
  "shared" | "isolated-child" | "isolated-top-level";

export type OrchestrationWorkspace = {
  /** Stable comparison identity; not a display path. */
  id: string;
  /** Project identity used by recents, history and project-level settings. */
  projectCwd: string;
  /** Concrete checkout in which this run may read and write. */
  checkoutCwd: string;
  kind: "main" | "worktree";
  branch?: string;
  /**
   * Repository checkout a worker worktree was seeded from and integrates
   * into. Absent means the run checkout itself; set when the run checkout is
   * a plain folder holding several repositories.
   */
  baseCwd?: string;
  /** Path of baseCwd relative to the run checkout, e.g. "packages/api". */
  basePrefix?: string;
};

export type DispatchState =
  | "starting"
  | "running"
  | "completed"
  | "failed"
  | "blocked"
  | "interrupted"
  | "cancelled"
  | "start_unknown"
  | "stop_unknown";

export type DispatchStage =
  | "accepted"
  | "session_prepared"
  | "turn_submitted"
  | "settled"
  | "integration_started"
  | "integrated"
  | "cleaned";

export type OrchestrationDispatch = {
  id: string;
  taskId: string;
  sessionId: string;
  workspace: OrchestrationWorkspace;
  state: DispatchState;
  stage: DispatchStage;
  startedAt: number;
  updatedAt: number;
  result?: string;
  error?: string;
  cleanupError?: string;
};

export type OrchestrationTask = {
  id: string;
  assignmentId?: string;
  sessionId: string;
  title: string;
  harness: HarnessId;
  model: string;
  modelSettings?: Record<string, string>;
  prompt: string;
  files: string[];
  /** Logical scopes in the lead checkout, used for scheduling overlap. */
  scopes: string[];
  /** The same scopes resolved inside this worker's isolated checkout. */
  writeScopes?: string[];
  scratchDir?: string;
  dependsOn: string[];
  status: TaskStatus;
  accepted: boolean;
  result: string;
  error?: string;
  /** A retained worker can continue safely with this recovery turn. */
  recoveryPrompt?: string;
  delivered: boolean;
  /** Workspace selection is independent from task/dependency identity. */
  workspacePolicy?: WorkspacePolicy;
  /** A retry reuses its worker checkout so partial work is never orphaned. */
  workspace?: OrchestrationWorkspace;
  /** Only this dispatch may settle the task. A retry always gets a new id. */
  activeDispatchId?: string;
  lastDispatchId?: string;
  acceptedDispatchId?: string;
};

export type OrchestrationRun = {
  /** Version 1 remains readable; every committed snapshot is migrated to 2. */
  version: 1 | 2;
  leadId: string;
  /** Legacy project identity. Use workspace.checkoutCwd for filesystem work. */
  cwd: string;
  workspace?: OrchestrationWorkspace;
  canonicalRoot?: string;
  /**
   * The checkout is a plain folder holding several Git repositories; each
   * worker is isolated in the nested repository that owns its files.
   */
  multiRepo?: boolean;
  status: "active" | "paused" | "stopped" | "finished";
  allowedHarnesses: HarnessId[];
  allowedModels?: OrchestrationChoice[];
  proposalId?: string;
  maxWorkers: number;
  cli: string;
  tasks: OrchestrationTask[];
  dispatches?: OrchestrationDispatch[];
  error?: string;
  continuations: number;
  lastPauseReason?: string;
  requests: Record<string, { signature: string; result: unknown }>;
};

export function workspaceIdentity(
  projectCwd: string,
  checkoutCwd: string,
  branch?: string,
): OrchestrationWorkspace {
  return {
    id: `checkout:${pathKey(checkoutCwd)}`,
    projectCwd,
    checkoutCwd,
    kind: pathKey(projectCwd) === pathKey(checkoutCwd) ? "main" : "worktree",
    ...(branch ? { branch } : {}),
  };
}

export function orchestrationWorkspace(
  run: OrchestrationRun,
): OrchestrationWorkspace {
  return run.workspace ?? workspaceIdentity(run.cwd, run.cwd);
}

export const orchestrationProjectCwd = (run: OrchestrationRun) =>
  orchestrationWorkspace(run).projectCwd;

export const orchestrationCheckoutCwd = (run: OrchestrationRun) =>
  orchestrationWorkspace(run).checkoutCwd;

/** Checkout a worker's worktree is seeded from, compared with and merged into. */
export const orchestrationWorkerBaseCwd = (
  run: OrchestrationRun,
  task: Pick<OrchestrationTask, "workspace">,
) => task.workspace?.baseCwd ?? orchestrationCheckoutCwd(run);

/**
 * Pick the repository a worker is isolated in. A run checkout that is itself
 * a Git repository keeps the original behavior. A plain folder holding
 * several repositories isolates each task in the one repository that owns
 * every file in its write scope.
 */
export async function resolveWorkerBase(
  checkoutCwd: string,
  files: string[],
  repoPrefix: (root: string, path: string) => Promise<string | null>,
): Promise<{ baseCwd: string; basePrefix?: string }> {
  if ((await repoPrefix(checkoutCwd, ".")) !== null)
    return { baseCwd: checkoutCwd };
  const prefixes = await Promise.all(
    files.map((file) => repoPrefix(checkoutCwd, file)),
  );
  const nested = prefixes.filter((prefix): prefix is string => !!prefix);
  if (!files.length || nested.length !== prefixes.length)
    throw new Error(
      `${checkoutCwd} is not a Git repository, so every file in this task must be inside one of its nested repositories. Assign files such as "<repo>/src" instead of "." or folders outside a repository.`,
    );
  const repositories = [...new Set(nested)];
  if (repositories.length > 1)
    throw new Error(
      `This task's files span several Git repositories (${repositories.join(", ")}). Split it into one task per repository.`,
    );
  const basePrefix = repositories[0];
  return { baseCwd: joinPath(checkoutCwd, basePrefix), basePrefix };
}

/** Rewrite run-relative files as paths relative to a nested repository. */
export function workerRelativeFiles(files: string[], basePrefix?: string) {
  if (!basePrefix) return files;
  const prefix = pathKey(basePrefix);
  return files.map((file) => {
    const normalized = slash(file).replace(/^\.\//, "").replace(/\/+$/, "");
    const key = pathKey(normalized);
    if (key === prefix) return ".";
    if (!key.startsWith(`${prefix}/`))
      throw new Error(
        `${JSON.stringify(file)} is outside ${JSON.stringify(basePrefix)}, the nested repository this worker is isolated in. Use files inside that repository, or cancel this task and delegate a new one.`,
      );
    return normalized.slice(basePrefix.length + 1);
  });
}

export function normalizeOrchestrationRun(
  run: OrchestrationRun,
): OrchestrationRun {
  const workspace = orchestrationWorkspace(run);
  // Older builds implemented every worker scope violation as a global pause
  // and copied the pause reason onto every running task as a generic failure.
  // Preserve the actual offender for review, but recover the collateral tasks
  // as resumable interruptions. The exact shared error is the durable marker
  // that distinguishes these tasks from ordinary worker failures.
  const legacyPauseError = run.status === "paused" ? run.error : undefined;
  const escaped =
    legacyPauseError &&
    run.tasks.find((task) =>
      legacyPauseError.startsWith(
        `${task.title} reported a write outside its assignment:`,
      ),
    )?.id;
  const tasks = run.tasks.map((task) => {
    const legacyInterrupted =
      !!legacyPauseError &&
      task.status === "failed" &&
      task.error === legacyPauseError;
    return {
      ...task,
      ...(legacyInterrupted
        ? {
            status:
              task.id === escaped
                ? ("blocked" as const)
                : ("interrupted" as const),
            delivered: task.id === escaped ? false : true,
          }
        : {}),
      // Version 1 predates per-worker worktrees and must retain its original
      // shared-checkout behavior. New version 2 tasks default to isolation.
      workspacePolicy:
        task.workspacePolicy ??
        (run.version === 1 ? "shared" : "isolated-child"),
    };
  });
  const statusByDispatch = new Map(
    tasks.flatMap((task) =>
      task.lastDispatchId &&
      (task.status === "blocked" || task.status === "interrupted")
        ? [[task.lastDispatchId, task.status] as const]
        : [],
    ),
  );
  return {
    ...run,
    version: 2,
    cwd: workspace.projectCwd,
    workspace,
    tasks,
    dispatches: (run.dispatches ?? []).map((dispatch) => ({
      ...dispatch,
      state: statusByDispatch.get(dispatch.id) ?? dispatch.state,
    })),
  };
}
