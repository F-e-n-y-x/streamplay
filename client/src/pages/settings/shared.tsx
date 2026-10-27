import { useState, type ReactNode } from "react";
import { api } from "../../lib/api";
import { useConfig } from "../../lib/queries";
import { setAdminToken, useAdminToken } from "../../lib/settings";
import { Button, StatusDot } from "../../components/ui";
import { Lock } from "../../components/icons";

/** Setting with a control that isn't a whole-row toggle: label + helper left, control right
 *  (stacked under it on narrow screens). */
export function Field({ label, desc, children, stack }: { label: ReactNode; desc?: ReactNode; children: ReactNode; stack?: boolean }) {
  return (
    <div className="set-field" data-stack={stack ? "" : undefined}>
      <div className="set-field-text">
        <span className="set-label">{label}</span>
        {desc && <span className="set-desc">{desc}</span>}
      </div>
      <div className="set-control">{children}</div>
    </div>
  );
}

/** A titled group of rows inside a section. */
export function Group({ title, desc, children }: { title?: string; desc?: ReactNode; children: ReactNode }) {
  return (
    <section className="set-group">
      {title && <h3 className="set-group-title">{title}</h3>}
      {desc && <p className="set-group-desc">{desc}</p>}
      {children}
    </section>
  );
}

/**
 * Admin state. `lock` = ADMIN_TOKEN is set on the server (undefined while loading).
 * `unlocked` = this tab holds the right token (the server then returns full addon URLs).
 */
export function useAdmin() {
  const token = useAdminToken();
  const cfg = useConfig(token);
  const lock = cfg.data?.adminLock;
  const unlocked = !!lock && !!cfg.data && !cfg.data.nuvio.redacted;
  return { token, cfg, lock, unlocked };
}

/** Server error text → plain words for the person at the screen. */
export function adminMessage(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  if (/admin token required/i.test(m)) return "Your admin token isn't accepted any more. Enter it again.";
  if (/set ADMIN_TOKEN/i.test(m)) return "Editing is turned off on this server. Set ADMIN_TOKEN on the server and restart it.";
  if (/not reachable or not JSON/i.test(m)) return "Couldn't load a manifest from that URL. Check it opens in a browser and ends in manifest.json.";
  if (/no valid scrapers/i.test(m)) return "That Nuvio repo lists no scrapers StreamPlay can use.";
  if (/no stream or subtitles/i.test(m)) return "That Stremio addon has no streams or subtitles, so it would add nothing here.";
  if (/not a Nuvio plugin manifest/i.test(m)) return "That URL isn't a Nuvio repo or a Stremio addon manifest.";
  if (/http\(s\) URL/i.test(m)) return "Enter a full URL starting with https:// or http://.";
  return m.charAt(0).toUpperCase() + m.slice(1);
}

/**
 * Unlock form for server-wide edits. Shows nothing while loading, an explanation when the
 * server has no ADMIN_TOKEN (`offText`), the token field when locked, and a compact
 * "unlocked" line with Lock when the token is accepted.
 */
export function AdminGate({ offText, why }: { offText?: string; why: string }) {
  const { lock, unlocked } = useAdmin();
  const [value, setValue] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  if (lock === undefined) return null;
  if (!lock) return offText ? <p className="set-note">{offText}</p> : null;
  if (unlocked) {
    return (
      <div className="admin-on">
        <StatusDot tone="success" />
        <span>Admin access is on for this tab.</span>
        <Button variant="ghost" size="sm" icon={<Lock size={16} />} onClick={() => setAdminToken("")}>Lock</Button>
      </div>
    );
  }
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const t = value.trim();
    if (!t) return;
    setBusy(true); setErr("");
    try {
      const c = await api.config(undefined, t);
      if (c.nuvio.redacted) setErr("That token didn't work. It must match ADMIN_TOKEN on the server exactly.");
      else { setAdminToken(t); setValue(""); }
    } catch (e) { setErr(adminMessage(e)); }
    setBusy(false);
  };
  return (
    <form className="admin-gate" onSubmit={submit}>
      <label className="set-label" htmlFor="admin-token">Admin token</label>
      <p className="set-desc" id="admin-token-desc">{why} Enter the ADMIN_TOKEN from the server's environment. It's kept for this browser tab only.</p>
      <div className="inline-form">
        <input id="admin-token" className="input" type="password" autoComplete="off" value={value} onChange={(e) => setValue(e.target.value)}
          aria-describedby={err ? "admin-token-err admin-token-desc" : "admin-token-desc"} aria-invalid={err ? true : undefined} />
        <Button type="submit" variant="solid" loading={busy} disabled={!value.trim()}>Unlock</Button>
      </div>
      {err && <p className="set-error" id="admin-token-err" role="alert">{err}</p>}
    </form>
  );
}
