import { writePty } from "../../../platform/tauri/pty";

const consumed = new Set<string>();

/** Called only after spawn succeeds. Claim before writing so remounts cannot replay it. */
export async function consumeInitialCommand(
  id: string,
  command: string | undefined,
): Promise<void> {
  if (!command || consumed.has(id)) return;
  consumed.add(id);
  await writePty(id, `${command}\r`);
}
