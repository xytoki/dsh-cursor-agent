import React, { useEffect, useRef, useState } from 'react';
import { Button } from '@deepseek-ai/dsh-client-ui-primitives';
import { CHANNEL, fill, type Translate } from './locales';
import { callRpc, money, percent, validDate } from './rpc';
import type { CursorRpc, UsageView } from './types';
import { UsageRow } from './UsageRow';

export function UsageCard({
  rpc,
  t,
  signedIn,
  resetKey,
}: {
  rpc: CursorRpc;
  t: Translate;
  signedIn: boolean;
  resetKey: number;
}) {
  const [usage, setUsage] = useState<UsageView | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const request = useRef(0);
  const load = (force: boolean) => {
    if (!signedIn) return;
    const id = ++request.current;
    setBusy(true);
    setError(undefined);
    callRpc<UsageView>(rpc, CHANNEL, 'usage', { force })
      .then((next) => {
        if (request.current === id) setUsage(next);
      })
      .catch((err: Error) => {
        if (request.current === id) setError(err.message);
      })
      .finally(() => {
        if (request.current === id) setBusy(false);
      });
  };
  useEffect(() => {
    if (signedIn) load(false);
    else {
      request.current += 1;
      setUsage(undefined);
      setError(undefined);
      setBusy(false);
    }
    return () => {
      request.current += 1;
    };
  }, [signedIn, resetKey]);

  const fetchedAt = typeof usage?.fetchedAt === 'number' ? validDate(usage.fetchedAt) : undefined;
  const plan = usage?.plan;
  const spendLimit = usage?.spendLimit;
  const grok = usage?.grok;
  const cycleStart = usage?.billingCycle?.start === undefined ? undefined : validDate(usage.billingCycle.start);
  const cycleEnd = usage?.billingCycle?.end === undefined ? undefined : validDate(usage.billingCycle.end);
  const grokReset = grok?.nextReset === undefined ? undefined : validDate(grok.nextReset);
  const moneyOf = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? money(value) : '—');
  const hasAutoUsage =
    plan !== undefined &&
    (typeof plan.autoPercentUsed === 'number' || plan.autoSpend !== undefined || plan.autoLimit !== undefined);
  const hasApiUsage =
    plan !== undefined &&
    (typeof plan.apiPercentUsed === 'number' || plan.apiSpend !== undefined || plan.apiLimit !== undefined);

  return (
    <div className="cursorSubscriptionCard">
      <div className="cursorSubscriptionSectionHead">
        <div className="cursorSubscriptionSectionTitle">
          <h3>{t('usage')}</h3>
          {fetchedAt === undefined ? null : (
            <time className="cursorSubscriptionFreshness" dateTime={fetchedAt.toISOString()}>
              {fill(t('usageUpdated'), { value: fetchedAt.toLocaleString() })}
            </time>
          )}
        </div>
        <Button
          className="cursorSubscriptionRefresh"
          type="button"
          variant="outline"
          disabled={!signedIn || busy}
          aria-busy={busy}
          onClick={() => load(true)}
        >
          {busy ? t('usageRefreshing') : t('usageRefresh')}
        </Button>
      </div>
      <div aria-live="polite">
        {!signedIn ? <p className="cursorSubscriptionEmpty">{t('usageNotSignedIn')}</p> : null}
        {signedIn && busy && usage === undefined ? (
          <p className="cursorSubscriptionEmpty" role="status">
            {t('usageLoading')}
          </p>
        ) : null}
      </div>
      {error === undefined ? null : (
        <p className="cursorSubscriptionError" role="alert">
          {error}
        </p>
      )}
      {usage === undefined || !signedIn ? null : (
        <>
          <div className="cursorSubscriptionMetaRow">
            <span>
              {usage.email ?? '—'}
              {usage.planName ? ` (${usage.planName})` : ''}
            </span>
            {usage.billingCycle?.daysLeft !== undefined ? (
              <span
                title={
                  cycleStart !== undefined && cycleEnd !== undefined
                    ? `${t('billingCycle')}: ${cycleStart.toLocaleDateString()} – ${cycleEnd.toLocaleDateString()}`
                    : undefined
                }
              >
                {fill(t('billingDaysLeft'), { value: usage.billingCycle.daysLeft })}
              </span>
            ) : null}
          </div>
          {typeof usage.displayMessage === 'string' && usage.displayMessage.length > 0 ? (
            <p className="cursorSubscriptionMetaRow">{usage.displayMessage}</p>
          ) : null}
          {hasAutoUsage || hasApiUsage ? (
            <div className="cursorSubscriptionUsageSplit">
              {hasAutoUsage
                ? plan.autoSpend !== undefined || plan.autoLimit !== undefined
                  ? (
                    <UsageRow
                      label={t('autoSpend')}
                      used={plan.autoSpend}
                      limit={plan.autoLimit}
                      meta={`${moneyOf(plan.autoSpend)} / ${moneyOf(plan.autoLimit)}${typeof plan.autoPercentUsed === 'number' ? ` · ${percent(plan.autoPercentUsed)}%` : ''}`}
                    />
                  )
                  : (
                    <UsageRow
                      label={t('autoSpend')}
                      used={plan.autoPercentUsed}
                      limit={100}
                      meta={`${percent(plan.autoPercentUsed)}%`}
                    />
                  )
                : null}
              {hasApiUsage
                ? plan.apiSpend !== undefined || plan.apiLimit !== undefined
                  ? (
                    <UsageRow
                      label={t('apiSpend')}
                      used={plan.apiSpend}
                      limit={plan.apiLimit}
                      meta={`${moneyOf(plan.apiSpend)} / ${moneyOf(plan.apiLimit)}${typeof plan.apiPercentUsed === 'number' ? ` · ${percent(plan.apiPercentUsed)}%` : ''}`}
                    />
                  )
                  : (
                    <UsageRow
                      label={t('apiSpend')}
                      used={plan.apiPercentUsed}
                      limit={100}
                      meta={`${percent(plan.apiPercentUsed)}%`}
                    />
                  )
                : null}
            </div>
          ) : null}
          {plan !== undefined ? (
            <div className="cursorSubscriptionMetaRow">
              {plan.totalSpend !== undefined ? <span>{`${t('planTotalSpend')}: ${moneyOf(plan.totalSpend)}`}</span> : null}
              {plan.includedSpend !== undefined ? <span>{`${t('planIncluded')}: ${moneyOf(plan.includedSpend)}`}</span> : null}
              {plan.bonusSpend !== undefined ? <span>{`${t('planBonus')}: ${moneyOf(plan.bonusSpend)}`}</span> : null}
              {plan.remaining !== undefined ? <span>{`${t('planRemaining')}: ${moneyOf(plan.remaining)}`}</span> : null}
              {plan.limit !== undefined ? <span>{`${t('planLimit')}: ${moneyOf(plan.limit)}`}</span> : null}
            </div>
          ) : null}
          {spendLimit !== undefined &&
          ((typeof spendLimit.pooledLimit === 'number' && spendLimit.pooledLimit > 0) ||
            (typeof spendLimit.individualLimit === 'number' && spendLimit.individualLimit > 0) ||
            spendLimit.totalSpend !== undefined) ? (
            <div className="cursorSubscriptionUsageGroup">
              <span className="cursorSubscriptionUsageGroupHead">{t('spendLimit')}</span>
              {typeof spendLimit.pooledLimit === 'number' && spendLimit.pooledLimit > 0 ? (
                <UsageRow
                  label={t('pooled')}
                  used={spendLimit.pooledUsed}
                  limit={spendLimit.pooledLimit}
                  meta={fill(t('spendUsedOf'), { used: moneyOf(spendLimit.pooledUsed), limit: moneyOf(spendLimit.pooledLimit) })}
                />
              ) : null}
              {typeof spendLimit.individualLimit === 'number' && spendLimit.individualLimit > 0 ? (
                <UsageRow
                  label={t('individual')}
                  used={spendLimit.individualUsed}
                  limit={spendLimit.individualLimit}
                  meta={fill(t('spendUsedOf'), {
                    used: moneyOf(spendLimit.individualUsed),
                    limit: moneyOf(spendLimit.individualLimit),
                  })}
                />
              ) : null}
              {spendLimit.totalSpend !== undefined ? (
                <div className="cursorSubscriptionMetaRow">{fill(t('spendTotal'), { value: moneyOf(spendLimit.totalSpend) })}</div>
              ) : null}
            </div>
          ) : null}
          {plan === undefined && spendLimit === undefined ? (
            <p className="cursorSubscriptionEmpty">{t('usagePlanMissing')}</p>
          ) : null}
          {grok !== undefined ? (
            <div className="cursorSubscriptionUsageGroup">
              {typeof grok.usagePercent === 'number' ? (
                <UsageRow
                  label={t('grok')}
                  used={grok.usagePercent}
                  limit={100}
                  meta={fill(t('grokAvailable'), { value: percent(grok.usagePercent) })}
                  footer={grokReset === undefined ? undefined : fill(t('grokReset'), { value: grokReset.toLocaleString() })}
                />
              ) : null}
              {typeof grok.availableBankedResetCount === 'string' ? (
                <div className="cursorSubscriptionMetaRow">{fill(t('grokBanked'), { value: grok.availableBankedResetCount })}</div>
              ) : null}
            </div>
          ) : null}
          {cycleStart !== undefined && cycleEnd !== undefined && usage.billingCycle?.daysLeft === undefined ? (
            <div className="cursorSubscriptionMetaRow">
              <span>{`${t('billingCycle')}: ${cycleStart.toLocaleDateString()} – ${cycleEnd.toLocaleDateString()}`}</span>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
