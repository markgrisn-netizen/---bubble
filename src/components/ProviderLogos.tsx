import React from 'react';
import type { AiProviderId } from '../types/domain';

interface ProviderLogoProps {
  provider: AiProviderId;
  className?: string;
}

export const ProviderLogo: React.FC<ProviderLogoProps> = ({
  provider,
  className = 'w-6 h-6',
}) => {
  switch (provider) {
    case 'gemini':
      return (
        <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
          <path
            d="M12 2C12.8 7.1 16.9 11.2 22 12C16.9 12.8 12.8 16.9 12 22C11.2 16.9 7.1 12.8 2 12C7.1 11.2 11.2 7.1 12 2Z"
            fill="url(#gemini-grad)"
          />
          <defs>
            <linearGradient id="gemini-grad" x1="2" y1="2" x2="22" y2="22" gradientUnits="userSpaceOnUse">
              <stop stopColor="#4285F4" />
              <stop offset="0.55" stopColor="#7C5CFF" />
              <stop offset="1" stopColor="#06B6D4" />
            </linearGradient>
          </defs>
        </svg>
      );

    case 'groq':
      return (
        <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
          <rect x="2" y="2" width="20" height="20" rx="5" fill="#F55036" />
          <path
            d="M15.8 9.2A4.5 4.5 0 0 0 7.5 11.5a4.5 4.5 0 0 0 4.5 4.5c2.2 0 3.9-1.4 4.3-3.5H12v-2h6.4c.1.4.1.8.1 1.2 0 3.7-2.8 6.3-6.5 6.3A6.5 6.5 0 1 1 17.1 7.6l-1.3 1.6Z"
            fill="#FFFFFF"
          />
        </svg>
      );

    case 'openrouter':
      return (
        <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
          <rect x="2" y="2" width="20" height="20" rx="5" className="fill-slate-900 dark:fill-slate-100" />
          <path
            d="M7 12h4.2l2.6-3.8H17M11.2 12l2.6 3.8H17"
            className="stroke-white dark:stroke-slate-900"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <circle cx="7" cy="12" r="1.6" fill="#6366F1" />
          <circle cx="17" cy="8.2" r="1.6" fill="#10B981" />
          <circle cx="17" cy="15.8" r="1.6" fill="#06B6D4" />
        </svg>
      );

    case 'cloudflare':
      return (
        <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
          <path
            d="M17.4 17.5H6.8a3.8 3.8 0 0 1-.5-7.6A5.2 5.2 0 0 1 16.2 8.7a3.9 3.9 0 0 1 4.6 3.8 3.9 3.9 0 0 1-3.4 5Z"
            fill="#F38020"
          />
          <path
            d="M17.6 17.5h2.2a2.2 2.2 0 0 0 0-4.4h-.8"
            stroke="#FBAD41"
            strokeWidth="1.8"
            strokeLinecap="round"
          />
        </svg>
      );

    case 'deepseek':
      return (
        <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
          <rect x="2" y="2" width="20" height="20" rx="5" fill="#2563EB" />
          <path
            d="M6.5 13.5c1.3-3.1 4.2-4.8 7.5-4.5 1.8.2 3.1 1 3.9 2.2-1.2.4-2.2 1-2.9 1.9-.6.8-1.5 1.4-2.6 1.5-2.1.2-4.2-.2-5.9-1.1Z"
            fill="#FFFFFF"
          />
          <circle cx="14.5" cy="11.2" r="0.9" fill="#2563EB" />
        </svg>
      );

    case 'qwen_studio':
      return (
        <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
          <rect x="2" y="2" width="20" height="20" rx="5" fill="#6D28D9" />
          <path
            d="M12 6.5a5.5 5.5 0 1 0 3.7 9.6l1.7 1.7M12 9.2a2.8 2.8 0 1 1 0 5.6 2.8 2.8 0 0 1 0-5.6Z"
            stroke="#FFFFFF"
            strokeWidth="2"
            strokeLinecap="round"
          />
        </svg>
      );
  }
};
