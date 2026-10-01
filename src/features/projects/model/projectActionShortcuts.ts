import {
  resolveAppShortcut,
  validateActionShortcut,
} from "../../settings/model/appShortcuts";
import { shortcutMatches } from "../../settings/model/settings";
import {
  listProjectActions,
  projectActionShortcut,
  type ProjectAction,
} from "./projectActions";

export function resolveProjectActionShortcut(
  project: string,
  event: Parameters<typeof resolveAppShortcut>[0],
): ProjectAction | null {
  if (event.isComposing || resolveAppShortcut(event)) return null;
  for (const action of listProjectActions(project)) {
    const chord = projectActionShortcut(action.name);
    if (!chord || !shortcutMatches(chord, event)) continue;
    try {
      // Re-check live app bindings: they may have changed since this action was saved.
      validateActionShortcut(chord);
      return action;
    } catch {
      return null;
    }
  }
  return null;
}
