import { Component, type ReactNode } from "react";

interface ViewBoundaryProps { readonly label: string; readonly resetKey: string; readonly children: ReactNode }

/**
 * Keeps a view that fails to render from blanking the whole page: the failure is shown in
 * its place, and the header, tabs and other panels stay usable. A new `resetKey` (another tab
 * or item) tries again. It is not a React key, so a view that renders keeps its state, such as
 * the details panel's traceability trail across selections.
 */
export class ViewBoundary extends Component<ViewBoundaryProps, { readonly error: string | null }> {
  override state: { readonly error: string | null } = { error: null };

  static getDerivedStateFromError(error: unknown): { readonly error: string } {
    return { error: error instanceof Error ? error.message : String(error) };
  }

  override componentDidUpdate(previous: ViewBoundaryProps): void {
    if (previous.resetKey !== this.props.resetKey && this.state.error !== null) this.setState({ error: null });
  }

  override render(): ReactNode {
    if (this.state.error === null) return this.props.children;
    return <p className="state" data-state="degraded" role="alert">{this.props.label} could not be shown · {this.state.error}</p>;
  }
}
