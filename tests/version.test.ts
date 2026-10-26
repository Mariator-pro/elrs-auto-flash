import { describe, expect, it } from 'vitest';
import { deviceState } from '../src/core/state.ts';
import { compareVersions, parseVersion, type Version } from '../src/core/version.ts';

const v = (text: string) => parseVersion(text)!;

describe('parseVersion', () => {
  it('reads releases and release candidates', () => {
    expect(parseVersion('4.1.0')).toEqual({ major: 4, minor: 1, patch: 0 });
    expect(parseVersion('4.1.0-RC1')).toEqual({ major: 4, minor: 1, patch: 0, rc: 1 });
    expect(parseVersion('3.0.0-rc12')).toEqual({ major: 3, minor: 0, patch: 0, rc: 12 });
    expect(parseVersion('3.5.4 (a6f9a2)')).toEqual({ major: 3, minor: 5, patch: 4 });
  });

  it('gives undefined for branch names of own builds and other text', () => {
    for (const text of ['master', '4.x-maint', '3.x.x-maintenance', 'ver.unknown', '4.1', '4.1.0-beta', 'master (a6f9a2)', '4.1.0 a6f9a2', '']) {
      expect(parseVersion(text)).toBeUndefined();
    }
  });
});

describe('compareVersions', () => {
  it('orders release candidates before the final version', () => {
    const order = ['3.6.4', '4.0.0-RC1', '4.0.0-RC4', '4.0.0', '4.0.1', '4.1.0-RC1', '4.1.0-RC2', '4.1.0', '4.1.1', '4.10.0'];
    const shuffled = [...order].reverse();
    expect(shuffled.sort((a, b) => compareVersions(v(a), v(b)))).toEqual(order);
    expect(compareVersions(v('4.1.0'), v('4.1.0'))).toBe(0);
  });
});

describe('deviceState', () => {
  const target: Version = v('4.1.0');

  it('compares the device with the target version', () => {
    expect(deviceState('4.1.0', target)).toBe('current');
    expect(deviceState('4.0.1', target)).toBe('update');
    expect(deviceState('4.1.0-RC1', target)).toBe('update');
    expect(deviceState('3.6.4', target)).toBe('update');
    expect(deviceState('3.5.4 (a6f9a2)', target)).toBe('update');
    expect(deviceState('4.1.1', target)).toBe('newer');
    expect(deviceState('5.0.0-RC1', target)).toBe('newer');
  });

  it('knows own builds, devices below 3.0 and a missing target version', () => {
    expect(deviceState('master', target)).toBe('custom-build');
    expect(deviceState('4.x-maint', undefined)).toBe('custom-build');
    expect(deviceState('2.5.2', target)).toBe('unsupported');
    expect(deviceState(undefined, target)).toBe('unsupported');
    expect(deviceState('3.0.0-RC1', target)).toBe('update');
    expect(deviceState('4.1.0', undefined)).toBe('no-target-version');
  });
});
