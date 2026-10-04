import { HARNESSES, type Block, type HarnessId, type Session } from "../../sessions/model/session";
import { isEqualOrInside, pathKey } from "../../../shared/lib/paths";
import { linkedProjectRoot, type LinkedProject } from "./orchestrationState";
import { linkedProjectsPrompt } from "./orchestrationProjects";

export type OrchestrationChoice = {
  harness: HarnessId;
  model: string;
  name: string;
};
export type OrchestrationSettings = {
  choices: OrchestrationChoice[];
  maxWorkers: number;
};
export type ProposedTask = {
  id: string;
  title: string;
  prompt: string;
  harness: HarnessId;
  model: string;
  modelSettings?: Record<string, string>;
  files: string[];
  project?: string;
  dependsOn: string[];
};
export type OrchestrationProposal = {
  version: 1;
  leadId: string;
  /** Project identity retained for history and proposal ownership. */
  cwd: string;
  /** Concrete checkout inspected while preparing this proposal. */
  checkoutCwd?: string;
  /** The checkout is a plain folder holding several Git repositories. */
  multiRepo?: boolean;
  linkedProjects?: LinkedProject[];
  request: string;
  author: OrchestrationChoice;
  settings: OrchestrationSettings;
  status: "planning" | "ready" | "invalid" | "starting" | "approved";
  title: string;
  summary: string;
  tasks: ProposedTask[];
  error?: string;
  /** Kept only for invalid cards so a retry can repair the response directly. */
  response?: string;
};

function required(value: unknown, label: string, max = 30_000): string {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new Error(`Provide ${label}`);
  return value.trim();
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected an assignment object");
  return value as Record<string, unknown>;
}
function stringList(value: unknown, label: string, max: number): string[] {
  if (!Array.isArray(value) || value.length > max)
    throw new Error(`Invalid ${label}`);
  return [
    ...new Set(
      value
        .filter((item) => item !== "")
        .map((item) => required(item, label, 512)),
    ),
  ];
}

function scopePath(value: string): string {
  const slashed = value.replace(/\\/g, "/");
  const prefix = slashed.startsWith("//")
    ? "//"
    : /^[A-Za-z]:\//.test(slashed)
      ? slashed.slice(0, 3)
      : slashed.startsWith("/")
        ? "/"
        : "";
  const rest = slashed.slice(prefix.length);
  const parts = rest.split("/").filter((part) => part && part !== ".");
  return `${prefix}${parts.join("/")}` || ".";
}

function projectRelativeScope(
  value: string,
  cwd: string | undefined,
  assignmentId: string,
  project?: string,
): string {
  const slashed = value.replace(/\\/g, "/");
  if (slashed.split("/").includes(".."))
    throw new Error(
      `Assignment "${assignmentId}" has invalid file scope "${value}". Use project-relative paths without '..', or '.' for the whole project`,
    );
  const normalized = scopePath(value);
  if (/^[A-Za-z]:/.test(normalized) && !/^[A-Za-z]:\//.test(normalized))
    throw new Error(
      `Assignment "${assignmentId}" has invalid file scope "${value}". Use project-relative paths, or '.' for the whole project`,
    );
  const absolute =
    normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized);
  if (!absolute) return normalized;
  if (!cwd || !isEqualOrInside(normalized, scopePath(cwd)))
    throw new Error(
      `Assignment "${assignmentId}" uses file scope "${value}" outside the selected checkout${cwd ? ` "${cwd}"` : ""}${project ? ` for project "${project}"` : ". Orchestration currently supports one checkout per run"}`,
    );
  const root = scopePath(cwd);
  if (pathKey(normalized) === pathKey(root)) return ".";
  return normalized.slice(root.length).replace(/^\/+/, "");
}

function stringRecord(value: unknown, label: string): Record<string, string> {
  const input = record(value);
  const entries = Object.entries(input);
  if (entries.length > 32) throw new Error(`Invalid ${label}`);
  return Object.fromEntries(
    entries.map(([key, entry]) => [
      required(key, label, 128),
      required(entry, label, 256),
    ]),
  );
}

