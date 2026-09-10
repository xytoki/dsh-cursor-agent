export interface CursorRpc {
  call: (channel: string, endpoint: string, payload?: Record<string, unknown>) => Promise<unknown>;
}

export interface RpcEnvelope<T> {
  ok?: boolean;
  value?: T;
  error?: { message?: string };
}

export interface AccountStatus {
  authenticated?: boolean;
  method?: string;
  expiresAt?: number;
  apiKeyLabel?: string;
  tokenLabel?: string;
}

export interface LoginFlow {
  id?: string;
  phase?: string;
  authUrl?: string;
  detail?: string;
}

export interface UsagePlan {
  autoPercentUsed?: number;
  autoSpend?: number;
  autoLimit?: number;
  apiPercentUsed?: number;
  apiSpend?: number;
  apiLimit?: number;
  totalSpend?: number;
  includedSpend?: number;
  bonusSpend?: number;
  remaining?: number;
  limit?: number;
}

export interface UsageSpendLimit {
  pooledUsed?: number;
  pooledLimit?: number;
  individualUsed?: number;
  individualLimit?: number;
  totalSpend?: number;
}

export interface UsageGrok {
  usagePercent?: number;
  nextReset?: number | string;
  availableBankedResetCount?: string;
}

export interface UsageView {
  fetchedAt?: number;
  email?: string;
  planName?: string;
  displayMessage?: string;
  plan?: UsagePlan;
  spendLimit?: UsageSpendLimit;
  grok?: UsageGrok;
  billingCycle?: { start?: number | string; end?: number | string; daysLeft?: number };
}

export interface ModelsView {
  models?: Array<{ id: string; name?: string }>;
}

export interface RuntimeSettingsView {
  maxToolRounds: number;
  apiBaseUrl: string;
  retryCount: number;
  retryIntervalMs: number;
  retryHttpStatusCodes: number[];
  revision?: number;
}
