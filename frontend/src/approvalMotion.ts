/** Animate a successfully queued operation toward the visible approvals control. */
export function flyToApprovals(source: HTMLElement) {
  const visible = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)]
    .find(element => { const box = element.getBoundingClientRect(); return box.width > 0 && box.height > 0; });
  const target = visible('[data-approval-target]');
  if (!target || !source.isConnected) return;
  const from = source.getBoundingClientRect(), to = target.getBoundingClientRect();
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  source.animate([{ transform: 'scale(1)' }, { transform: 'scale(.88)' }, { transform: 'scale(1)' }], { duration: 220, easing: 'ease-out' });
  const token = document.createElement('span');
  token.className = 'approval-flight';
  token.textContent = source.textContent;
  token.setAttribute('aria-hidden', 'true');
  Object.assign(token.style, { left: `${from.left}px`, top: `${from.top}px`, width: `${from.width}px`, height: `${from.height}px` });
  document.body.append(token);
  const dx = to.left + to.width / 2 - from.left - from.width / 2;
  const dy = to.top + to.height / 2 - from.top - from.height / 2;
  const arc = Math.min(-100, dy / 2 - 100);
  const frames = Array.from({ length: 31 }, (_, index) => {
    const progress = index / 30;
    const y = 2 * (1 - progress) * progress * arc + progress * progress * dy;
    return { transform: `translate(${dx * progress}px, ${y}px) scale(${1 - .9 * progress})`, opacity: progress > .85 ? (1 - progress) / .15 : 1, offset: progress };
  });
  const animation = token.animate(frames, { duration: 680, easing: 'linear', fill: 'forwards' });
  void animation.finished.then(() => {
    token.remove();
    target.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.06)' }, { transform: 'scale(1)' }], { duration: 240 });
  }).catch(() => token.remove());
}
