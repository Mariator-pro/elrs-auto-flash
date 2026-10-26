import { describe, expect, it } from 'vitest';
import type { FetchFn } from '../src/core/device.ts';
import { paths, writeJson } from '../src/core/paths.ts';
import {
  CHECK_EVERY_MS,
  checkReleases,
  currentReleases,
  fetchReleases,
  loadReleases,
  majorVersions,
  targetRelease,
  type Release,
} from '../src/core/releases.ts';
import { loadSettings, saveSettings } from '../src/core/settings.ts';
import { fixture, tempDir } from './helpers.ts';

// GitHub as it answered on 2026-10-25 (69 releases from 0.1.0-RC1 to 4.1.0).
async function github(): Promise<{ fetchFn: FetchFn; calls: () => number }> {
  const body = JSON.stringify(await fixture('github-releases-2026-10-25.json'));
  let n = 0;
  const fetchFn = (async () => {
    n++;
    return new Response(body, { headers: { 'Content-Type': 'application/json' } });
  }) as unknown as FetchFn;
  return { fetchFn, calls: () => n };
}

const answer = (status: number, headers: Record<string, string> = {}) =>
  (async () => new Response('{}', { status, headers })) as unknown as FetchFn;

describe('fetchReleases', () => {
  it('reads all releases and marks release candidates', async () => {
    const releases = await fetchReleases((await github()).fetchFn);
    expect(releases).toHaveLength(69);
    expect(releases[0]).toEqual({ tag: '4.1.0', prerelease: false, published: '2026-07-17T17:02:11Z' });
    expect(releases.find((r) => r.tag === '4.1.0-RC1')?.prerelease).toBe(true);
  });

  it('leaves out drafts and treats an -RC tag as release candidate even unmarked', async () => {
    const body = JSON.stringify([
      { tag_name: '4.2.0', published_at: null, draft: true, prerelease: false },
      { tag_name: '4.2.0-RC1', published_at: '2026-10-01T00:00:00Z', draft: false, prerelease: false },
    ]);
    const releases = await fetchReleases((async () => new Response(body)) as unknown as FetchFn);
    expect(releases).toEqual([{ tag: '4.2.0-RC1', prerelease: true, published: '2026-10-01T00:00:00Z' }]);
  });

  it('explains the rate limit, other answers and a missing connection', async () => {
    const reset = String(Date.UTC(2026, 9, 25, 14, 30) / 1000);
    await expect(fetchReleases(answer(403, { 'x-ratelimit-reset': reset }))).rejects.toThrow(/rate limit reached, try again after \d\d:\d\d/);
    await expect(fetchReleases(answer(500))).rejects.toThrow('GitHub answered 500');
    const offline = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as FetchFn;
    await expect(fetchReleases(offline)).rejects.toThrow('No connection to GitHub');
  });
});

describe('targetRelease and majorVersions', () => {
  let releases: Release[];
  const load = async () => (releases ??= await fetchReleases((await github()).fetchFn));

  it('finds the newest release of each major version, also when an older major version got one later', async () => {
    await load();
    expect(targetRelease(releases, 4, false)?.tag).toBe('4.1.0');
    expect(targetRelease(releases, 3, false)?.tag).toBe('3.6.4');
    expect(targetRelease(releases, 5, false)).toBeUndefined();
  });

  it('takes release candidates only with the switch on, and only when newer', async () => {
    await load();
    expect(targetRelease(releases, 4, true)?.tag).toBe('4.1.0');
    const withRc: Release[] = [...releases, { tag: '4.2.0-RC1', prerelease: true, published: '2026-10-20T00:00:00Z' }];
    expect(targetRelease(withRc, 4, true)?.tag).toBe('4.2.0-RC1');
    expect(targetRelease(withRc, 4, false)?.tag).toBe('4.1.0');
  });

  it('lists the major versions from 3 on with a final release', async () => {
    await load();
    expect(majorVersions(releases)).toEqual([4, 3]);
    expect(majorVersions([...releases, { tag: '5.0.0-RC1', prerelease: true, published: '2026-10-20T00:00:00Z' }])).toEqual([4, 3]);
  });
});

describe('kept list of releases', () => {
  it('asks GitHub, keeps the answer and asks again after 6 hours', async () => {
    const p = paths(await tempDir());
    const gh = await github();
    const now = new Date('2026-10-25T12:00:00Z');
    await checkReleases(p, gh.fetchFn, now);
    expect((await loadReleases(p))?.checked).toBe(now.toISOString());
    expect(gh.calls()).toBe(1);
    await currentReleases(p, gh.fetchFn, new Date(now.getTime() + CHECK_EVERY_MS - 1000));
    expect(gh.calls()).toBe(1);
    await currentReleases(p, gh.fetchFn, new Date(now.getTime() + CHECK_EVERY_MS + 1000));
    expect(gh.calls()).toBe(2);
  });

  it('keeps using the last list when GitHub cannot be reached, and says why', async () => {
    const p = paths(await tempDir());
    await writeJson(p.releases, { checked: '2026-10-01T00:00:00Z', releases: [{ tag: '4.1.0', prerelease: false, published: '2026-07-17T18:54:49Z' }] });
    const { list, error } = await currentReleases(p, answer(500), new Date('2026-10-25T12:00:00Z'));
    expect(list?.releases).toHaveLength(1);
    expect(error).toEqual({ message: 'GitHub answered 500', code: 'githubStatus', params: { status: 500 } });
    expect(await currentReleases(paths(await tempDir()), answer(500))).toEqual({ list: undefined, error: { message: 'GitHub answered 500', code: 'githubStatus', params: { status: 500 } } });
  });
});

describe('settings', () => {
  it('starts with no target version and both switches off, and keeps what is saved', async () => {
    const p = paths(await tempDir());
    expect(await loadSettings(p)).toEqual({ autoUpdate: false, releaseCandidates: false });
    await saveSettings(p, { targetMajor: 4, autoUpdate: true, releaseCandidates: false });
    expect(await loadSettings(p)).toEqual({ targetMajor: 4, autoUpdate: true, releaseCandidates: false });
  });

  it('drops a target version that is not a whole number and survives a broken file', async () => {
    const p = paths(await tempDir());
    await writeJson(p.settings, { targetMajor: '4', releaseCandidates: true });
    expect(await loadSettings(p)).toEqual({ autoUpdate: false, releaseCandidates: true });
    const broken = paths(await tempDir());
    await writeJson(broken.settings, 'x');
    expect(await loadSettings(broken)).toMatchObject({ autoUpdate: false });
  });
});
