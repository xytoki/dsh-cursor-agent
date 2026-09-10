import { en, NS, zh, type LocaleKey } from './locales';
import { CursorSection } from './CursorSection';
import { STYLE } from './styles';
import type { CursorRpc } from './types';

export const inject = ['slots', 'locale', 'connection'];

interface ClientContext {
  effect: (fn: () => void | (() => void), name: string) => void;
  locale: {
    register: (ns: string, dict: { zh: typeof zh; en: typeof en }) => () => void;
    bind: (ns: string) => (key: LocaleKey) => string;
  };
  get: (name: string) => { rpc: CursorRpc } | undefined;
  slots: {
    inject: (slot: string, factory: () => unknown) => void;
    register: (meta: Record<string, unknown>, component: unknown) => unknown;
  };
}

export function apply(ctx: ClientContext) {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'cursor-agent: copy');
  ctx.effect(() => {
    const tag = document.createElement('style');
    tag.dataset.plugin = 'dsh-cursor-agent';
    tag.textContent = STYLE;
    document.head.append(tag);
    return () => tag.remove();
  }, 'cursor-agent: style');
  const connection = ctx.get('connection');
  const t = ctx.locale.bind(NS);
  ctx.slots.inject('settings.section', () =>
    ctx.slots.register(
      {
        name: 'settings.section',
        id: 'cursor-agent',
        order: 20,
        label: () => t('nav'),
        locale: NS,
        inject: () => ({ rpc: connection?.rpc, t }),
      },
      CursorSection,
    ),
  );
}
