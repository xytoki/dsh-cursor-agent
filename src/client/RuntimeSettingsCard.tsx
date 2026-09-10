import React, { useEffect, useRef, useState } from 'react';
import { Button } from '@deepseek-ai/dsh-client-ui-primitives';
import { CHANNEL, type LocaleKey, type Translate } from './locales';

const DEFAULT_API_BASE_URL = 'https://api2.cursor.sh';

function parseApiBaseUrl(value: string) {
  const raw = value.trim();
  const input = raw.length === 0 ? DEFAULT_API_BASE_URL : raw;
  const url = new URL(input);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('invalid url');
  if (url.username || url.password) throw new Error('invalid url');
  url.hash = '';
  url.search = '';
  return url.href.endsWith('/') ? url.href.slice(0, -1) : url.href;
}
import { callRpc } from './rpc';
import type { CursorRpc, RuntimeSettingsView } from './types';

type FormState = {
  maxToolRounds: string;
  apiBaseUrl: string;
  retryCount: string;
  retryIntervalMs: string;
  retryHttpStatusCodes: string;
};

export function RuntimeSettingsCard({ rpc, t }: { rpc: CursorRpc; t: Translate }) {
  const [form, setForm] = useState<FormState | undefined>();
  const [baseline, setBaseline] = useState<RuntimeSettingsView | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [saved, setSaved] = useState(false);
  const request = useRef(0);
  const show = (value: RuntimeSettingsView): FormState => ({
    maxToolRounds: String(value.maxToolRounds),
    apiBaseUrl: value.apiBaseUrl,
    retryCount: String(value.retryCount),
    retryIntervalMs: String(value.retryIntervalMs),
    retryHttpStatusCodes: value.retryHttpStatusCodes.join(', '),
  });
  const accept = (value: RuntimeSettingsView) => {
    setForm(show(value));
    setBaseline({
      maxToolRounds: value.maxToolRounds,
      apiBaseUrl: value.apiBaseUrl,
      retryCount: value.retryCount,
      retryIntervalMs: value.retryIntervalMs,
      retryHttpStatusCodes: [...value.retryHttpStatusCodes],
      revision: value.revision,
    });
  };
  const load = () => {
    const id = ++request.current;
    setBusy(true);
    setError(undefined);
    setSaved(false);
    callRpc<RuntimeSettingsView>(rpc, CHANNEL, 'settings')
      .then((value) => {
        if (request.current === id) accept(value);
      })
      .catch(() => {
        if (request.current === id) setError(t('settingsLoadFailed'));
      })
      .finally(() => {
        if (request.current === id) setBusy(false);
      });
  };
  useEffect(() => {
    load();
    return () => {
      request.current += 1;
    };
  }, []);

  const change = (key: keyof FormState) => (event: { target: { value: string } }) => {
    const value = event.target.value;
    setForm((current) => (current ? { ...current, [key]: value } : current));
    setError(undefined);
    setSaved(false);
  };
  const parse = () => {
    if (!form) throw new Error('missing form');
    const integer = (value: string, min: number, max: number) => {
      if (!/^\d+$/.test(value.trim())) throw new Error('invalid integer');
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw new Error('integer out of range');
      return parsed;
    };
    const statusText = form.retryHttpStatusCodes.trim();
    if (statusText !== '' && !/^\d{3}(?:\s*,\s*\d{3})*$/.test(statusText)) throw new Error('invalid status list');
    const statuses = statusText === '' ? [] : statusText.split(',').map((value) => integer(value, 400, 599));
    if (new Set(statuses).size !== statuses.length) throw new Error('duplicate status');
    const apiBaseUrl = parseApiBaseUrl(form.apiBaseUrl);
    return {
      maxToolRounds: integer(form.maxToolRounds, 1, 1000),
      apiBaseUrl,
      retryCount: integer(form.retryCount, 0, 10),
      retryIntervalMs: integer(form.retryIntervalMs, 0, 300000),
      retryHttpStatusCodes: statuses,
    };
  };
  const save = () => {
    let value;
    try {
      value = parse();
    } catch {
      setError(t('settingsInvalid'));
      setSaved(false);
      return;
    }
    if (baseline === undefined) return;
    const patch: Record<string, unknown> = {};
    for (const key of ['maxToolRounds', 'apiBaseUrl', 'retryCount', 'retryIntervalMs', 'retryHttpStatusCodes'] as const) {
      if (JSON.stringify(value[key]) !== JSON.stringify(baseline[key])) patch[key] = value[key];
    }
    if (Object.keys(patch).length === 0) {
      setError(undefined);
      setSaved(true);
      return;
    }
    const id = ++request.current;
    setBusy(true);
    setError(undefined);
    setSaved(false);
    callRpc<RuntimeSettingsView>(rpc, CHANNEL, 'settings/update', { ...patch, revision: baseline.revision })
      .then((next) => {
        if (request.current !== id) return;
        accept(next);
        setSaved(true);
      })
      .catch(() => {
        if (request.current === id) setError(t('settingsSaveFailed'));
      })
      .finally(() => {
        if (request.current === id) setBusy(false);
      });
  };
  const field = (
    key: keyof FormState,
    label: LocaleKey,
    hint: LocaleKey,
    properties: { type?: string; min?: number; max?: number; wide?: boolean; placeholder?: string } = {},
  ) => (
    <div className={`cursorSubscriptionField${properties.wide ? ' cursorSubscriptionFieldWide' : ''}`}>
      <label htmlFor={`cursor-agent-${key}`}>{t(label)}</label>
      <input
        id={`cursor-agent-${key}`}
        type={properties.type ?? 'number'}
        min={properties.min}
        max={properties.max}
        step="1"
        placeholder={properties.placeholder}
        disabled={busy || form === undefined}
        value={form?.[key] ?? ''}
        onChange={change(key)}
      />
      <span className="cursorSubscriptionFieldHint">{t(hint)}</span>
    </div>
  );

  return (
    <div className="cursorSubscriptionCard">
      <div className="cursorSubscriptionSectionTitle">
        <h3>{t('runtimeSettings')}</h3>
        <p className="cursorSubscriptionFreshness">{t('runtimeSettingsNote')}</p>
      </div>
      <div className="cursorSubscriptionSettingsGrid">
        {field('maxToolRounds', 'maxToolRounds', 'maxToolRoundsHint', { min: 1, max: 1000 })}
        {field('apiBaseUrl', 'apiBaseUrl', 'apiBaseUrlHint', {
          type: 'text',
          wide: true,
          placeholder: 'https://api2.cursor.sh',
        })}
        {field('retryCount', 'retryCount', 'retryCountHint', { min: 0, max: 10 })}
        {field('retryIntervalMs', 'retryInterval', 'retryIntervalHint', { min: 0, max: 300000 })}
        {field('retryHttpStatusCodes', 'retryStatuses', 'retryStatusesHint', { type: 'text', wide: true })}
      </div>
      {error === undefined ? null : (
        <p className="cursorSubscriptionError" role="alert">
          {error}
        </p>
      )}
      <div className="cursorSubscriptionSettingsFoot">
        {saved ? (
          <p className="cursorSubscriptionSuccess" role="status">
            {t('settingsSaved')}
          </p>
        ) : (
          <span />
        )}
        <Button
          type="button"
          variant="primary"
          disabled={busy || (form !== undefined && baseline === undefined)}
          onClick={form === undefined ? load : save}
        >
          {busy
            ? form === undefined
              ? t('loadingSettings')
              : t('savingSettings')
            : form === undefined
              ? t('reloadSettings')
              : t('saveSettings')}
        </Button>
      </div>
    </div>
  );
}
