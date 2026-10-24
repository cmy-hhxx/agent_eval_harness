import { createElement } from 'react';
import markUrl from './brand/tonghuashun.png';

const accent = '#b74a3d';
const hover = '#9f3338';
const tint = '#fbefeb';
const colors = {
  '--dsw-alias-brand-primary': accent,
  '--dsw-alias-brand-primary-new-colorprimary-new-color': accent,
  '--dsw-alias-button-info-fill': accent,
  '--dsw-alias-button-info-hover': hover,
  '--dsw-alias-button-primary-hover': hover,
  '--dsw-alias-state-business-primary': accent,
  '--dsw-alias-state-business-tertiary': tint,
  '--dsw-alias-link': accent,
  '--dsw-alias-label-deep-diving': accent,
  '--dsw-alias-label-deep-diving-shimmer': hover,
  '--dsw-specific-bubble': tint,
};

function ErisMark({ size, className }) {
  return createElement('img', { src: markUrl, width: size, height: size, style: { width: size, height: size, objectFit: 'contain' }, className, alt: '', 'aria-hidden': true, 'data-brand': 'eris' });
}

export const inject = ['slots', 'theme'];
export function apply(ctx) {
  ctx.effect(() => ctx.theme.overrideTokens('eris', Object.fromEntries(
    Object.entries(colors).map(([name, color]) => [name, { light: color, dark: color }]),
  )));
  for (const name of ['sidebar.brand.mark', 'conversation.hero.brand.mark', 'conversation.running.brand.mark']) {
    ctx.slots.inject(name, () => ctx.slots.register({ name }, ErisMark));
  }
  ctx.slots.inject('sidebar.brand.name', () => ctx.slots.register({ name: 'sidebar.brand.name' }, () => 'Eris'));
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({ name: 'sidebar.footer.action', id: 'eris-account' }, () => createElement('a', {
    href: '/account', title: '账号', 'aria-label': '账号', style: { display: 'block', padding: '10px 12px', color: 'inherit', textDecoration: 'none', borderRadius: 8 },
  }, '账号')));
}
