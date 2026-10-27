import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { AlertCircle, Check, Info } from "../icons";
import { Button } from "./Button";

export interface ToastOptions {
  tone?: "success" | "error" | "info";
  /** One optional action: "Undo", "Change", "Switch" */
  action?: { label: string; onClick: () => void };
}
interface ToastData extends ToastOptions { id: number; message: string }

// Tiny store: one toast at a time, a newer one replaces the older.
let current: ToastData | null = null;
let seq = 0;
let claims = 0;   // >0 while an in-player <Toaster placement="top"> is mounted
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());
const subscribe = (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; };

/** Show a toast: one sentence, optional single action. */
export function toast(message: string, opts: ToastOptions = {}) { current = { id: ++seq, message, ...opts }; emit(); }
export function dismissToast() { current = null; emit(); }

/**
 * Mount once in App (bottom-centre on phone/tablet, bottom-left on desktop). The player mounts its
 * own <Toaster placement="top" /> inside the player element; while it's mounted it takes over,
 * so toasts appear top-centre over the video (also in fullscreen).
 */
export function Toaster({ placement = "bottom" }: { placement?: "bottom" | "top" }) {
  const t = useSyncExternalStore(subscribe, () => current);
  const claimed = useSyncExternalStore(subscribe, () => claims > 0);
  useEffect(() => {
    if (placement !== "top") return;
    claims++; emit();
    return () => { claims--; emit(); };
  }, [placement]);
  const active = placement === "top" || !claimed;
  return (
    <div className="toaster" data-placement={placement} role="status" aria-live="polite">
      {active && t && <ToastView key={t.id} t={t} />}
    </div>
  );
}

function ToastView({ t }: { t: ToastData }) {
  const [leaving, setLeaving] = useState(false);
  const paused = useRef(false);
  const ctl = useRef({ pause: () => {}, resume: () => {} });
  useEffect(() => {
    let left = t.action ? 8000 : 4000, start = Date.now(), timer = 0;
    const run = () => { start = Date.now(); timer = window.setTimeout(() => setLeaving(true), left); };
    const pause = () => { if (!paused.current) { paused.current = true; window.clearTimeout(timer); left -= Date.now() - start; } };
    const resume = () => { if (paused.current) { paused.current = false; run(); } };
    run();
    ctl.current = { pause, resume };
    return () => window.clearTimeout(timer);
  }, [t]);
  useEffect(() => {
    if (!leaving) return;
    const r = window.setTimeout(() => { if (current?.id === t.id) dismissToast(); }, 200);
    return () => window.clearTimeout(r);
  }, [leaving, t.id]);
  const Icon = t.tone === "success" ? Check : t.tone === "error" ? AlertCircle : Info;
  return (
    <div className="toast" data-leaving={leaving ? "" : undefined}
      onPointerEnter={() => ctl.current.pause()} onPointerLeave={() => ctl.current.resume()}
      onFocus={() => ctl.current.pause()} onBlur={() => ctl.current.resume()}>
      <Icon size={20} className="toast-icon" data-tone={t.tone} aria-hidden="true" />
      <span className="toast-msg">{t.message}</span>
      {t.action && <Button variant="ghost" size="sm" onClick={() => { t.action!.onClick(); dismissToast(); }}>{t.action.label}</Button>}
    </div>
  );
}
