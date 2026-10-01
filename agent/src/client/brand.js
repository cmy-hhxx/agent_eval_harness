import { createElement } from 'react';
import markUrl from './brand/eris.svg';

function ErisMark({ size, className }) {
  return createElement('img', { src: markUrl, width: size, height: size, style: typeof size === 'string' ? { width: size, height: size } : undefined, className, alt: '', 'aria-hidden': true, 'data-brand': 'eris' });
}

export const inject = ['slots'];
export function apply(ctx) {
  for (const name of ['sidebar.brand.mark', 'conversation.hero.brand.mark', 'conversation.running.brand.mark']) {
    ctx.slots.inject(name, () => ctx.slots.register({ name }, ErisMark));
  }
  ctx.slots.inject('sidebar.brand.name', () => ctx.slots.register({ name: 'sidebar.brand.name' }, () => 'Eris'));
}
