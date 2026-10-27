import { useEffect, useId, useRef, type ReactNode } from "react";
import { Button } from "./ui";

/**
 * Destructive-action confirmation (design-system §8.12). Native modal <dialog>: focus trap,
 * Esc and the top layer (works over a fullscreen player too). Buttons are verbs:
 *   <ConfirmDialog title="Clear watch history?" confirm="Clear history" cancel="Keep history" … />
 * Focus starts on the cancel button so Enter never destroys by accident.
 */
export default function ConfirmDialog({ title, body, confirm, cancel = "Cancel", danger = true, onConfirm, onClose }: {
  title: string; body?: ReactNode; confirm: string; cancel?: string; danger?: boolean;
  onConfirm: () => void; onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  useEffect(() => { const d = ref.current; d?.showModal(); return () => d?.close(); }, []);
  return (
    <dialog ref={ref} className="dialog" aria-labelledby={`${id}-t`} onCancel={(e) => { e.preventDefault(); onClose(); }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="dialog-inner">
      <h2 id={`${id}-t`} className="dialog-title">{title}</h2>
      {body && <p className="dialog-body">{body}</p>}
      <div className="dialog-actions">
        <Button variant="ghost" onClick={onClose} autoFocus>{cancel}</Button>
        <Button variant={danger ? "danger" : "solid"} onClick={() => { onConfirm(); onClose(); }}>{confirm}</Button>
      </div>
      </div>
    </dialog>
  );
}
