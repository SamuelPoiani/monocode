import { useRef, useState, useSyncExternalStore } from "react";
import { IconButton } from "../../../app/shell/TitleBar";
import { MOD } from "../../../platform/tauri/platform";
import {
  ChevronDown,
  Pencil,
  Play,
  Plus,
  Search,
} from "../../../shared/ui/icons";
import {
  ExplorerMenu,
  type ExplorerMenuItem,
} from "../../files/ui/ExplorerMenu";
import { quickComposerShortcutLabel } from "../../quick-composer/model/quickComposerShortcut";
import { isLocalProject } from "../model/recents";
import {
  lastRunProjectActionId,
  listProjectActions,
  projectActionsRevision,
  projectActionShortcut,
  subscribeProjectActions,
  type ProjectAction,
} from "../model/projectActions";
import { ProjectActionDialog } from "./ProjectActionDialog";
import { projectActionIcons } from "./projectActionIcons";

export function ProjectActionsButton({
  project,
  onRun,
}: {
  project: string;
  onRun: (action: ProjectAction) => void;
}) {
  useSyncExternalStore(subscribeProjectActions, projectActionsRevision);
  const [menu, setMenu] = useState<{ x: number; y: number }>();
  const [editing, setEditing] = useState<ProjectAction | "new">();
  const root = useRef<HTMLDivElement>(null);
  const actions = listProjectActions(project);
  const last =
    actions.find((action) => action.id === lastRunProjectActionId(project)) ??
    actions[0];
  const chord = last && projectActionShortcut(last.name);
  const Icon = last ? projectActionIcons[last.icon ?? "Play"] : Play;
  const items: ExplorerMenuItem[] = actions.map((action) => ({
    kind: "item",
    id: `run:${action.id}`,
    label: action.name,
    shortcut: projectActionShortcut(action.name)
      ? quickComposerShortcutLabel(projectActionShortcut(action.name)!)
      : undefined,
    secondary: {
      id: `edit:${action.id}`,
      label: `Edit ${action.name}`,
      icon: <Pencil className="size-3.5" strokeWidth={1.75} />,
    },
  }));
  items.push({ kind: "sep" }, { kind: "item", id: "add", label: "Add action" });
  return (
    <div
      ref={root}
      className="flex shrink-0 items-center"
      data-tauri-drag-region="false"
    >
      <IconButton
        label={
          last
            ? `Run ${last.name}${chord ? ` (${quickComposerShortcutLabel(chord)})` : ""}`
            : "Add action"
        }
        onClick={() => (last ? onRun(last) : setEditing("new"))}
      >
        <Icon className="size-3.5" strokeWidth={1.75} />
      </IconButton>
      {last ? (
        <IconButton
          label="Project actions"
          onClick={() => {
            const rect = root.current?.getBoundingClientRect();
            if (rect) setMenu({ x: rect.right - 228, y: rect.bottom + 4 });
          }}
        >
          <ChevronDown className="size-3" strokeWidth={1.75} />
        </IconButton>
      ) : null}
      {menu ? (
        <ExplorerMenu
          x={menu.x}
          y={menu.y}
          ariaLabel="Project actions"
          items={items}
          onClose={() => setMenu(undefined)}
          onPick={(id) => {
            setMenu(undefined);
            if (id === "add") {
              setEditing("new");
              return;
            }
            const action = actions.find(
              (entry) => entry.id === id.slice(id.indexOf(":") + 1),
            );
            if (!action) return;
            if (id.startsWith("edit:")) setEditing(action);
            else onRun(action);
          }}
        />
      ) : null}
      {editing ? (
        <ProjectActionDialog
          project={project}
          action={editing === "new" ? undefined : editing}
          onClose={() => setEditing(undefined)}
        />
      ) : null}
    </div>
  );
}

export function WorkspaceTitleActions({
  project,
  onSearch,
  onNew,
  onRunAction,
}: {
  project?: string;
  onSearch?: () => void;
  onNew?: () => void;
  onRunAction?: (action: ProjectAction) => void;
}) {
  return (
    <div
      className="flex shrink-0 items-center gap-0.5"
      data-tauri-drag-region="false"
    >
      {project && isLocalProject(project) && onRunAction ? (
        <ProjectActionsButton
          key={project}
          project={project}
          onRun={onRunAction}
        />
      ) : null}
      {onSearch ? (
        <IconButton label={`Go to File (${MOD}P)`} onClick={onSearch}>
          <Search className="size-3.5" strokeWidth={1.75} />
        </IconButton>
      ) : null}
      {onNew ? (
        <IconButton label={`New session (${MOD}T)`} onClick={onNew}>
          <Plus className="size-3.5" strokeWidth={1.75} />
        </IconButton>
      ) : null}
    </div>
  );
}
