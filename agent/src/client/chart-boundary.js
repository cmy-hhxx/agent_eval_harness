import { Component, createElement as h } from 'react';
import { chartTheme } from './chart-theme.js';

export function ChartFailure({ message = '图表暂时无法显示', title, retry, recovering = false }) {
  return h('figure', { 'data-chart-error': true, role: recovering ? 'status' : 'alert', style: {
    margin: '16px auto', maxWidth: 540, padding: 16, boxSizing: 'border-box', border: `1px solid ${chartTheme.grid}`,
    borderRadius: 6, color: chartTheme.ink, background: chartTheme.paper, overflowWrap: 'anywhere',
  } }, title ? h('figcaption', { style: { fontWeight: 600, marginBottom: 8 } }, title) : null,
  h('span', null, recovering ? '图表正在恢复…' : message),
  retry && !recovering ? h('button', { type: 'button', onClick: retry, style: { marginLeft: 12 } }, '重试图表') : null);
}

// Each receipt gets one automatic remount; repeated errors stay local and never create a retry loop.
export class ChartBoundary extends Component {
  state = { failed: false, retries: 0 };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch() {
    if (this.state.retries === 0) this.timer = setTimeout(() => this.setState({ failed: false, retries: 1 }), 0);
  }
  componentWillUnmount() { clearTimeout(this.timer); }
  render() {
    return this.state.failed ? h(ChartFailure, { title: this.props.title, recovering: this.state.retries === 0,
      retry: () => this.setState({ failed: false, retries: 1 }) }) : this.props.children;
  }
}
