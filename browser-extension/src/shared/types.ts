export type CaptureMethod =
  | 'dom_image'
  | 'canvas_capture'
  | 'visible_tab_crop'
  | 'visible_tab_full'
  | 'auto_collect';

export interface PairingConfig {
  appUrl: string;
  sessionId: string;
  pairingToken: string;
  chapterTitle?: string;
  connectedAt?: string;
}

export interface CapturedPageItem {
  id: string;
  pageNumber: number;
  dataUrl: string;
  sourceUrl: string;
  width: number;
  height: number;
  capturedAt: string;
  captureMethod: CaptureMethod;
  signature: string;
  selected: boolean;
}

export interface CropRectPayload {
  x: number;
  y: number;
  width: number;
  height: number;
  devicePixelRatio: number;
  sourceUrl: string;
  naturalWidth?: number;
  naturalHeight?: number;
  captureMethod: CaptureMethod;
}

export interface ProtectionCheckResult {
  blocked: boolean;
  reason?: string;
  kind?: 'cloudflare_waf' | 'captcha' | 'login_gate';
}

export interface UploadProgressState {
  status: 'idle' | 'uploading' | 'completing' | 'done' | 'error';
  sent: number;
  total: number;
  message: string;
  chapterId?: string;
}
