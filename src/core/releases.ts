import type { FetchFn } from './device.ts';
import { AppError, msg, toMsg, type Msg } from './errors.ts';
import { readJson, writeJson, type Paths } from './paths.ts';
import { compareVersions, MIN_MAJOR, parseVersion, type Version } from './version.ts';

export interface Release {
  tag: string;
  prerelease: boolean; // marked as pre-release on GitHub or named -RC<n>
  published: string;
}

export interface ReleaseList {
  checked: string; // when GitHub was asked
  releases: Release[];
}

const RELEASES_URL = 'https://api.github.com/repos/ExpressLRS/ExpressLRS/releases?per_page=100';
const HEADERS = { Accept: 'application/vnd.github+json', 'User-Agent': 'elrs-auto-flash' };
export const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

interface ApiRelease {
  tag_name: string;
  published_at: string | null;
  draft?: boolean;
  prerelease?: boolean;
}

// All releases of ExpressLRS without drafts, in one request (ExpressLRS had 69 in October 2026).
export async function fetchReleases(fetchFn: FetchFn = fetch): Promise<Release[]> {
  let res: Response;
  try {
    res = await fetchFn(RELEASES_URL, { headers: HEADERS, signal: AbortSignal.timeout(15000) });
  } catch {
    throw new AppError(msg('githubOffline'));
  }
  if (res.status === 403 || res.status === 429) {
    const reset = Number(res.headers.get('x-ratelimit-reset'));
    throw new AppError(reset ? msg('githubLimitAt', { time: new Date(reset * 1000).toTimeString().slice(0, 5) }) : msg('githubLimit'));
  }
  if (!res.ok) throw new AppError(msg('githubStatus', { status: res.status }));
  const list = (await res.json()) as ApiRelease[];
  return list
    .filter((r) => !r.draft && r.published_at)
    .map((r) => ({
      tag: r.tag_name,
      prerelease: !!r.prerelease || parseVersion(r.tag_name)?.rc !== undefined,
      published: r.published_at!,
    }));
}

export function loadReleases(p: Paths): Promise<ReleaseList | undefined> {
  return readJson<ReleaseList>(p.releases);
}

// Asks GitHub now and keeps the answer.
export async function checkReleases(p: Paths, fetchFn: FetchFn = fetch, now = new Date()): Promise<ReleaseList> {
  const list = { checked: now.toISOString(), releases: await fetchReleases(fetchFn) };
  await writeJson(p.releases, list);
  return list;
}

// The kept list, asked anew when it is older than CHECK_EVERY_MS. When GitHub cannot be reached the
// last list stays in use and error says why.
export async function currentReleases(
  p: Paths,
  fetchFn: FetchFn = fetch,
  now = new Date(),
): Promise<{ list?: ReleaseList; error?: Msg }> {
  const kept = await loadReleases(p);
  if (kept && now.getTime() - Date.parse(kept.checked) < CHECK_EVERY_MS) return { list: kept };
  try {
    return { list: await checkReleases(p, fetchFn, now) };
  } catch (e) {
    return { list: kept, error: toMsg(e) };
  }
}

const withVersion = (releases: Release[]) =>
  releases.flatMap((r) => {
    const version = parseVersion(r.tag);
    return version ? [{ ...r, version }] : [];
  });

export type VersionedRelease = Release & { version: Version };

// The version devices of one major version are brought to: the newest final release, with release
// candidates the newest of all.
export function targetRelease(releases: Release[], major: number, releaseCandidates: boolean): VersionedRelease | undefined {
  return withVersion(releases)
    .filter((r) => r.version.major === major && (releaseCandidates || !r.prerelease))
    .sort((a, b) => compareVersions(b.version, a.version))[0];
}

// Major versions from 3 on that have a final release, newest first.
export function majorVersions(releases: Release[]): number[] {
  const majors = withVersion(releases)
    .filter((r) => !r.prerelease && r.version.major >= MIN_MAJOR)
    .map((r) => r.version.major);
  return [...new Set(majors)].sort((a, b) => b - a);
}
