// components/ErrorBoundary.jsx
// Catches React component errors and shows fallback UI instead of white screen
import React from 'react';

export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    console.error('[ErrorBoundary] Component error:', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          padding: '40px',
          textAlign: 'center',
          background: '#1a1a1a',
          borderRadius: '12px',
          margin: '20px',
          color: '#fff'
        }}>
          <h2 style={{ color: '#ef4444', marginBottom: '12px' }}>Something went wrong</h2>
          <p style={{ color: '#a3a3a3', marginBottom: '20px' }}>
            {this.props.fallbackMessage || 'This section encountered an error. Please try refreshing the page.'}
          </p>
          <button
            onClick={() => this.setState({ hasError: false, error: null })}
            style={{
              background: '#dc2626',
              color: '#fff',
              border: 'none',
              padding: '10px 24px',
              borderRadius: '6px',
              cursor: 'pointer',
              fontSize: '14px'
            }}
          >
            Try Again
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
