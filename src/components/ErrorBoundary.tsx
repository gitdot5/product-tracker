import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props { children: ReactNode; fallback?: ReactNode; }
interface State { hasError: boolean; error: Error | null; }

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }
  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }
  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("[ErrorBoundary]", error, info.componentStack);
  }
  private handleReset = (): void => {
    this.setState({ hasError: false, error: null });
  };
  render(): ReactNode {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;
      return (
        <div className="error-boundary">
          <h2>Something went wrong</h2>
          <p className="error-message">{this.state.error?.message}</p>
          <button className="btn btn-primary" onClick={this.handleReset}>Try Again</button>
        </div>
      );
    }    return this.props.children;
  }
}