"use client";

import { useEffect, useRef, useState } from "react";
import { Pencil } from "lucide-react";

interface Props {
  /** Current value to display / edit */
  value: string;
  /** Called with the trimmed new name only when it differs from the current value */
  onSave: (newName: string) => Promise<void>;
  /** Tailwind classes applied to the text part of the display row */
  displayClassName?: string;
  /** Tailwind classes applied to the <input> */
  inputClassName?: string;
  /**
   * Optional click handler fired before entering edit mode.
   * Use to call e.stopPropagation() when the component sits inside a clickable row.
   */
  onClickCapture?: (e: React.MouseEvent) => void;
}

export default function InlineEdit({
  value,
  onSave,
  displayClassName = "",
  inputClassName = "",
  onClickCapture,
}: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  // Prevents onBlur from double-firing after Enter / Esc
  const handledRef = useRef(false);

  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  // ── actions ──────────────────────────────────────────────────────────────────

  const startEdit = (e: React.MouseEvent) => {
    onClickCapture?.(e);
    setDraft(value);
    setEditing(true);
  };

  const commit = async () => {
    const trimmed = draft.trim();
    setEditing(false);
    if (!trimmed || trimmed === value) { setDraft(value); return; }
    setSaving(true);
    try {
      await onSave(trimmed);
    } catch {
      setDraft(value);
    } finally {
      setSaving(false);
    }
  };

  const cancel = () => { setDraft(value); setEditing(false); };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter")  { e.preventDefault(); handledRef.current = true; commit(); }
    if (e.key === "Escape") { e.preventDefault(); handledRef.current = true; cancel(); }
  };

  const handleBlur = () => {
    if (handledRef.current) { handledRef.current = false; return; }
    commit();
  };

  // ── render ───────────────────────────────────────────────────────────────────

  if (editing) {
    return (
      <input
        ref={inputRef}
        value={draft}
        disabled={saving}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={handleBlur}
        className={inputClassName}
      />
    );
  }

  return (
    // Wrapper: inline-flex so the pencil sits beside the text without wrapping.
    // group/ie scopes the hover so only THIS component's icon responds.
    // min-w-0 + max-w-full let flex parents truncate the text properly.
    <span
      className={`group/ie inline-flex items-center gap-1.5 min-w-0 max-w-full ${saving ? "opacity-50" : ""}`}
    >
      {/* Text — cursor-text signals clickability; min-w-0 + truncate keep it in bounds */}
      <span
        className={`${displayClassName} min-w-0 truncate cursor-text`}
        onClick={startEdit}
        title="Click to rename"
      >
        {value}
      </span>

      {/* Pencil icon — hidden until the wrapper is hovered */}
      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()} // prevent blur on the parent before click fires
        onClick={startEdit}
        tabIndex={-1}
        aria-label="Rename"
        title="Rename"
        className="flex-shrink-0 text-slate-300 hover:text-slate-500 transition-colors
                   opacity-0 group-hover/ie:opacity-100"
      >
        <Pencil size={13} strokeWidth={1.75} />
      </button>
    </span>
  );
}
