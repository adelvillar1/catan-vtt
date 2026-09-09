/**
 * ErrorBoundary.tsx — last line of defense around the Canvas content.
 *
 * geom.ts throws on unknown vertex/edge ids (loud, test-enforced). The
 * renderers skip such entries defensively, but a version skew between an
 * older room build and this table could still produce a throwing frame —
 * an uncaught render error inside <Canvas> white-screens the whole app.
 * The boundary degrades to the join rail + a one-line notice instead.
 */
import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  /** DOM notice rendered INSTEAD of children when tripped. */
  fallback?: ReactNode;
}

interface State {
  failed: boolean;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("[table] scene render failed — showing fallback:", error, info.componentStack);
  }

  render(): ReactNode {
    if (this.state.failed) {
      return (
        this.props.fallback ?? (
          <div style={{ padding: 16, color: "#e8e6df", background: "#241318" }}>
            The 3D table hit a rendering error (often a server/table version mismatch).
            Reload the page; the join rail still works.
          </div>
        )
      );
    }
    return this.props.children;
  }
}
