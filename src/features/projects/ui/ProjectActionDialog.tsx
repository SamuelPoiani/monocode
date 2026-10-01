import { useEffect, useRef, useState, type FormEvent } from "react";
import { Modal } from "../../../shared/ui/Modal";
import {
  addProjectAction,
  PROJECT_ACTION_ICONS,
  projectActionShortcut,
  removeProjectAction,
  setProjectActionShortcut,
  updateProjectAction,
  type ProjectAction,
  type ProjectActionIcon,
} from "../model/projectActions";
import { ProjectActionShortcutRecorder } from "./ProjectActionShortcutRecorder";
import { projectActionIcons } from "./projectActionIcons";

export function ProjectActionDialog({
  project,
  action,
  onClose,
}: {
  project: string;
  action?: ProjectAction;
  onClose: () => void;
}) {
  const [name, setName] = useState(action?.name ?? "");
  const [icon, setIcon] = useState<ProjectActionIcon>(action?.icon ?? "Play");
  const [iconsOpen, setIconsOpen] = useState(false);
  const [command, setCommand] = useState(action?.command ?? "");
  const [automatic, setAutomatic] = useState(
    action?.runOnWorktreeCreate ?? false,
  );
  const [wait, setWait] = useState(action?.waitBeforeAgent ?? false);
  const [shortcut, setShortcut] = useState(
    action ? projectActionShortcut(action.name) : undefined,
  );
  const [error, setError] = useState<string>();
  const nameInput = useRef<HTMLInputElement>(null);
  const Icon = projectActionIcons[icon];
  useEffect(() => {
    const frame = requestAnimationFrame(() => nameInput.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, []);

  const save = (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim() || !command.trim()) return;
    try {
      setProjectActionShortcut(name, shortcut);
      const value = {
        name,
        icon,
        command,
        runOnWorktreeCreate: automatic,
        waitBeforeAgent: automatic && wait,
      };
      if (action) updateProjectAction(project, action.id, value);
      else addProjectAction(project, value);
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };
  const field =
    "h-9 rounded-md border border-content/10 bg-background-base px-2.5 text-[13px] outline-none focus:border-content/25";
  return (
    <Modal
      title={action ? "Edit Action" : "Add Action"}
      size="md"
      onClose={onClose}
    >
      <form className="flex flex-col gap-4 p-4" onSubmit={save}>
        <p className="text-[12px] text-content/55">
          Actions are project-scoped commands you can run from the top bar or
          keybindings.
        </p>
        <div className="flex flex-col gap-1.5 text-[12px] text-content/70">
          <label htmlFor="project-action-name">Name</label>
          <div className="flex gap-2">
            <button
              type="button"
              aria-label="Choose action icon"
              aria-expanded={iconsOpen}
              onClick={() => setIconsOpen(!iconsOpen)}
              className={`${field} grid size-9 shrink-0 place-items-center px-0 hover:bg-content/8`}
            >
              <Icon className="size-4" />
            </button>
            <input
              ref={nameInput}
              id="project-action-name"
              className={`${field} min-w-0 flex-1`}
              value={name}
              autoComplete="off"
              onChange={(event) => {
                setName(event.target.value);
                setShortcut(projectActionShortcut(event.target.value));
                setError(undefined);
              }}
            />
          </div>
          {iconsOpen ? (
            <div className="flex gap-1" role="group" aria-label="Action icons">
              {PROJECT_ACTION_ICONS.map((value) => {
                const OptionIcon = projectActionIcons[value];
                return (
                  <button
                    key={value}
                    type="button"
                    aria-label={value}
                    aria-pressed={icon === value}
                    className={`grid size-8 place-items-center rounded-md hover:bg-content/8 ${icon === value ? "bg-content/10 text-content" : ""}`}
                    onClick={() => {
                      setIcon(value);
                      setIconsOpen(false);
                    }}
                  >
                    <OptionIcon className="size-4" />
                  </button>
                );
              })}
            </div>
          ) : null}
        </div>
        <div className="flex flex-col gap-1.5 text-[12px] text-content/70">
          <label htmlFor="project-action-shortcut">Keybinding</label>
          <ProjectActionShortcutRecorder
            name={name}
            shortcut={shortcut}
            onChange={setShortcut}
            className={field}
          />
          <p className="text-[11px] leading-relaxed text-content/45">
            Press a shortcut. Use Backspace to clear. Shortcuts are
            environment-wide. Projects using the same action share its shortcut.
          </p>
        </div>
        <div className="flex flex-col gap-1.5 text-[12px] text-content/70">
          <label htmlFor="project-action-command">Command</label>
          <textarea
            id="project-action-command"
            className={`${field} h-28 resize-y py-2 font-mono`}
            value={command}
            spellCheck={false}
            onChange={(event) => setCommand(event.target.value)}
          />
        </div>
        <ActionToggle
          label="Run automatically on worktree creation"
          on={automatic}
          onChange={setAutomatic}
        />
        <ActionToggle
          label="Wait for it to finish before the agent starts"
          on={automatic && wait}
          onChange={setWait}
          disabled={!automatic}
        />
        {error ? (
          <p role="alert" className="text-[12px] text-red-400">
            {error}
          </p>
        ) : null}
        <div className="flex items-center justify-end gap-2">
          {action ? (
            <button
              type="button"
              className="mr-auto rounded-md px-3 py-1.5 text-[12px] text-red-400 hover:bg-red-500/10"
              onClick={() => {
                removeProjectAction(project, action.id);
                onClose();
              }}
            >
              Delete
            </button>
          ) : null}
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-[12px] hover:bg-content/8 active:scale-[0.97]"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!name.trim() || !command.trim()}
            className="inline-flex items-center gap-1.5 rounded-md bg-content px-3 py-1.5 text-[12px] font-medium text-background-base disabled:opacity-40 active:scale-[0.97]"
          >
            Save action
          </button>
        </div>
      </form>
    </Modal>
  );
}

function ActionToggle({
  label,
  on,
  onChange,
  disabled = false,
}: {
  label: string;
  on: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div
      className={`flex items-center justify-between gap-3 text-[12px] ${disabled ? "text-content/35" : "text-content/70"}`}
    >
      <span>{label}</span>
      <button
        type="button"
        role="switch"
        aria-label={label}
        aria-checked={on}
        disabled={disabled}
        onClick={() => onChange(!on)}
        className={`relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:opacity-40 ${on ? "bg-accent" : "bg-content/20"}`}
      >
        <span
          className={`absolute top-0.5 size-4 rounded-full bg-white transition-[left] ${on ? "left-4.5" : "left-0.5"}`}
        />
      </button>
    </div>
  );
}
