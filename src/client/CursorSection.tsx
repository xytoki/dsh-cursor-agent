import React, { useEffect, useState } from 'react';
import { AccountCard } from './AccountCard';
import { CHANNEL, type Translate } from './locales';
import { ModelsCard } from './ModelsCard';
import { callRpc } from './rpc';
import { RuntimeSettingsCard } from './RuntimeSettingsCard';
import type { AccountStatus, CursorRpc } from './types';
import { UsageCard } from './UsageCard';

export function CursorSection({ rpc, t }: { rpc: CursorRpc; t: Translate }) {
  const [account, setAccount] = useState<AccountStatus | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [resetKey, setResetKey] = useState(0);
  useEffect(() => {
    let live = true;
    callRpc<AccountStatus>(rpc, CHANNEL, 'status')
      .then((next) => {
        if (live) setAccount(next);
      })
      .catch(() => {
        if (live) setError(t('loadFailed'));
      });
    return () => {
      live = false;
    };
  }, [resetKey]);
  const signedIn = account?.authenticated === true;
  return (
    <section className="cursorSubscription">
      <div className="cursorSubscriptionHead">
        <h2>{t('title')}</h2>
      </div>
      {error === undefined ? null : (
        <p className="cursorSubscriptionError" role="alert">
          {error}
        </p>
      )}
      <AccountCard
        rpc={rpc}
        t={t}
        account={account}
        setAccount={setAccount}
        onSignedOut={() => setResetKey((value) => value + 1)}
      />
      <UsageCard rpc={rpc} t={t} signedIn={signedIn} resetKey={resetKey} />
      <ModelsCard rpc={rpc} t={t} signedIn={signedIn} />
      <RuntimeSettingsCard rpc={rpc} t={t} />
      <p className="cursorSubscriptionNote">{t('note')}</p>
    </section>
  );
}
