import { createElement as h, Fragment } from 'react';

export function IgnoredChart() {
  // Returning null would let Markdown fall back to displaying the code block.
  return h(Fragment);
}
