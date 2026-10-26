import { Alert, CloseButton, Spinner } from '@heroui/react';
import { useState } from 'react';
import { errorText, post, useServer } from './api.ts';
import { Sidebar, type Page } from './components/Sidebar.tsx';
import { ActivityPage } from './pages/ActivityPage.tsx';
import { DevicesPage } from './pages/DevicesPage.tsx';
import { SettingsPage } from './pages/SettingsPage.tsx';
import { WebFlasherPage } from './pages/WebFlasherPage.tsx';
import { usePrefs } from './usePrefs.ts';

export function App() {
  const { state, activity, connected } = useServer();
  const { t } = usePrefs();
  const [page, setPage] = useState<Page>('devices');
  const [flasherOpened, setFlasherOpened] = useState(false);
  const [error, setError] = useState<string>();

  const navigate = (target: Page) => {
    if (target === 'web-flasher') setFlasherOpened(true);
    setPage(target);
  };

  const run = (fn: () => Promise<unknown>) => {
    setError(undefined);
    fn().catch((e: unknown) => setError(errorText(t, e)));
  };

  return (
    <div className="flex min-h-screen flex-wrap">
      <Sidebar
        state={state}
        page={page}
        onNavigate={navigate}
        onAutoUpdate={(autoUpdate) => run(() => post('/api/settings', { autoUpdate }))}
        onCheck={() => run(() => post('/api/check'))}
        onAppUpdate={() => run(() => post('/api/app-update'))}
      />
      <main className="box-border flex min-w-0 flex-[999_1_640px] flex-col gap-6 p-7">
        {!connected && (
          <Alert status="warning">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Title>{t.noServer}</Alert.Title>
              <Alert.Description>{t.startServer}</Alert.Description>
            </Alert.Content>
          </Alert>
        )}
        {error && (
          <Alert status="danger">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Title>{t.failed}</Alert.Title>
              <Alert.Description>{error}</Alert.Description>
            </Alert.Content>
            <CloseButton aria-label={t.close} onPress={() => setError(undefined)} />
          </Alert>
        )}
        {/* outside the switch below, so it stays loaded while another page is shown */}
        {flasherOpened && <WebFlasherPage hidden={page !== 'web-flasher'} />}
        {page === 'web-flasher' ? null : !state ? (
          <Spinner />
        ) : page === 'activity' ? (
          <ActivityPage activity={activity} />
        ) : page === 'settings' ? (
          <SettingsPage state={state} run={run} />
        ) : (
          <DevicesPage state={state} run={run} onSettings={() => setPage('settings')} />
        )}
      </main>
    </div>
  );
}
