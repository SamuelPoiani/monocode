import { runProjectAction } from "../../../platform/tauri/projectActions";
import {
  listProjectActions,
  setLastRunProjectAction,
  type ProjectAction,
} from "./projectActions";

type WorktreeCreated = { project: string; cwd: string };
type Listener = (created: WorktreeCreated) => Promise<void>;
const listeners = new Set<Listener>();

export function subscribeWorktreeActions(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export async function notifyWorktreeActions(
  project: string,
  cwd: string,
): Promise<void> {
  for (const listener of listeners) await listener({ project, cwd });
}

export async function runWorktreeActions(
  project: string,
  cwd: string,
  options: {
    openTerminal: (action: ProjectAction, cwd: string, project: string) => void;
    onError: (message: string) => void;
  },
): Promise<void> {
  for (const action of listProjectActions(project)) {
    if (!action.runOnWorktreeCreate) continue;
    try {
      if (action.waitBeforeAgent) {
        setLastRunProjectAction(project, action.id);
        const result = await runProjectAction(cwd, action.command);
        if (result.exitCode !== 0 || result.timedOut) {
          options.onError(
            `Action "${action.name}" ${result.timedOut ? "timed out" : `failed (${result.exitCode ?? "no exit code"})`}.\n${result.output}`,
          );
        }
      } else {
        options.openTerminal(action, cwd, project);
      }
    } catch (error) {
      options.onError(
        `Action "${action.name}" failed.\n${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