export function validateOrchestrationSettings(
  value: unknown,
): OrchestrationSettings {
  const input = record(value);
  if (
    !Number.isInteger(input.maxWorkers) ||
    Number(input.maxWorkers) < 1 ||
    Number(input.maxWorkers) > 4
  )
    throw new Error("Choose 1 to 4 parallel workers");
  if (
    !Array.isArray(input.choices) ||
    !input.choices.length ||
    input.choices.length > 4096
  )
    throw new Error(
      "No worker models are available, or the model catalog is too large. Check your connected harnesses.",
    );
  const choices = input.choices.map((value) => {
    const item = record(value);
    const harness = required(item.harness, "a harness", 32) as HarnessId;
    if (!HARNESSES.includes(harness)) throw new Error("Unknown worker harness");
    return {
      harness,
      model: required(item.model, "a model", 256),
      name: required(item.name, "a model name", 256),
    };
  });
  return {
    maxWorkers: Number(input.maxWorkers),
    choices: choices.filter(
      (choice, index) =>
        choices.findIndex(
          (entry) =>
            entry.harness === choice.harness && entry.model === choice.model,
        ) === index,
    ),
  };
}

/** Validate the entire graph before enabling any process or acquiring scopes. */
export function validateProposedTasks(
  value: unknown,
  settings: OrchestrationSettings,
  cwd?: string,
  linkedProjects?: LinkedProject[],
): ProposedTask[] {
  if (!Array.isArray(value) || !value.length || value.length > 40)
    throw new Error("Provide 1 to 40 assignments");
  const tasks = value.map((value, index) => {
    const task = record(value);
    const label = `assignment ${index + 1}${typeof task.id === "string" ? ` (${task.id})` : ""}`;
    const model = required(task.model, `a model for ${label}`, 256);
    // Models already identify their harness in our catalog. Recover an omitted
    // redundant field without another model call, but never override a choice.
    const matches = settings.choices.filter((choice) => choice.model === model);
    const harnesses = [...new Set(matches.map((choice) => choice.harness))];
    const missingHarness = task.harness == null || task.harness === "";
    const harness = required(
      missingHarness && harnesses.length === 1 ? harnesses[0] : task.harness,
      `a harness for ${label}; use an exact harness/model pair from the available catalog`,
      32,
    ) as HarnessId;
    if (
      !settings.choices.some(
        (choice) => choice.harness === harness && choice.model === model,
      )
    )
      throw new Error(
        `The harness/model pair for ${label} is outside the available catalog: ${harness} / ${model}`,
      );
    const id = required(task.id, "an assignment ID", 64);
    if (!/^[A-Za-z0-9_-]+$/.test(id))
      throw new Error(
        "Assignment IDs must contain letters, numbers, underscores or hyphens",
      );
    const project = task.project === undefined
      ? undefined
      : required(task.project, "a linked project name", 128);
    const root = linkedProjectRoot(project, linkedProjects, cwd ?? "");
    if (project && stringList(task.files, "file scopes", 64).some((path) =>
      /^(?:[\\/]|[A-Za-z]:)/.test(path),
    ))
      throw new Error(`Assignment "${id}" must use paths relative to project "${project}", without absolute paths`);
    const files = [
      ...new Set(
        stringList(task.files, "file scopes", 64).map((path) =>
          projectRelativeScope(path, root || undefined, id, project),
        ),
      ),
    ];
    if (!files.length)
      throw new Error(
        `Assignment "${id}" has no file scopes. Use project-relative paths, or '.' for the whole project`,
      );
    return {
      id,
      title: required(task.title, "a task title", 160),
      prompt: required(task.prompt, "task instructions"),
      harness,
      model,
      ...(task.modelSettings === undefined
        ? {}
        : {
            modelSettings: stringRecord(task.modelSettings, "model settings"),
          }),
      files,
      ...(project === undefined ? {} : { project }),
      dependsOn: stringList(task.dependsOn ?? [], "dependencies", 40),
    };
  });
  const ids = new Set(tasks.map((task) => task.id));
  if (ids.size !== tasks.length)
    throw new Error("Assignment IDs must be unique");
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const visit = (id: string) => {
    if (!ids.has(id))
      throw new Error("A dependency references an unknown assignment");
    if (visiting.has(id))
      throw new Error("Assignments have a dependency cycle");
    if (visited.has(id)) return;
    visiting.add(id);
    tasks.find((task) => task.id === id)!.dependsOn.forEach(visit);
    visiting.delete(id);
    visited.add(id);
  };
  tasks.forEach((task) => visit(task.id));
  return tasks;
}

