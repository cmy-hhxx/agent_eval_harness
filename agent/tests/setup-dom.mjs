// Reuse the upstream DOM observer fixture; jsdom's URL lacks the browser
// methods that the upstream preview-lifecycle tests explicitly spy on.
import '../../vendor/deepseek/scripts/test-dom-environment.ts';
import { URL as NodeURL } from 'node:url';

if (typeof document !== 'undefined') {
  for (const name of ['createObjectURL', 'revokeObjectURL']) {
    if (typeof URL[name] !== 'function') {
      Object.defineProperty(URL, name, { configurable: true, writable: true, value: NodeURL[name] });
    }
  }
}
