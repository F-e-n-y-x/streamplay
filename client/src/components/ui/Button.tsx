import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from "react";
import { Link } from "react-router-dom";

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

export type ButtonVariant = "primary" | "secondary" | "ghost" | "solid" | "danger" | "link" | "media";
const VARIANT: Record<ButtonVariant, string> = {
  primary: "btn-accent",   // THE red action. One per view.
  secondary: "",           // tonal (default)
  ghost: "btn-ghost",
  solid: "btn-solid",      // neutral-solid: dialog confirm, "Go home"
  danger: "btn-danger",
  link: "btn-link",
  media: "btn-media",      // tonal on artwork / in the player
};

type BaseProps = {
  variant?: ButtonVariant;
  size?: "sm" | "md" | "lg";
  /** 20px leading icon (replaced by a spinner while loading) */
  icon?: ReactNode;
  /** Trailing meta after a hairline, Resume only: "32 min left" */
  meta?: ReactNode;
  loading?: boolean;
  full?: boolean;
  /** Renders a router <Link> instead of a <button> */
  to?: string;
};
export type ButtonProps = BaseProps & ButtonHTMLAttributes<HTMLButtonElement>;

export function Button({ variant = "secondary", size = "md", icon, meta, loading, full, to, className, children, type = "button", disabled, ...rest }: ButtonProps) {
  const cls = cx("btn", VARIANT[variant], size !== "md" && `btn-${size}`, full && "btn-full", className);
  const inner = (
    <>
      {loading ? <span className="spin" aria-hidden="true" /> : icon}
      {children}
      {meta != null && <span className="btn-meta">{meta}</span>}
    </>
  );
  if (to) return <Link to={to} className={cls} aria-disabled={disabled || undefined}>{inner}</Link>;
  return <button type={type} className={cls} disabled={disabled} aria-busy={loading || undefined} {...rest}>{inner}</button>;
}

export type IconButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> & {
  /** Accessible name + hover tooltip. Required: every icon-only button is labelled. */
  label: string;
  children: ReactNode;
  variant?: "ghost" | "tonal" | "media";
  size?: "sm" | "md" | "lg";
  /** Toggle state (aria-pressed). Leave undefined for plain actions. */
  pressed?: boolean;
  to?: string;
};

export function IconButton({ label, variant = "ghost", size = "md", pressed, to, className, children, type = "button", ...rest }: IconButtonProps) {
  const cls = cx("icon-btn", variant !== "ghost" && `icon-btn-${variant}`, size !== "md" && `icon-btn-${size}`, className);
  if (to) return <Link to={to} className={cls} aria-label={label} title={label}>{children}</Link>;
  return <button type={type} className={cls} aria-label={label} title={label} aria-pressed={pressed} {...rest}>{children}</button>;
}

/** Neutral badge. Allowed only for: quality, audio language, a count, "New", "Watched". */
export function Badge({ children, className, ...rest }: { children: ReactNode; className?: string } & HTMLAttributes<HTMLSpanElement>) {
  return <span className={cx("badge", className)} {...rest}>{children}</span>;
}

/** Status dot; always pair it with text that says the same thing. */
export function StatusDot({ tone }: { tone?: "success" | "warning" | "error" | "neutral" }) {
  return <span className="status-dot" data-tone={tone} aria-hidden="true" />;
}

export { cx };
