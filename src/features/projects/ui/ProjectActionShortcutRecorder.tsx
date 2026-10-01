import { useEffect, useRef, useState } from "react";
import {
  quickComposerShortcutLabel,
  quickComposerShortcutPreview,
  shortcutFromKeyEvent,
} from "../../quick-composer/model/quickComposerShortcut";
import { IS_MAC } from "../../../platform/tauri/platform";
import { validateProjectActionShortcut } from "../model/projectActions";

export function ProjectActionShortcutRecorder({
  name,
  shortcut,
  onChange,
  className,
}: {
  name: string;
  shortcut?: string;
  onChange: (value: string | undefined) => void;
  className: string;
}) {
  const [recording, setRecording] = useState(false);
  const [preview, setPreview] = useState("");
  const [error, setError] = useState<string>();
  const held = useRef({
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
  });
  useEffect(() => {
    if (!recording) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      const bare =
        !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;
      if (bare && event.code === "Tab") {
        setRecording(false);
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.code === "Escape") {
        setRecording(false);
        return;
      }
      if (bare && event.code === "Backspace") {
        onChange(undefined);
        setError(undefined);
        setRecording(false);
        return;
      }
      const modifier = shortcutModifier(event);
      if (modifier) held.current[modifier] = true;
      const modifiers = {
        metaKey: event.metaKey || held.current.metaKey,
        ctrlKey: event.ctrlKey || held.current.ctrlKey,
        altKey: event.altKey || held.current.altKey,
        shiftKey: event.shiftKey || held.current.shiftKey,
      };
      setPreview(
        quickComposerShortcutPreview(
          modifiers,
          modifier ? undefined : event.code,
          event.key,
        ),
      );
      if (modifier) return;
      // A rejected chord must not linger in the field looking accepted, or the
      // blur that follows reads as the shortcut being cancelled.
      const reject = (reason: string) => {
        setPreview("");
        setError(reason);
      };
      const chord = shortcutFromKeyEvent({ ...modifiers, code: event.code });
      if (!chord) {
        reject(
          IS_MAC
            ? "Hold ⌘, ⌃ or ⌥ with the key"
            : "Hold Ctrl, Alt or Win with the key",
        );
        return;
      }
      try {
        onChange(validateProjectActionShortcut(name, chord));
        setRecording(false);
        setError(undefined);
      } catch (reason) {
        reject(reason instanceof Error ? reason.message : String(reason));
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      const modifier = shortcutModifier(event);
      if (!modifier) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      held.current[modifier] = false;
      setPreview(quickComposerShortcutPreview(held.current));
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", onKeyUp, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("keyup", onKeyUp, true);
    };
  }, [name, onChange, recording]);
  const begin = () => {
    held.current = {
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
    };
    setPreview("");
    setError(undefined);
    setRecording(true);
  };
  return (
    <>
      <input
        id="project-action-shortcut"
        readOnly
        className={className}
        data-shortcut-recorder-active={recording ? "true" : undefined}
        // Lets Escape stop recording instead of closing the whole dialog.
        data-dialog-popover={recording ? "" : undefined}
        value={
          recording
            ? preview || "Press shortcut"
            : shortcut
              ? quickComposerShortcutLabel(shortcut)
              : "Press shortcut"
        }
        onFocus={begin}
        onClick={begin}
        onBlur={() => setRecording(false)}
      />
      {error ? (
        <p role="alert" className="text-[12px] text-red-400">
          {error}
        </p>
      ) : null}
    </>
  );
}

function shortcutModifier(
  event: KeyboardEvent,
): "metaKey" | "ctrlKey" | "altKey" | "shiftKey" | null {
  if (event.key === "Meta" || event.code.startsWith("Meta")) return "metaKey";
  if (event.key === "Control" || event.code.startsWith("Control"))
    return "ctrlKey";
  if (event.key === "Alt" || event.code.startsWith("Alt")) return "altKey";
  if (event.key === "Shift" || event.code.startsWith("Shift"))
    return "shiftKey";
  return null;
}
