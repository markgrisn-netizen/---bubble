export interface DiscoveredRemoteImage {
  index: number;
  url: string;
  alt: string;
  selected: boolean;
  referer?: string;
}

export type DiagnosticStageName =
  | 'url_validation'
  | 'adapter_selection'
  | 'redirect_and_cookies'
  | 'source_fetch'
  | 'js_render'
  | 'image_extraction'
  | 'cdn_probe';

export type DiagnosticStatus = 'ok' | 'warn' | 'failed' | 'skipped';

export type FailureCategory =
  | 'INVALID_URL'
  | 'SSRF_BLOCKED'
  | 'WAF_OR_CAPTCHA'
  | 'AUTH_REQUIRED'
  | 'HOTLINK_REFERER_BLOCK'
  | 'RATE_LIMITED'
  | 'IP_OR_GEO_BLOCK'
  | 'JS_RENDER_REQUIRED'
  | 'NO_IMAGES_FOUND'
  | 'EXTERNAL_LICENSED_HOST'
  | 'NETWORK_OR_TIMEOUT'
  | 'HTTP_ERROR';

export interface ImportStageTrace {
  stage: DiagnosticStageName;
  status: DiagnosticStatus;
  httpStatus?: number;
  latencyMs?: number;
  detail: string;
}

export interface RedirectHop {
  url: string;
  status: number;
  location?: string;
}

export interface UrlInspectionResult {
  adapterId: string;
  adapterName: string;
  sourceMethod: 'official_api' | 'html_parser' | 'embedded_json' | 'js_rendered_dom';
  pageTitle: string;
  sourceUrl: string;
  finalUrl: string;
  requiredReferer: string;
  redirectChain: RedirectHop[];
  cookiesCaptured: number;
  images: DiscoveredRemoteImage[];
  diagnostics: ImportStageTrace[];
  warnings: string[];
}

export class ImporterDiagnosticError extends Error {
  public readonly category: FailureCategory;
  public readonly stage: DiagnosticStageName;
  public readonly httpStatus?: number;
  public readonly diagnostics: ImportStageTrace[];
  public readonly redirectChain: RedirectHop[];

  constructor(opts: {
    message: string;
    category: FailureCategory;
    stage: DiagnosticStageName;
    httpStatus?: number;
    diagnostics: ImportStageTrace[];
    redirectChain?: RedirectHop[];
  }) {
    super(opts.message);
    this.name = 'ImporterDiagnosticError';
    this.category = opts.category;
    this.stage = opts.stage;
    this.httpStatus = opts.httpStatus;
    this.diagnostics = opts.diagnostics;
    this.redirectChain = opts.redirectChain || [];
  }
}
