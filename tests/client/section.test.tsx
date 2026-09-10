import { expect, test } from '@rstest/core';
import React from 'react';
import { render, screen } from '@testing-library/react';
import { CursorSection } from '../../src/client/CursorSection';

test('settings section renders the title', () => {
  render(
    <CursorSection
      rpc={{ call: async () => ({ ok: false, error: { message: 'offline' } }) }}
      t={(key) => key}
    />,
  );
  expect(screen.getByRole('heading', { name: 'title' })).toBeTruthy();
});
