import { describe, expect, it } from 'vitest';
import { MESSAGES, msg, toMsg, AppError } from '../src/core/errors.ts';
import { message, resultText, sentence } from '../src/ui/format.ts';
import { TEXTS } from '../src/ui/texts.ts';

const { de, en } = TEXTS;

describe('messages of the program', () => {
  it('carry their code, are translated in German and stay as they came in English', () => {
    const m = msg('uploadLost', { code: 'ECONNRESET' });
    expect(m).toEqual({ message: 'connection lost (ECONNRESET)', code: 'uploadLost', params: { code: 'ECONNRESET' } });
    expect(message(m, de)).toBe('Verbindung abgebrochen (ECONNRESET)');
    expect(message(m, en)).toBe('connection lost (ECONNRESET)');
    expect(toMsg(new AppError(msg('tooOld'), 'unsupported'))).toEqual({ message: MESSAGES.tooOld(), code: 'tooOld' });
  });

  it('show messages of devices as they came', () => {
    expect(message({ message: 'Current target: X.' }, de)).toBe('Current target: X.');
    expect(resultText({ result: 'mismatch', message: 'Current target: X.' }, '4.1.0', de)).toBe(
      'Firmware passt nicht zum Target, vom Gerät abgelehnt: Current target: X.',
    );
  });

  it('have a German text for every code', () => {
    for (const code of Object.keys(MESSAGES) as (keyof typeof MESSAGES)[]) expect(de.messages[code]).toBeTypeOf('function');
  });
});

describe('texts', () => {
  it('end a message as a sentence once, before the next one follows', () => {
    expect(de.noticeFailedText(sentence(message(msg('uploadTimeout'), de)))).toMatch(/^Letzter Fehler: keine Antwort vom Gerät\. Prüf/);
    expect(de.noticeFailedText(sentence(message(msg('stillRuns', { version: '4.0.1', to: '4.1.0' }), de)))).not.toContain('..');
  });

  it('name the button of a grouped line by how many it opens', () => {
    expect([1, 2, 5].map(de.showAll)).toEqual(['Zeigen', 'Beide zeigen', 'Alle 5 zeigen']);
    expect([1, 2, 5].map(en.showAll)).toEqual(['Show', 'Show both', 'Show all 5']);
  });
});
