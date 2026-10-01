import { invoke } from "@tauri-apps/api/core";

export type ProjectActionResult = {
  exitCode: number | null;
  output: string;
  timedOut: boolean;
};

export function runProjectAction(
  cwd: string,
  command: string,
): Promise<ProjectActionResult> {
  return invoke<ProjectActionResult>("run_project_action", { cwd, command });
}
