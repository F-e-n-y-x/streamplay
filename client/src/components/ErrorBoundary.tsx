import { Component, type ReactNode } from "react";

/**
 * Route-level error boundary. A malformed backend payload or a render throw in
 * one page used to unmount the whole app (blank screen). This scopes the failure
 * to a fallback card and offers a reload, keeping the header/nav usable.
 *
 * `resetKey` (the current path) clears the error when the user navigates away, so
 * a bad route doesn't wedge every subsequent one.
 */
interface Props { children: ReactNode; resetKey?: string }
interface State { error: Error | null }

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State { return { error }; }

  componentDidUpdate(prev: Props) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null });
  }

  componentDidCatch(error: Error, info: unknown) {
    // eslint-disable-next-line no-console
    console.error("[ErrorBoundary]", error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="container">
          <div className="empty" style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "var(--space-4)" }}>
            <div>
              <div style={{ fontWeight: 600, color: "var(--foreground)", marginBottom: "var(--space-2)" }}>Something went wrong on this page.</div>
              <div className="subtle" style={{ fontSize: "var(--text-sm)" }}>{this.state.error.message}</div>
            </div>
            <button className="btn btn-primary" onClick={() => this.setState({ error: null })}>Try again</button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
