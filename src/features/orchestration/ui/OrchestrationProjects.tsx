import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { pathKey, projectName } from "../../../shared/lib/paths";
import { Check, ChevronDown, Folder } from "../../../shared/ui/icons";
import { Popover } from "../../../shared/ui/Popover";
import {
  subscribeArchivedProjects,
  subscribeProjectPathsChanged,
} from "../../projects/model/recents";
import { orchestrator } from "../model/orchestration";
import {
  availableOrchestrationProjects,
  canonicalProjectRoot,
  nameLinkedProjects,
  projectRootsOverlap,
  selectedOrchestrationProjects,
  setOrchestrationProjects,
  subscribeOrchestrationProjects,
} from "../model/orchestrationProjects";

export function OrchestrationProjects({
  sessionId,
  projectCwd,
  checkoutCwd,
  disabled = false,
}: {
  sessionId: string;
  projectCwd: string;
  checkoutCwd: string;
  disabled?: boolean;
}) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [revision, setRevision] = useState(0);
  const [projects, setProjects] = useState<{ path: string; root: string }[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const paths = useSyncExternalStore(
    subscribeOrchestrationProjects,
    () => selectedOrchestrationProjects(sessionId),
  );
  const runs = useSyncExternalStore(orchestrator.subscribe, orchestrator.snapshot);
  const run = runs.find((entry) => entry.leadId === sessionId);
  const locked = run?.status === "active" || run?.status === "paused";
  const linked = locked ? run?.linkedProjects ?? [] : undefined;
  const available = availableOrchestrationProjects(projectCwd, checkoutCwd);
  const selected = paths.filter((path) => available.some((root) => pathKey(root) === pathKey(path)));
  const count = linked?.length ?? selected.length;
  // The `@name:` each project has, or would get if ticked next, named the same way as planning.
  const selectedRoots = selected.flatMap((path) => projects.find((entry) => pathKey(entry.path) === pathKey(path))?.root ?? []);
  const selectedNames = nameLinkedProjects(selectedRoots);
  const mentionName = (root: string) => {
    const index = selectedRoots.findIndex((entry) => pathKey(entry) === pathKey(root));
    if (index >= 0) return selectedNames[index].name;
    const named = nameLinkedProjects([...selectedRoots, root]);
    return named[named.length - 1].name;
  };

  useEffect(() => {
    const changed = () => setRevision((value) => value + 1);
    const unsubscribePaths = subscribeProjectPathsChanged(changed);
    const unsubscribeArchived = subscribeArchivedProjects(changed);
    return () => { unsubscribePaths(); unsubscribeArchived(); };
  }, []);
  useEffect(() => {
    if (!open || locked) return;
    let cancelled = false;
    setLoading(true);
    setError(undefined);
    void (async () => {
      const [checkout, currentProject] = await Promise.all([
        canonicalProjectRoot(checkoutCwd),
        canonicalProjectRoot(projectCwd),
      ]);
      const candidates = await Promise.all(
        availableOrchestrationProjects(projectCwd, checkoutCwd).map(async (path) => {
          try {
            const root = await canonicalProjectRoot(path);
            return projectRootsOverlap(root, checkout) || pathKey(root) === pathKey(currentProject)
              ? undefined
              : { path, root };
          } catch {
            return undefined;
          }
        }),
      );
      if (!cancelled) setProjects(candidates.filter((entry): entry is { path: string; root: string } => !!entry));
    })().catch((reason) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [open, locked, projectCwd, checkoutCwd, revision]);

  return (
    <div className="relative shrink-0" data-orchestration-project-target>
      <button
        ref={anchor}
        type="button"
        aria-label={`Linked projects${count ? `: ${count}` : ""}`}
        aria-expanded={open}
        aria-haspopup="dialog"
        disabled={disabled && !locked}
        onClick={() => setOpen(!open)}
        className="flex h-6.5 items-center gap-1 rounded-md bg-content/5 px-1.5 text-[11px] font-medium text-content/60 hover:bg-content/10 hover:text-content disabled:opacity-40"
      >
        <Folder className="size-3.5" />
        Projects{count ? ` · ${count}` : ""}
        <ChevronDown className="size-3" />
      </button>
      {open && (
        <Popover
          anchor={anchor}
          side="top"
          align="start"
          width={320}
          maxHeight={340}
          role="dialog"
          aria-label="Link imported projects"
          ignore="[data-orchestration-project-target]"
          data-orchestration-project-picker
          onDismiss={() => { setOpen(false); anchor.current?.focus(); }}
          className="flex flex-col p-1.5"
        >
          <p className="px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-content/40">Linked projects</p>
          <p className="px-2 pb-2 text-[11px] leading-4 text-content/45">
            {locked ? "Projects are fixed for this run, including on resume." : "Reference their files with @name: in any message. Orchestration runs can also assign workers there."}
          </p>
          <div className="min-h-0 overflow-y-auto overscroll-contain">
            {linked ? linked.map(({ name, root }) => (
              <div key={name} className="flex items-center gap-2 rounded-lg px-2 py-2">
                <Check className="size-3.5 shrink-0 text-fuchsia-300/80" />
                <span className="min-w-0">
                  <span className="block truncate text-[13px] text-content">
                    {projectName(root)}
                    <span className="ml-1.5 font-mono text-[11px] text-content/45">@{name}:</span>
                  </span>
                  <span title={root} className="block truncate text-[11px] text-content/45">{root}</span>
                </span>
              </div>
            )) : !loading && projects.map(({ path, root }) => {
              const checked = selected.some((entry) => pathKey(entry) === pathKey(path));
              const overlaps = !checked && projects.some((other) =>
                selected.some((entry) => pathKey(entry) === pathKey(other.path)) &&
                projectRootsOverlap(root, other.root),
              );
              return (
                <button
                  key={path}
                  type="button"
                  role="checkbox"
                  aria-checked={checked}
                  disabled={disabled || overlaps}
                  title={overlaps ? "Overlaps another linked project" : root}
                  onClick={() => setOrchestrationProjects(sessionId, checked
                    ? selected.filter((entry) => pathKey(entry) !== pathKey(path))
                    : [...selected, path])}
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left hover:bg-content/10 disabled:opacity-40"
                >
                  <span className="grid size-4 shrink-0 place-items-center rounded border border-content/20">
                    {checked && <Check className="size-3 text-fuchsia-300/80" />}
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-[13px] text-content">
                      {projectName(root)}
                      <span className="ml-1.5 font-mono text-[11px] text-content/45">@{mentionName(root)}:</span>
                    </span>
                    <span className="block truncate text-[11px] text-content/45">{root}</span>
                  </span>
                </button>
              );
            })}
            {error && <p role="alert" className="px-2 py-2 text-[11px] text-red-400">{error}</p>}
            {loading && !locked && <p className="px-2 py-2 text-[11px] text-content/45">Checking project folders…</p>}
            {!error && !loading && !(linked?.length ?? projects.length) && (
              <p className="px-2 py-2 text-[11px] text-content/45">{locked ? "No projects linked." : "Import another project to link it."}</p>
            )}
          </div>
        </Popover>
      )}
    </div>
  );
}
