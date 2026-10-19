import { Component, type ErrorInfo, type ReactNode } from 'react'

interface ErrorBoundaryProps {
  children: ReactNode
}

interface ErrorBoundaryState {
  message: string | null
}

/** Last line of defence: a renderer crash must not leave a blank window behind. */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { message: null }

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { message: error instanceof Error ? error.message : 'unknown renderer error' }
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error('[ctoe] renderer error:', error, info.componentStack)
  }

  override render(): ReactNode {
    if (this.state.message === null) return this.props.children
    return (
      <div className="crash">
        <p className="crash__title">界面出错了</p>
        <p className="crash__detail">{this.state.message}</p>
        <button type="button" className="button" onClick={() => this.setState({ message: null })}>
          重试
        </button>
      </div>
    )
  }
}
