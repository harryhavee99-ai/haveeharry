import React from 'react';
import { AlertTriangle, RotateCcw, RefreshCw } from 'lucide-react';

interface ErrorBoundaryProps {
  children: React.ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  errorMessage: string;
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, errorMessage: '' };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return {
      hasError: true,
      errorMessage: error?.message || 'An unexpected rendering issue occurred.',
    };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error('[ClipGenius UI ErrorBoundary]', error, info.componentStack);
  }

  private handleRecover = () => {
    try {
      window.localStorage.removeItem('clipgenius_workspace_state_v1');
      if (window.location.hash) {
        window.history.replaceState(null, '', window.location.pathname + window.location.search);
      }
    } catch {
      // ignore storage errors
    }
    this.setState({ hasError: false, errorMessage: '' });
  };

  private handleReload = () => {
    window.location.reload();
  };

  render() {
    if (!this.state.hasError) {
      return this.props.children;
    }

    return (
      <div className="min-h-screen flex items-center justify-center bg-[#050A07] text-[#F3F6F3] p-6">
        <div className="max-w-md w-full rounded-2xl studio-panel border border-[#D4AF37]/30 p-6 space-y-4 text-center">
          <div className="mx-auto w-12 h-12 rounded-xl bg-[#D4AF37]/15 border border-[#D4AF37]/35 flex items-center justify-center">
            <AlertTriangle className="w-6 h-6 text-[#F5C451]" />
          </div>
          <div className="space-y-1.5">
            <h1 className="font-display text-lg font-bold text-white">
              ClipGenius AI Recovered from a View Error
            </h1>
            <p className="text-xs text-[#94A89C] leading-relaxed">
              {this.state.errorMessage}
            </p>
          </div>
          <div className="flex items-center justify-center gap-2.5 pt-2">
            <button
              onClick={this.handleRecover}
              className="studio-btn-primary inline-flex items-center gap-1.5 h-9 px-4 rounded-lg text-xs font-semibold text-white"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              Return to Dashboard
            </button>
            <button
              onClick={this.handleReload}
              className="inline-flex items-center gap-1.5 h-9 px-4 rounded-lg bg-[#0E1913] hover:bg-[#14251C] border border-[#D4AF37]/25 text-xs font-medium text-[#FEFCE8]"
            >
              <RefreshCw className="w-3.5 h-3.5 text-[#F5C451]" />
              Reload Page
            </button>
          </div>
        </div>
      </div>
    );
  }
}