export function orchestrationPlanningPrompt(
  request: string,
  settings: OrchestrationSettings,
  cwd: string,
  multiRepo = false,
  linkedProjects?: LinkedProject[],
): string {
  const validation = multiRepo
    ? 'The checkout root is a plain folder holding several Git repositories, and each worker is isolated in a copy of one of them: every task\'s files must stay inside a single nested repository (for example ["api/src"]; never ["."] or files from two repositories). Assign repository-wide generation or validation to a task whose files are that repository\'s folder, such as ["api"]; the lead runs any cross-repository validation itself after integrating the workers.'
    : 'Assign project-wide generation or final combined validation to a task with files ["."].';
  return [
    "Prepare an orchestration proposal for the user to review in MonoCode. Investigate and plan only: do not edit files, start workers, or invoke the MonoCode control CLI. No execution is authorized until the user confirms the assignment card.",
    "First decide whether the request benefits from delegation at all. The presence of worker capabilities does not create an obligation to use them. For simple tasks that only require reading or investigating the project, use your own tools. This includes conversational questions, explanations, listing directories, searching the project, reading files, inspecting code, answering questions about the repository, and other straightforward investigation. In those cases, answer directly in prose and do not emit <monocode_proposal>. Do not create a worker merely to perform one or a few tool calls that you could perform yourself.",
    "Propose worker assignments whenever the request requires changing files, since you cannot edit during planning. For small or tightly scoped edits, propose a single task on a fast, economical model instead of splitting the work. Use multiple workers only when delegation provides a meaningful benefit, such as independent or parallel workstreams, substantial work spanning distinct areas of the project, useful context isolation, specialist expertise or independent review.",
    "You are the orchestrator: the user selected you in the composer model picker. When delegation is warranted, decide the task breakdown and choose each worker's harness and model from the available catalog below. Do not ask the user to assemble a team. They can change your choices in the card before confirming.",
    "Keep planning efficient: inspect only what is needed to understand the request and relevant project conventions. Use the fewest useful tasks, with clear deliverables and acceptance checks. Do not create agents for trivial steps, investigation the lead can efficiently perform itself, or duplicate investigation. Prefer a fast, economical model for straightforward delegated work and a more capable model when complexity warrants it; do not invent model capabilities or prices. Reuse a suitable harness/model across tasks when that is sufficient. Explain your overall division of work briefly in the summary.",
    `Use only exact harness/model pairs from the catalog. Give each task self-contained instructions and project-relative write scopes; directories own their descendants. Parallelize independent work with disjoint files. Serialize shared-file edits with dependencies and avoid concurrent repository-wide commands. ${linkedProjects?.length ? "For tasks without project: " : ""}${validation} Workers must not commit, push, switch branches, or write outside the selected checkout. If the user requested Git or cross-checkout finalization, do not create a worker for it: the lead performs only those explicitly authorized final operations after every worker is reviewed, integrated, and the orchestration run is finished. All workers use app-managed isolated checkouts; do not ask them to create or switch worktrees.`,
    `The exact checkout root is ${JSON.stringify(cwd)}. Every files entry must be ${multiRepo ? "" : '"." or '}a path relative to ${linkedProjects?.length ? "this root when project is omitted, or the named linked project root when project is set" : "this root"}. For example, a discovered absolute path beneath this root must be returned without the root prefix. Never use an absolute path or '..'.`,
    ...(linkedProjects?.length ? [linkedProjectsPrompt(linkedProjects)] : []),
    "When you do propose assignments, return your final proposal as one JSON object inside <monocode_proposal>...</monocode_proposal>. The app renders it as an editable card, so do not ask for approval in prose. No Markdown inside the JSON fields. Tasks may reference any task ID; the graph must be acyclic.",
    'Schema: {"title":"Short project title","summary":"What you will do and how the work fits together","tasks":[{"id":"task-1","title":"Short task title","prompt":"Self-contained instructions, constraints and checks","harness":"exact harness ID","model":"exact model ID","files":["src/feature"],"dependsOn":[]}]}',
    ...(linkedProjects?.length ? ['Optional task field: "project":"exact linked project name".'] : []),
    `Parallel worker limit: ${settings.maxWorkers}`,
    `<available_models>\n${JSON.stringify(settings.choices)}\n</available_models>`,
    `<user_request>\n${request}\n</user_request>`,
  ].join("\n\n");
}

