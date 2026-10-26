import { compareVersions, MIN_MAJOR, parseVersion, type Version } from './version.ts';

export type DeviceState =
  | 'current' // on the target version
  | 'update' // older than the target version
  | 'newer' // newer than the target version: never flashed back
  | 'custom-build' // a branch name instead of a version: only flashed by its own button
  | 'no-target-version' // no target version chosen yet, or none known for the chosen major version
  | 'unsupported'; // below 3.0 or no version reported

// Where a device stands against the target version (undefined while none is set or known).
export function deviceState(version: string | undefined, target: Version | undefined): DeviceState {
  if (!version) return 'unsupported';
  const v = parseVersion(version);
  if (!v) return 'custom-build';
  if (v.major < MIN_MAJOR) return 'unsupported';
  if (!target) return 'no-target-version';
  const c = compareVersions(v, target);
  return c < 0 ? 'update' : c > 0 ? 'newer' : 'current';
}
