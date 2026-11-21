import { Button } from '@ade/ui';
import { Component, type ReactNode } from 'react';

/** Keeps one failing screen from blanking the whole window. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <div role="alert" className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="font-semibold">This screen hit an error.</p>
        <p className="max-w-xl font-mono text-[12px] text-ink-muted">{this.state.error.message}</p>
        <Button size="dense" variant="primary" onClick={() => this.setState({ error: null })}>
          Try again
        </Button>
      </div>
    );
  }
}
