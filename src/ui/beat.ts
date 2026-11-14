import { useLayoutEffect, useRef } from 'react';

// Puts the one-second pulses inside an element on a shared beat, so the bolt in the sidebar and the
// card of the device being updated light up together however late each one appeared.
export function useBeat<T extends Element>(on = true) {
  const ref = useRef<T>(null);
  useLayoutEffect(() => {
    if (!on) return;
    for (const a of ref.current?.getAnimations({ subtree: true }) ?? []) a.startTime = 0;
  }, [on]);
  return ref;
}
