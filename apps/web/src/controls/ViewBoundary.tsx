import { Component, type ReactNode } from "react";

interface ViewBoundaryProps { readonly label: string; readonly children: ReactNode }

/**
 * Keeps a view that fails to render from blanking the whole page: the failure is shown in
 * its place, and the header, tabs and other panels stay usable. Key it by what it shows, so
 * moving to another tab or item tries again.
 */
export class ViewBoundary extends Component<ViewBoundaryProps, { readonly error: string | null }> {
  override state: { readonly error: string | null } = { error: null };

  static getDerivedStateFromError(error: unknown): { readonly error: string } {
    return { error: error instanceof Error ? error.message : String(error) };
  }

  override render(): ReactNode {
    if (this.state.error === null) return this.props.children;
    return <p className="state" data-state="degraded" role="alert">{this.props.label} could not be shown · {this.state.error}</p>;
  }
}