export function completeOrchestrationProposal(
  draft: OrchestrationProposal,
  response: string,
  error?: string,
): OrchestrationProposal {
  try {
    if (error) throw new Error(error);
    const tagged = response.match(
      /<monocode_proposal>\s*([\s\S]*?)\s*<\/monocode_proposal>/,
    );
    const fenced = response.match(/```(?:json)?\s*([\s\S]*?)```/);
    const raw = (tagged?.[1] ?? fenced?.[1] ?? response).trim();
    const input = record(JSON.parse(raw));
    return {
      ...draft,
      title: required(input.title, "a proposal title", 160),
      summary: required(input.summary, "a proposal summary", 2000),
      tasks: validateProposedTasks(
        input.tasks,
        draft.settings,
        draft.checkoutCwd ?? draft.cwd,
        draft.linkedProjects,
      ),
      status: "ready",
      error: undefined,
      response: undefined,
    };
  } catch (reason) {
    return {
      ...draft,
      status: "invalid",
      response: response.slice(-200_000),
      error:
        error ??
        `Could not prepare the assignment card: ${reason instanceof Error ? reason.message : String(reason)}`,
    };
  }
}

export function orchestrationRepairPrompt(
  proposal: OrchestrationProposal,
): string {
  return [
    orchestrationPlanningPrompt(
      proposal.request,
      proposal.settings,
      proposal.checkoutCwd ?? proposal.cwd,
      proposal.multiRepo,
      proposal.linkedProjects,
    ),
    "Correct the previous proposal using the validation error below. Reuse your investigation and task breakdown; do not inspect the project again or run tools. Return only the corrected <monocode_proposal> JSON. Include an exact harness and model on every task. Do not execute any assignments.",
    `Validation error: ${proposal.error ?? "The previous proposal was invalid"}`,
    `<previous_response>\n${proposal.response?.slice(-60_000) ?? ""}\n</previous_response>`,
  ].join("\n\n");
}

/**
 * The lead answered in prose instead of proposing assignments: no proposal
 * tag and nothing shaped like a task list.
 */
export function isDirectOrchestrationAnswer(response: string): boolean {
  return (
    !!response.trim() &&
    !/<monocode_proposal>/.test(response) &&
    !/"tasks"\s*:/.test(response)
  );
}

/** At most one corrective turn; provider failures and cancellation never loop. */
export async function completeOrRepairOrchestrationProposal(
  draft: OrchestrationProposal,
  response: string,
  repair: (prompt: string) => Promise<string>,
  canRepair: () => boolean,
): Promise<OrchestrationProposal> {
  const first = completeOrchestrationProposal(draft, response);
  if (
    first.status !== "invalid" ||
    !canRepair() ||
    isDirectOrchestrationAnswer(response)
  )
    return first;
  const corrected = await repair(orchestrationRepairPrompt(first));
  return completeOrchestrationProposal(draft, corrected);
}

export function proposalMarkdown(proposal: OrchestrationProposal): string {
  return [
    `# ${proposal.title}`,
    proposal.summary,
    ...proposal.tasks.map(
      (task) =>
        `## ${task.title}\n${task.harness} · ${proposal.settings.choices.find((choice) => choice.harness === task.harness && choice.model === task.model)?.name ?? task.model}\n${task.prompt}\n${task.project ? `Project: ${task.project}\n` : ""}Files: ${task.files.join(", ")}\nDepends on: ${task.dependsOn.join(", ") || "None"}`,
    ),
  ].join("\n\n");
}

export function withOrchestrationProposal(
  session: Session,
  blockId: string,
  proposal: OrchestrationProposal,
): Session {
  return {
    ...session,
    blocks: session.blocks.map((block) =>
      block.id === blockId
        ? {
            ...block,
            text: proposalMarkdown(proposal),
            orchestration: proposal,
            streaming: proposal.status === "planning",
          }
        : block,
    ),
  };
}

export function proposalBlock(
  id: string,
  proposal: OrchestrationProposal,
): Block {
  return {
    id,
    role: "plan",
    text: proposalMarkdown(proposal),
    orchestration: proposal,
    streaming: true,
  };
}

/** A reload must never turn a half-generated card into an executable plan. */
export function restoreOrchestrationProposal(
  value: OrchestrationProposal,
): OrchestrationProposal {
  if (value.status === "planning")
    return {
      ...value,
      status: "invalid",
      error: "Planning was interrupted. Generate the assignments again.",
    };
  if (value.status === "starting") return { ...value, status: "ready" };
  return value;
}
