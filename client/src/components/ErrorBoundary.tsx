import { Component, type ReactNode } from "react";
import { Button, StateMessage } from "./ui";

/** Shared error message (StateMessage): what failed + Try again. Raw error text goes in the
 *  collapsed "Technical details", never in the body. */
export function ErrorState({ title, detail, onRetry, busy, children }: { title: string; detail?: string; onRetry?: () => void; busy?: boolean; children?: ReactNode }) {
  return (
    <StateMessage kind="error" title={title} details={detail}
      actions={(onRetry || children) && <>
        {onRetry && <Button variant="solid" onClick={onRetry} loading={busy}>Try again</Button>}
        {children}
      </>} />
  );
}

/**
 * Route-level error boundary: a render throw in one page shows a fallback instead of
 * blanking the app. `resetKey` (the path) clears the error when the user navigates.
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
    console.error("[ErrorBoundary]", error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="container">
          <StateMessage kind="error" title="Something went wrong on this page." body="Reload to try again. If it keeps happening, go back home."
            details={this.state.error.message}
            actions={<><Button variant="solid" onClick={() => location.reload()}>Reload</Button><Button variant="ghost" onClick={() => { location.href = "/"; }}>Go home</Button></>} />
        </div>
      );
    }
    return this.props.children;
  }
}
