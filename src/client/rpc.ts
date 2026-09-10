import type { CursorRpc, RpcEnvelope } from './types';

export function unwrap<T>(response: RpcEnvelope<T> | unknown): T {
  const envelope = response as RpcEnvelope<T>;
  if (!envelope?.ok) throw new Error(envelope?.error?.message ?? 'Cursor RPC failed');
  return envelope.value as T;
}

export function callRpc<T>(rpc: CursorRpc, channel: string, endpoint: string, payload: Record<string, unknown> = {}) {
  return rpc.call(channel, endpoint, payload).then((response) => unwrap<T>(response));
}

export function validDate(value: unknown) {
  const date = new Date(value as string | number);
  return Number.isFinite(date.getTime()) ? date : undefined;
}

export function percent(value: unknown) {
  return Number(value).toLocaleString(undefined, { maximumFractionDigits: 1 });
}

export function money(value: unknown) {
  return Number(value).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}
