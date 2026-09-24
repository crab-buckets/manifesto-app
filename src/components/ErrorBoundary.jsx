import { Component } from 'react';

/* Isolates a risky child (a canvas or WebGL component, say) so a crash there shows a message
   instead of leaving the whole page blank. This is the direct fix for "the Archive is blank":
   the shredder is the one component used only on that screen, so if it throws, only it fails now. */
export default class ErrorBoundary extends Component {
  constructor(p) { super(p); this.state = { err: null }; }
  static getDerivedStateFromError(err) { return { err }; }
  componentDidCatch(err, info) { console.error('[Manifesto]', this.props.label || 'component', 'failed:', err, info?.componentStack); }
  render() {
    if (!this.state.err) return this.props.children;
    if (this.props.silent) return this.props.fallback ?? null;
    return (
      <div className="panel boundary">
        <p className="bad">{this.props.label || 'This part of the page'} failed to render: {String(this.state.err?.message || this.state.err)}</p>
        <button onClick={() => this.setState({ err: null })}>Try again</button>
      </div>
    );
  }
}
