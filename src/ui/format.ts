import type { FlashOutcome, Message } from '../server/api.ts';
import type { Texts } from './texts.ts';

// The day as a heading: today, yesterday, else its date (with the year only when it isn't this year's).
export function dayHeading(iso: string, t: Texts, now = new Date()): string {
  const d = new Date(iso);
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === now.toDateString()) return t.today;
  if (d.toDateString() === yesterday.toDateString()) return t.yesterday;
  const year = d.getFullYear() === now.getFullYear() ? undefined : 'numeric';
  return d.toLocaleDateString(t.locale, { weekday: 'long', day: 'numeric', month: 'long', year });
}

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
