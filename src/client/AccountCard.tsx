import React, { useEffect, useState } from 'react';
import { Button } from '@deepseek-ai/dsh-client-ui-primitives';
import { CHANNEL } from './locales';
import type { Translate } from './locales';
import { fill } from './locales';
import { callRpc } from './rpc';
import type { AccountStatus, CursorRpc, LoginFlow } from './types';

export function AccountCard({
  rpc,
  t,
  account,
  setAccount,
  onSignedOut,
}: {
  rpc: CursorRpc;
  t: Translate;
  account?: AccountStatus;
  setAccount: (next: AccountStatus) => void;
  onSignedOut: () => void;
}) {
  const [flow, setFlow] = useState<LoginFlow | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [apiKeyValue, setApiKeyValue] = useState('');
  const [apiKeyError, setApiKeyError] = useState<string | undefined>();
  const call = <T,>(endpoint: string, payload: Record<string, unknown> = {}) =>
    callRpc<T>(rpc, CHANNEL, endpoint, payload);

  useEffect(() => {
    if (flow?.id === undefined || ['authenticated', 'failed', 'cancelled'].includes(flow.phase ?? '')) {
      return undefined;
    }
    const timer = window.setInterval(() => {
      call<LoginFlow>('login/status', { id: flow.id })
        .then((next) => {
          setFlow(next);
          if (next.phase === 'authenticated') {
            call<AccountStatus>('status').then(setAccount).catch(() => setError(t('failed')));
          }
        })
        .catch(() => setError(t('failed')));
    }, 1200);
    return () => window.clearInterval(timer);
  }, [flow?.id, flow?.phase]);

  const begin = () => {
    setBusy(true);
    setError(undefined);
    call<LoginFlow>('login/start', { openExternal: true })
      .then(setFlow)
      .catch(() => setError(t('failed')))
      .finally(() => setBusy(false));
  };
  const cancel = () => {
    if (flow?.id === undefined) return;
    setBusy(true);
    call<LoginFlow>('login/cancel', { id: flow.id })
      .then(setFlow)
      .finally(() => setBusy(false));
  };
  const logout = () => {
    setBusy(true);
    setError(undefined);
    call<AccountStatus>('logout')
      .then((next) => {
        setAccount(next);
        setFlow(undefined);
        onSignedOut();
      })
      .catch(() => setError(t('failed')))
      .finally(() => setBusy(false));
  };
  const submitApiKey = () => {
    const value = apiKeyValue.trim();
    if (value === '') {
      setApiKeyError(t('apiKeyRequired'));
      return;
    }
    setBusy(true);
    setError(undefined);
    setApiKeyError(undefined);
    call<AccountStatus>('login/apikey', { apiKey: value })
      .then((next) => {
        setAccount(next);
        setApiKeyValue('');
        onSignedOut();
      })
      .catch((err: Error) => setApiKeyError(err.message))
      .finally(() => setBusy(false));
  };

  const signedIn = account?.authenticated === true;
  const accountReady = account !== undefined;
  const expiresAt = account?.method === 'token' && Number.isFinite(account?.expiresAt)
    ? new Date(account.expiresAt as number)
    : undefined;
  const credentialKind = account?.method === 'api-key'
    ? t('methodApiKey')
    : account?.method === 'token'
      ? t('methodToken')
      : undefined;
  const credentialValue = account?.method === 'api-key'
    ? account.apiKeyLabel
    : account?.method === 'token'
      ? account.tokenLabel
      : undefined;

  return (
    <div className="cursorSubscriptionCard">
      <div className="cursorSubscriptionAccountRow">
        <div className="cursorSubscriptionStatus" role="status" aria-live="polite">
          <span
            className="cursorSubscriptionDot"
            data-state={accountReady ? (signedIn ? 'connected' : 'disconnected') : 'loading'}
            aria-hidden="true"
          />
          {accountReady ? (signedIn ? t('connected') : t('disconnected')) : t('accountLoading')}
          {signedIn && credentialKind && credentialValue ? (
            <span className="cursorSubscriptionCredential">
              {fill(t('signedInCredential'), { kind: credentialKind, value: credentialValue })}
            </span>
          ) : null}
          {signedIn && expiresAt !== undefined ? (
            <time className="cursorSubscriptionFreshness" dateTime={expiresAt.toISOString()}>
              {fill(t('expiresAt'), { value: expiresAt.toLocaleString() })}
            </time>
          ) : null}
        </div>
        <div className="cursorSubscriptionActions">
          {signedIn ? (
            <Button type="button" variant="outline" disabled={busy} onClick={logout}>
              {t('logout')}
            </Button>
          ) : accountReady && (flow === undefined || ['failed', 'cancelled'].includes(flow.phase ?? '')) ? (
            <Button type="button" variant="primary" disabled={busy} onClick={begin}>
              {t('login')}
            </Button>
          ) : null}
        </div>
      </div>
      {!signedIn && accountReady ? (
        <div className="cursorSubscriptionApiKey">
          <div className="cursorSubscriptionApiKeyRow">
            <input
              className="cursorSubscriptionApiKeyInput"
              type="password"
              autoComplete="off"
              placeholder={t('apiKeyPlaceholder')}
              value={apiKeyValue}
              disabled={busy}
              aria-label={t('apiKeyLogin')}
              onChange={(event) => setApiKeyValue(event.target.value)}
            />
            <Button type="button" variant="primary" disabled={busy} onClick={submitApiKey}>
              {busy ? t('apiKeyBusy') : t('apiKeySubmit')}
            </Button>
          </div>
          {apiKeyError !== undefined ? (
            <p className="cursorSubscriptionError" role="alert">
              {apiKeyError}
            </p>
          ) : null}
        </div>
      ) : null}
      {!signedIn && flow !== undefined && ['starting', 'waiting_browser', 'waiting_input'].includes(flow.phase ?? '') ? (
        <div className="cursorSubscriptionFlow">
          <p>{t('waiting')}</p>
          {flow.authUrl === undefined ? null : (
            <a href={flow.authUrl} target="_blank" rel="noreferrer">
              {t('openLogin')}
            </a>
          )}
          <Button type="button" variant="outline" disabled={busy} onClick={cancel}>
            {t('cancel')}
          </Button>
        </div>
      ) : null}
      {flow?.phase === 'failed' || error !== undefined ? (
        <>
          <p className="cursorSubscriptionError" role="alert">
            {error ?? t('failed')}
          </p>
          {flow?.detail ? <p className="cursorSubscriptionError">{flow.detail}</p> : null}
        </>
      ) : null}
    </div>
  );
}
