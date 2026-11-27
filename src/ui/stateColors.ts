import type { WatchState } from '../server/api.ts';

// Chip colour of each device state, shared by the device cards and the activity list.
export type Color = 'default' | 'accent' | 'success' | 'warning' | 'danger';

export const COLORS: Record<WatchState, Color> = {
  current: 'success',
  update: 'warning',
  newer: 'default',
  'custom-build': 'default',
  'no-target-version': 'default',
  unsupported: 'default',
  unconfirmed: 'accent',
  mismatch: 'danger',
  failed: 'danger',
  queued: 'default',
  flashing: 'accent',
};
