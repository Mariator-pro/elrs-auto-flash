import { Alert, Button, Spinner } from '@heroui/react';
import { useEffect, useState } from 'react';
import { usePrefs } from '../usePrefs.ts';

const WEB_FLASHER_URL = 'https://expresslrs.github.io/web-flasher/';

// Flashing over a cable needs Web Serial, which only Chromium has.
const hasSerial = 'serial' in navigator;

// Only whether the page answers: a cross-origin frame does not tell when it failed to load.
async function reachable(): Promise<boolean> {
  try {
    await fetch(WEB_FLASHER_URL, { mode: 'no-cors', cache: 'no-store' });
    return true;
  } catch {
    return false;
  }
}

// Kept mounted once opened, so leaving the page does not cut off a running flash.
export function WebFlasherPage({ hidden }: { hidden: boolean }) {
  const { t } = usePrefs();
  const [status, setStatus] = useState<'checking' | 'ok' | 'offline'>('checking');
  const check = () => {
    setStatus('checking');
    void reachable().then((ok) => setStatus(ok ? 'ok' : 'offline'));
  };
  useEffect(check, []);

  return (
    <div className={hidden ? 'hidden' : 'flex flex-1 flex-col gap-6'}>
      <div className="flex flex-col gap-1.5">
        <h1 className="m-0 text-3xl font-bold tracking-tight">ExpressLRS Web Flasher</h1>
        <p className="m-0 max-w-3xl text-sm leading-relaxed text-muted">{t.webFlasherNote}</p>
      </div>
      {!hasSerial && (
        <Alert status="warning">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>{t.noSerialTitle}</Alert.Title>
            <Alert.Description>{t.noSerialText}</Alert.Description>
          </Alert.Content>
        </Alert>
      )}
      {status === 'checking' ? (
        <Spinner />
      ) : status === 'offline' ? (
        <Alert status="danger">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>{t.webFlasherOffline}</Alert.Title>
            <Alert.Description>{t.webFlasherOfflineText}</Alert.Description>
          </Alert.Content>
          <Button variant="outline" onPress={check}>
            {t.reload}
          </Button>
        </Alert>
      ) : (
        // No allow-top-navigation: the page must not lead this window elsewhere.
        <iframe
          src={WEB_FLASHER_URL}
          title="ExpressLRS Web Flasher"
          allow="serial"
          sandbox="allow-scripts allow-same-origin allow-forms allow-downloads allow-popups allow-popups-to-escape-sandbox allow-modals"
          className="min-h-[640px] w-full flex-1 rounded-2xl border border-separator bg-white"
        />
      )}
    </div>
  );
}
