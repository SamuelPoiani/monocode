import {
  applyFileMentionsToTurn,
  type MentionProject,
} from "../../files/model/fileMentions";
import { applyNotesToTurn } from "../../notes";
import {
  applySkillsToTurn,
  warmNativeSkills,
  isNativeCommandPrompt,
  type SkillCatalogContext,
} from "../../skills/model/skills";
import { nativeCommandPrompt } from "../../../integrations/harness/core/nativeCommands";
import { pathKey } from "../../../shared/lib/paths";

/** Linked projects already explained to each conversation, by session, harness
 * and working directory. In memory only: after a restart the note is sent once
 * more, which is harmless. */
const introducedProjects = new Map<string, Set<string>>();

function firstMentionTracker(context: SkillCatalogContext) {
  if (!context.sessionId) return undefined;
  const key = [context.sessionId, context.harness, pathKey(context.cwd)].join(
    "\n",
  );
  return (project: MentionProject) => {
    let seen = introducedProjects.get(key);
    if (!seen) introducedProjects.set(key, (seen = new Set()));
    const root = pathKey(project.root);
    if (seen.has(root)) return false;
    seen.add(root);
    return true;
  };
}

export async function preparePrompt(
  text: string,
  context: SkillCatalogContext,
  linkedProjects: MentionProject[] = [],
): Promise<string> {
  warmNativeSkills(context);
  if (isNativeCommandPrompt(text, context.harness))
    return nativeCommandPrompt(context.harness, text);
  const withFiles = await applyFileMentionsToTurn(
    text,
    context.cwd,
    linkedProjects,
    firstMentionTracker(context),
  );
  const withNotes = await applyNotesToTurn(withFiles);
  return applySkillsToTurn(withNotes, context);
}
