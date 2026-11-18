import React, { useState } from 'react';
import { Download, Share, X } from 'lucide-react';
import { usePWAInstall } from '../hooks/usePWAInstall';
import type { LanguageCode } from '../types/domain';

interface PWAInstallButtonProps {
  lang: LanguageCode;
  compact?: boolean;
}

export const PWAInstallButton: React.FC<PWAInstallButtonProps> = ({ lang, compact = false }) => {
  const { isInstallable, isInstalled, isIOS, install } = usePWAInstall();
  const [showIOSGuide, setShowIOSGuide] = useState(false);

  if (isInstalled) {
    return null;
  }

  const label = lang === 'ar' ? 'تثبيت التطبيق' : 'Install App';

  if (isInstallable) {
    return (
      <button
        type="button"
        onClick={() => void install()}
        data-testid="pwa-install-btn"
        title={label}
        aria-label={label}
        className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl border-2 border-[#111111] bg-[#FFFDF9] dark:bg-[#1C1D24] dark:border-[#FFE01B] text-[#111111] dark:text-[#FFE01B] hover:bg-[#FFE01B] hover:text-[#111111] text-xs font-extrabold whitespace-nowrap shrink-0 cursor-pointer transition-colors"
      >
        <Download className="w-3.5 h-3.5 shrink-0" />
        {!compact && <span>{label}</span>}
      </button>
    );
  }

  if (isIOS) {
    return (
      <>
        <button
          type="button"
          onClick={() => setShowIOSGuide(true)}
          data-testid="pwa-ios-install-btn"
          title={label}
          aria-label={label}
          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl border-2 border-[#111111]/25 dark:border-white/20 bg-[#FFFDF9] dark:bg-[#1C1D24] text-[#111111] dark:text-[#FFFDF9] hover:border-[#111111] text-xs font-extrabold whitespace-nowrap shrink-0 cursor-pointer transition-colors"
        >
          <Share className="w-3.5 h-3.5 shrink-0" />
          {!compact && <span>{label}</span>}
        </button>

        {showIOSGuide && (
          <div
            role="dialog"
            aria-modal="true"
            aria-label={label}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          >
            <div className="w-full max-w-sm faqqa-card p-5 space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="font-display-comic text-base font-black text-[#111111] dark:text-[#FFFDF9]">
                  {lang === 'ar' ? 'تثبيت فُقّاعة على الجهاز' : 'Install Faqqa on iPhone / iPad'}
                </h3>
                <button
                  type="button"
                  onClick={() => setShowIOSGuide(false)}
                  aria-label="Close"
                  className="p-1.5 rounded-lg hover:bg-[#FAF5E8] dark:hover:bg-white/10 cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
              <p className="text-xs leading-relaxed text-[#524E46] dark:text-slate-300">
                {lang === 'ar'
                  ? '1. اضغط على زر المشاركة (Share) في شريط Safari.\n2. اختر «إضافة إلى الشاشة الرئيسية» (Add to Home Screen).'
                  : '1. Tap Share in Safari toolbar.\n2. Scroll and tap Add to Home Screen.'}
              </p>
              <button
                type="button"
                onClick={() => setShowIOSGuide(false)}
                className="faqqa-btn-yellow w-full py-2 rounded-xl text-xs font-black cursor-pointer"
              >
                {lang === 'ar' ? 'حسناً' : 'Got it'}
              </button>
            </div>
          </div>
        )}
      </>
    );
  }

  return null;
};
