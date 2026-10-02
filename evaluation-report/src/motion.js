(() => {
  'use strict';

  const preference = window.matchMedia?.('(prefers-reduced-motion: reduce)');
  const active = new Set();
  const byElement = new WeakMap();

  function forget(entry) {
    active.delete(entry);
    if (byElement.get(entry.element) === entry) byElement.delete(entry.element);
  }

  function cancel(element) {
    const entry = byElement.get(element);
    if (!entry) return;
    forget(entry);
    entry.animation.cancel();
  }

  function cancelAll() {
    for (const entry of active) cancel(entry.element);
  }

  function play(element, keyframes, duration) {
    if (preference?.matches || typeof element?.animate !== 'function') return null;
    const animation = element.animate(keyframes, {
      duration, easing: 'cubic-bezier(.2,.65,.3,1)', fill: 'none',
    });
    const entry = { element, animation };
    active.add(entry);
    byElement.set(element, entry);
    // Cancellation rejects finished; both outcomes release tracking without writing styles.
    animation.finished.then(() => forget(entry), () => forget(entry));
    return animation;
  }

  function reveal(element, { distance = 6, duration = 180 } = {}) {
    if (!element) return null;
    cancel(element);
    if (preference?.matches || typeof element.animate !== 'function') return null;
    const style = window.getComputedStyle(element);
    const transform = style.transform === 'none' ? '' : style.transform;
    return play(element, [
      { opacity: .65, transform: `translateY(${distance}px) ${transform}`.trim() },
      { opacity: style.opacity || 1, transform: transform || 'none' },
    ], duration);
  }

  function trace(path) {
    if (!path) return null;
    cancel(path);
    if (preference?.matches || typeof path.animate !== 'function'
      || path.classList.contains('dependency') || path.dataset.kind === 'dependency') return null;
    const style = window.getComputedStyle(path);
    if (style.strokeDasharray && style.strokeDasharray !== 'none') return null;
    // Draw a normalized overlay; leave original edge geometry and dashes untouched.
    if (Number(path.getAttribute('pathLength')) === 1) {
      return play(path, [
        { opacity: 1, strokeDasharray: '1 1', strokeDashoffset: '1' },
        { opacity: 1, strokeDasharray: '1 1', strokeDashoffset: '0' },
      ], 260);
    }
    return play(path, [{ opacity: 0 }, { opacity: style.opacity || 1 }], 260);
  }

  preference?.addEventListener('change', cancelAll);
  window.addEventListener('beforeprint', cancelAll);
  window.ReportMotion = { reveal, trace, cancelAll };
})();
