import { Sparkles } from 'lucide-react';

/** Loading / error / empty wrapper used by the roster and attendance pages. */
export function State({ loading, error, empty, onRetry, emptyText = 'Nothing to show yet.', children }) {
  if (loading) return <div className="state"><span className="spinner" />Loading your data…</div>;
  if (error) return <div className="state error-state"><strong>We couldn’t load this data</strong><span>{error}</span>{onRetry && <button className="button secondary" onClick={onRetry}>Try again</button>}</div>;
  if (empty) return <div className="state"><span className="empty-icon"><Sparkles size={19} /></span><strong>{emptyText}</strong></div>;
  return children;
}
