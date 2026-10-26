import { useEffect, useState } from 'react';
import { TOKEN_HEADER, TOKEN_META, type ActivityEntry, type ErrorCode, type StateView } from '../server/api.ts';
import type { Texts } from './texts.ts';

// The server's key for this start, which it put into the page.
const token = () => document.querySelector<HTMLMetaElement>(`meta[name="${TOKEN_META}"]`)?.content ?? '';

export class ApiError extends Error {
  code?: ErrorCode;
  constructor(message: string, code?: ErrorCode) {
    super(message);
    this.code = code;
  }
}

// An error for the user: translated when the server sent a code, else its message as it came.
export const errorText = (t: Texts, e: unknown) =>
  e instanceof ApiError && e.code ? t.errors[e.code] : e instanceof Error ? e.message : String(e);

async function answer<T>(res: Response): Promise<T> {
  const data = (await res.json().catch(() => ({}))) as T & { error?: string; code?: ErrorCode };
  if (!res.ok) throw new ApiError(data?.error ?? res.statusText, data?.code);
  return data;
}

export async function get<T>(path: string): Promise<T> {
  return answer<T>(await fetch(path, { headers: { [TOKEN_HEADER]: token() } }));
}

export async function post<T = void>(path: string, body: unknown = {}): Promise<T> {
  return answer<T>(await fetch(path, { method: 'POST', headers: { [TOKEN_HEADER]: token(), 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
}

// A server started anew has a new key and turns this page away: load it again, at most every 10 s.
function reloadPage(): void {
  try {
    if (Date.now() - Number(sessionStorage.getItem('reloadedAt') ?? 0) < 10_000) return;
    sessionStorage.setItem('reloadedAt', String(Date.now()));
  } catch {
    // no storage: reload all the same
  }
  location.reload();
}

// Live state and activity from the server (Server-Sent Events); the activity so far is asked for once
// the connection stands, so nothing is missed in between.
export function useServer(): { state?: StateView; activity: ActivityEntry[]; connected: boolean } {
  const [state, setState] = useState<StateView>();
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    const merge = (more: ActivityEntry[]) =>
      setActivity((now) => {
        const ids = new Set(now.map((a) => a.id));
        return [...now, ...more.filter((a) => !ids.has(a.id))].sort((a, b) => b.id - a.id).slice(0, 500);
      });
    const es = new EventSource(`/api/events?token=${encodeURIComponent(token())}`);
    es.addEventListener('state', (e) => setState(JSON.parse((e as MessageEvent).data) as StateView));
    es.addEventListener('activity', (e) => merge([JSON.parse((e as MessageEvent).data) as ActivityEntry]));
    es.onopen = () => {
      setConnected(true);
      get<ActivityEntry[]>('/api/activity').then(merge, () => {});
    };
    es.onerror = () => {
      setConnected(false);
      // closed for good means the server answered with an error; a server that is down is tried again
      if (es.readyState === EventSource.CLOSED) reloadPage();
    };
    return () => es.close();
  }, []);
  return { state, activity, connected };
}
