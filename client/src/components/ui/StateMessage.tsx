import type { ReactNode } from "react";
import { AlertCircle, WifiOff } from "../icons";

/**
 * Empty / error / offline / not-found message. Copy formula: empty = what this is + how to
 * fill it; error = what failed + the fix. Never apologise, never show raw errors in the body:
 * put them in `details` (collapsed "Technical details").
 * Left-aligned on pages; align="center" inside the player and inside a Panel.
 */
export function StateMessage({ kind, title, body, actions, details, align = "start", icon }: {
  kind: "empty" | "error" | "offline" | "notFound";
  title: ReactNode;
  body?: ReactNode;
  /** One primary-ish Button (solid on pages, tonal in panels) + one ghost */
  actions?: ReactNode;
  details?: string;
  align?: "start" | "center";
  /** Override the default 24px icon; false hides it */
  icon?: ReactNode | false;
}) {
  const def = kind === "offline" ? <WifiOff size={24} /> : kind === "empty" ? null : <AlertCircle size={24} />;
  return (
    <div className="state-msg" data-align={align} role={kind === "error" || kind === "offline" ? "alert" : "status"}>
      {icon === false ? null : (icon ?? def)}
      <p className="state-msg-title">{title}</p>
      {body && <p className="state-msg-body">{body}</p>}
      {actions && <div className="state-msg-actions">{actions}</div>}
      {details && <details><summary>Technical details</summary><pre>{details}</pre></details>}
    </div>
  );
}
