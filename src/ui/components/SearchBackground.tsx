import { useEffect, useLayoutEffect, useRef } from 'react';
import type { SearchLook } from '../../server/api.ts';

const ROUND = 6000; // ms for one pass, the same in all three

// Puts the background over the page area next to the sidebar and gives each card on the network the moment
// the animation reaches it. Every part runs on the document clock, so cards that show up later are in step.
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

  const look = bg.dataset.look as SearchLook;
  for (const card of main.querySelectorAll<HTMLElement>('.search-hit')) {
    const r = card.getBoundingClientRect();
    const x = r.left + r.width / 2 - m.left;
    const y = r.top + r.height / 2;
    let period = ROUND;
    let at: number;
    if (look === 'radar') at = (((Math.atan2(x - W / 2, -(y - H / 2)) * 180) / Math.PI + 360) % 360) / 360 * ROUND;
    else if (look === 'waves') {
      period = ROUND / 3; // a new wave every third of a round
      at = ((Math.hypot(x - cx, y - cy) / rmax) * ROUND) % period;
    } else at = (y / (H + bh)) * 0.8 * ROUND; // the band runs for 80 % of the round, then rests
    card.style.setProperty('--search-period', `${period}ms`);
    card.style.setProperty('--search-delay', `${Math.round(at - period)}ms`);
  }
  for (const a of main.getAnimations({ subtree: true })) {
    if (a instanceof CSSAnimation && a.animationName.startsWith('search-') && a.startTime !== 0) a.startTime = 0;
  }
}

// Moves behind the devices while the app looks for them, in the look chosen in the settings.
export function SearchBackground({ look }: { look: SearchLook }) {
  const ref = useRef<HTMLDivElement>(null);
  // after every render: cards come, go and move with each update from the server
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
