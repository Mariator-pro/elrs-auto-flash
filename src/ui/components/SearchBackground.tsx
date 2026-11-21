import { useEffect, useLayoutEffect, useRef } from 'react';
import type { SearchLook } from '../../server/api.ts';

// Puts the background over the page area next to the sidebar. Every part runs on the document clock.
function sync(bg: HTMLElement) {
  const main = bg.closest('main');
  if (!main) return;
  const m = main.getBoundingClientRect();
  const W = m.width;
  const H = window.innerHeight;
  bg.style.left = `${m.left}px`;
  bg.style.width = `${W}px`;
  const dot = main.querySelector('[data-search-origin]')?.getBoundingClientRect();
  const cx = dot ? dot.left + dot.width / 2 - m.left : W;
  const cy = dot ? dot.top + dot.height / 2 : 0;
  const rmax = Math.hypot(Math.max(cx, W - cx), Math.max(cy, H - cy));
  const bh = Math.round(H * 0.35);
  for (const [k, v] of [['cx', cx], ['cy', cy], ['rmax', rmax], ['h', H], ['bh', bh]] as const) bg.style.setProperty(`--search-${k}`, `${v}px`);
  for (const a of main.getAnimations({ subtree: true })) {
    if (a instanceof CSSAnimation && a.animationName.startsWith('search-') && a.startTime !== 0) a.startTime = 0;
  }
}

// Moves behind the devices while the app looks for them, in the look chosen in the settings.
export function SearchBackground({ look }: { look: SearchLook }) {
  const ref = useRef<HTMLDivElement>(null);
  // after every render: the page and the search dot move with each update from the server
  useLayoutEffect(() => {
    if (ref.current) sync(ref.current);
  });
  useEffect(() => {
    const again = () => ref.current && sync(ref.current);
    window.addEventListener('resize', again);
    window.addEventListener('scroll', again, { passive: true });
    return () => {
      window.removeEventListener('resize', again);
      window.removeEventListener('scroll', again);
    };
  }, []);
  return (
    <div ref={ref} className="search-bg" data-look={look} aria-hidden="true">
      {look === 'radar' && (
        <div className="search-radar">
          <div className="search-rings" />
          <div className="search-beam" />
        </div>
      )}
      {look === 'waves' && (
        <>
          <div className="search-wave" />
          <div className="search-wave" />
          <div className="search-wave" />
        </>
      )}
      {look === 'scan' && (
        <>
          <div className="search-dots" />
          <div className="search-dots search-dots-lit" />
          <div className="search-band" />
        </>
      )}
    </div>
  );
}
