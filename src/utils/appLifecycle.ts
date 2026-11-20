import { useEffect, useRef } from 'react';

export interface AppLifecycleCallbacks {
  onHide?: () => void | Promise<void>;
  onResume?: () => void | Promise<void>;
}

/**
 * Handles mobile Android & browser background/foreground transitions (`visibilitychange`,
 * `pagehide`, `pageshow`, `online`) cleanly without discarding user state or canceling jobs.
 */
export function useAppLifecycle(callbacks: AppLifecycleCallbacks): void {
  const cbRef = useRef(callbacks);
  cbRef.current = callbacks;

  useEffect(() => {
    let wasHidden = typeof document !== 'undefined' ? document.visibilityState === 'hidden' : false;
    let lastResumeAt = 0;

    const triggerHide = () => {
      wasHidden = true;
      void cbRef.current.onHide?.();
    };

    const triggerResume = () => {
      const now = Date.now();
      if (now - lastResumeAt < 350) return;
      lastResumeAt = now;
      wasHidden = false;
      void cbRef.current.onResume?.();
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        triggerHide();
      } else if (document.visibilityState === 'visible') {
        if (wasHidden) {
          triggerResume();
        }
      }
    };

    const handlePageHide = () => {
      triggerHide();
    };

    const handlePageShow = () => {
      triggerResume();
    };

    const handleOnline = () => {
      triggerResume();
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('pagehide', handlePageHide);
    window.addEventListener('pageshow', handlePageShow);
    window.addEventListener('online', handleOnline);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('pagehide', handlePageHide);
      window.removeEventListener('pageshow', handlePageShow);
      window.removeEventListener('online', handleOnline);
    };
  }, []);
}

/**
 * Best-effort Background Sync registration when supported by Chromium/Android WebView.
 * Never throws or assumes OS will bypass battery optimization.
 */
export async function requestBackgroundSyncIfSupported(tag = 'faqqa-sync-jobs'): Promise<boolean> {
  try {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return false;
    const reg = await navigator.serviceWorker.ready;
    const syncManager = (reg as ServiceWorkerRegistration & {
      sync?: { register: (t: string) => Promise<void> };
    }).sync;
    if (!syncManager?.register) return false;
    await syncManager.register(tag);
    return true;
  } catch {
    return false;
  }
}
