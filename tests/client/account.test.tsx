import { afterEach, expect, test } from '@rstest/core';
import React from 'react';
import { cleanup, render, within } from '@testing-library/react';
import { AccountCard } from '../../src/client/AccountCard';
import { fill } from '../../src/client/locales';

afterEach(() => {
  cleanup();
});

const t = (key: string, values?: Record<string, unknown>) =>
  values ? fill(key, values) : key;

test('signed-in API key status is one row without the old duplicate lines', () => {
  const { container } = render(
    <AccountCard
      rpc={{ call: async () => ({}) }}
      t={t}
      account={{
        authenticated: true,
        method: 'api-key',
        apiKeyLabel: 'crsr_47…9f',
        expiresAt: Date.parse('2026-09-10T14:51:00.000Z'),
      }}
      setAccount={() => undefined}
      onSignedOut={() => undefined}
    />,
  );
  const view = within(container);
  expect(view.getByText('connected')).toBeTruthy();
  expect(view.getByText('signedInCredential')).toBeTruthy();
  expect(view.queryByText(/apiKeyMasked/)).toBeNull();
  expect(view.queryByText(/expiresAt/)).toBeNull();
});

test('JWT token status shows the credential and expiry on the status row', () => {
  const { container } = render(
    <AccountCard
      rpc={{ call: async () => ({}) }}
      t={t}
      account={{
        authenticated: true,
        method: 'token',
        tokenLabel: 'eyJhbG…xx',
        expiresAt: Date.parse('2026-09-10T14:51:00.000Z'),
      }}
      setAccount={() => undefined}
      onSignedOut={() => undefined}
    />,
  );
  const view = within(container);
  expect(view.getByText('signedInCredential')).toBeTruthy();
  expect(view.getByText(/expiresAt/)).toBeTruthy();
});
