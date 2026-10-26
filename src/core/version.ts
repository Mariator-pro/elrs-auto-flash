// An ELRS version as devices and release tags spell it: 4.1.0 or 4.1.0-RC1; 3.x devices add the commit, 3.5.4 (a6f9a2).
export interface Version {
  major: number;
  minor: number;
  patch: number;
  rc?: number; // release candidate number; a release candidate comes before the final version
}

// undefined for anything else, such as the branch name an own build reports.
export function parseVersion(text: string): Version | undefined {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-rc(\d+))?(?: \([0-9a-f]+\))?$/i.exec(text.trim());
  if (!m) return undefined;
  const v: Version = { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
  if (m[4] !== undefined) v.rc = Number(m[4]);
  return v;
}

// Negative when a is older than b: 4.1.0-RC1 < 4.1.0-RC2 < 4.1.0 < 4.1.1.
export function compareVersions(a: Version, b: Version): number {
  return (
    a.major - b.major ||
    a.minor - b.minor ||
    a.patch - b.patch ||
    (a.rc ?? Number.MAX_SAFE_INTEGER) - (b.rc ?? Number.MAX_SAFE_INTEGER)
  );
}

// Devices from this major version on keep their options in the firmware and can be updated over WiFi.
export const MIN_MAJOR = 3;
