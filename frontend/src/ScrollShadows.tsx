import { useEffect } from 'react';

// Observe shared scroll viewports, including dropdowns and dialogs in portals.
// Shadows live on the stationary root so they stay above scrolling content.
export default function ScrollShadows() {
  useEffect(() => {
    const viewports = new Map<HTMLElement, { root: HTMLElement; content: Element | null }>();
    let frame = 0;
    let rescan = true;

    function update() {
      frame = 0;
      if (rescan) {
        rescan = false;
        resize.disconnect();
        for (const [viewport, { root }] of viewports) {
          if (!viewport.isConnected) {
            viewports.delete(viewport);
            root.removeAttribute('data-scroll-top');
            root.removeAttribute('data-scroll-bottom');
          }
        }
        document.querySelectorAll<HTMLElement>('[data-scrollarea-viewport]').forEach(viewport => {
          const root = viewport.closest<HTMLElement>('.mantine-ScrollArea-root');
          if (root) viewports.set(viewport, { root, content: viewport.firstElementChild });
        });
        for (const [viewport, { content }] of viewports) {
          resize.observe(viewport);
          if (content) resize.observe(content);
        }
      }
      for (const [viewport, { root }] of viewports) {
        const overflowing = viewport.clientHeight > 0 && viewport.scrollHeight > viewport.clientHeight + 1;
        root.toggleAttribute('data-scroll-top', overflowing && viewport.scrollTop > 1);
        root.toggleAttribute('data-scroll-bottom', overflowing && viewport.scrollTop + viewport.clientHeight < viewport.scrollHeight - 1);
      }
    }
    function schedule() {
      if (!frame) frame = requestAnimationFrame(update);
    }
    const resize = new ResizeObserver(schedule);
    const mutations = new MutationObserver(() => { rescan = true; schedule(); });
    mutations.observe(document.body, { childList: true, subtree: true, characterData: true });
    document.addEventListener('scroll', schedule, { capture: true, passive: true });
    window.addEventListener('resize', schedule);
    schedule();
    return () => {
      cancelAnimationFrame(frame);
      mutations.disconnect();
      resize.disconnect();
      document.removeEventListener('scroll', schedule, true);
      window.removeEventListener('resize', schedule);
      for (const { root } of viewports.values()) {
        root.removeAttribute('data-scroll-top');
        root.removeAttribute('data-scroll-bottom');
      }
    };
  }, []);
  return null;
}
