import { describe, expect, it } from 'vitest';
import { isWebLink } from '../src/desktop/links.ts';

describe('isWebLink', () => {
  it('lets web pages open in the browser', () => {
    for (const url of ['https://github.com/Mariator-pro/elrs-auto-flash', 'https://www.expresslrs.org/quick-start/', 'http://10.0.0.1/', 'HTTPS://example.com/']) {
      expect(isWebLink(url)).toBe(true);
    }
  });

  it('keeps every other scheme from the system', () => {
    for (const url of [
      'file:///C:/Windows/System32/calc.exe',
      'file://attacker.example/share/run.exe',
      'smb://attacker.example/share',
      'ms-msdt:/id PCWDiagnostic',
      'search-ms:query=x&crumb=location:\\\\attacker.example\\share',
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'mailto:someone@example.com',
      '',
      'not a url',
    ]) {
      expect(isWebLink(url)).toBe(false);
    }
  });
});
