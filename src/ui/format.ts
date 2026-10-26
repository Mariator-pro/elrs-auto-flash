import type { FlashOutcome, Message } from '../server/api.ts';
import type { Texts } from './texts.ts';

// Local date and time, e.g. 25.10.2026, 17:58
export const dateTime = (iso: string, locale: string) =>
  new Date(iso).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' });

// Local time of day, e.g. 17:58
export const time = (iso: string, locale: string) => new Date(iso).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });

// Today only the time, else date and time.
export const when = (iso: string, locale: string) =>
  new Date(iso).toDateString() === new Date().toDateString() ? time(iso, locale) : dateTime(iso, locale);

// A message of the server in the language of the interface; one without a code as it came.
export const message = (m: Message, t: Texts) => (m.code && t.messages[m.code]?.(m.params ?? {})) || m.message;

// Ends with a full stop, so another sentence can follow.
export const sentence = (s: string) => (/[.!?]$/.test(s) ? s : `${s}.`);

// How a flash to `to` ended; `later`: confirmed when the device was seen again.
export function resultText(o: FlashOutcome, to: string, t: Texts, later?: boolean): string {
  if (o.result === 'done') return later ? t.resultConfirmed(o.version) : t.resultDone(o.version);
  if (o.result === 'wrong-version') return t.resultWrong(o.version);
  if (o.result === 'unconfirmed') return o.check === 'wifi-off' ? t.resultUnconfirmedTx : o.check === 'later' ? t.resultUploaded : t.resultUnconfirmed;
  if (o.result === 'mismatch') return t.resultMismatch(o.message);
  if (o.result === 'failed') return t.resultFailed(message(o, t));
  if (o.kind === 'gone') return t.stoppedGone;
  if (o.kind === 'download') return t.stoppedDownload(message(o, t));
  if (o.kind === 'unsupported') return t.stoppedUnsupported(to, message(o, t));
  return message(o, t);
}
