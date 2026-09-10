import React, { useEffect, useRef, useState } from 'react';
import { Button } from '@deepseek-ai/dsh-client-ui-primitives';
import { CHANNEL, fill, type Translate } from './locales';
import { callRpc } from './rpc';
import type { CursorRpc, ModelsView } from './types';

export function ModelsCard({ rpc, t, signedIn }: { rpc: CursorRpc; t: Translate; signedIn: boolean }) {
  const [data, setData] = useState<ModelsView | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const request = useRef(0);
  const load = (force: boolean) => {
    if (!signedIn) return;
    const id = ++request.current;
    setBusy(true);
    setError(undefined);
    callRpc<ModelsView>(rpc, CHANNEL, 'models', { force })
      .then((next) => {
        if (request.current === id) setData(next);
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
      setData(undefined);
      setError(undefined);
      setBusy(false);
    }
    return () => {
      request.current += 1;
    };
  }, [signedIn]);

  const models = Array.isArray(data?.models) ? data.models : [];
  return (
    <div className="cursorSubscriptionCard">
      <div className="cursorSubscriptionSectionHead">
        <div className="cursorSubscriptionSectionTitle">
          <h3>{t('models')}</h3>
          {models.length > 0 ? (
            <span className="cursorSubscriptionFreshness">{fill(t('modelsCount'), { value: models.length })}</span>
          ) : null}
        </div>
        <Button
          className="cursorSubscriptionRefresh"
          type="button"
          variant="outline"
          disabled={!signedIn || busy}
          aria-busy={busy}
          onClick={() => load(true)}
        >
          {busy ? t('modelsRefreshing') : t('modelsRefresh')}
        </Button>
      </div>
      <div className="cursorSubscriptionModels" aria-live="polite">
        {!signedIn ? <p className="cursorSubscriptionEmpty">{t('usageNotSignedIn')}</p> : null}
        {signedIn && busy && models.length === 0 ? (
          <p className="cursorSubscriptionEmpty" role="status">
            {t('modelsLoading')}
          </p>
        ) : null}
        {error === undefined ? null : (
          <p className="cursorSubscriptionError" role="alert">
            {error}
          </p>
        )}
        {models.length > 0 ? (
          <div className="cursorSubscriptionModelChips">
            {models.map((model) => (
              <span key={model.id} className="cursorSubscriptionModelChip" title={model.name}>
                {model.id}
              </span>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
