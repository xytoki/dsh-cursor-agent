import React from 'react';
import { percent } from './rpc';

export function UsageRow({
  label,
  used,
  limit,
  meta,
  footer,
}: {
  label: string;
  used?: number;
  limit?: number;
  meta?: string;
  footer?: string;
}) {
  const available =
    typeof used === 'number' &&
    Number.isFinite(used) &&
    typeof limit === 'number' &&
    Number.isFinite(limit) &&
    limit > 0;
  const usedPct = available ? Math.min(100, Math.round(((used as number) / (limit as number)) * 1000) / 10) : 0;
  const headline = available ? `${percent(usedPct)}%` : '—';
  return (
    <div className="cursorSubscriptionUsageRow">
      <div className="cursorSubscriptionUsageTop">
        <span className="cursorSubscriptionUsageLabel">{label}</span>
        <strong>{headline}</strong>
      </div>
      <progress max="100" value={usedPct} aria-label={`${label} ${headline}`} />
      {meta || footer ? (
        <div className="cursorSubscriptionUsageFoot">
          <span>{meta}</span>
          {footer ? <span className="cursorSubscriptionUsageFootRight">{footer}</span> : null}
        </div>
      ) : null}
    </div>
  );
}
