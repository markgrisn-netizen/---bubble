import React from 'react';
import { WifiOff } from 'lucide-react';
import { useOnlineStatus } from '../hooks/usePWAInstall';
import type { LanguageCode } from '../types/domain';

export const OfflineIndicator: React.FC<{ lang: LanguageCode }> = ({ lang }) => {
  const isOnline = useOnlineStatus();
  if (isOnline) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed bottom-4 start-4 z-50 flex items-center gap-2 rounded-xl border-2 border-[#111111] bg-[#FFE01B] text-[#111111] shadow-[3px_3px_0px_#111111] px-3 py-1.5 text-xs font-extrabold"
    >
      <WifiOff className="w-3.5 h-3.5 text-[#EA3829] shrink-0" />
      <span>
        {lang === 'ar'
          ? 'وضع عدم الاتصال — الفصول المحفوظة متاحة للقراءة'
          : 'Offline Mode — Saved chapters remain available'}
      </span>
    </div>
  );
};
