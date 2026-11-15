import type { ShortcutBinding } from '../../shortcutReference';
import type { PermissionChoice } from './siteInfo';

export interface NavigationState {
  canGoBack: boolean;
  canGoForward: boolean;
}

export type SitePermissionValue = boolean | string;
export interface SiteInfo {
  cookies: number;
  certificate: { issuer: string; expires: number } | null;
}

export interface OpenTab {
  id?: number;
  thumbnail?: string;
  title: string;
  url: string;
  current: boolean;
}

export interface BrowserToolbar {
  navigateBack: () => void;
  navigateForward: () => void;
  refresh: () => void;
  navigateTo: (url: string) => void;
  findInPage: (text: string, options?: any) => void;
  stopFindInPage: () => void;
  onToggleFind: (callback: () => void) => void;
  onFindResult: (
    callback: (result: { activeMatchOrdinal: number; matches: number }) => void,
  ) => void;
  onFindNext: (callback: () => void) => void;
  onFindPrev: (callback: () => void) => void;
  onUrlChanged: (callback: (url: string) => void) => void;
  onUpdateTargetUrl: (callback: (url: string) => void) => void;
  onNavigationStateChanged: (callback: (state: NavigationState) => void) => void;
  onZoomChanged: (callback: (factor: number) => void) => void;
  onLoadingStarted: (callback: () => void) => void;
  onLoadingStopped: (callback: () => void) => void;
  onLoadingProgress: (callback: (progress: number) => void) => void;
  onLoadingUrl: (callback: (url: string) => void) => void;
  onSetUrlBarVisible: (callback: (visible: boolean) => void) => void;
  setSiteInfoOpen: (open: boolean) => void;
  onCloseSiteInfo: (callback: () => void) => void;
  onDesignModeChanged: (callback: (active: boolean) => void) => void;
  onDesignFrozenFrame: (
    callback: (frame: {
      png: Uint8Array;
      width: number;
      height: number;
      captureId: string;
      captureSha256: string;
      source?: any;
      draft?: import('../../design/types').DesignDraft | null;
      sentRevisions?: Record<string, string[]>;
      restored?: boolean;
    }) => void,
  ) => () => void;
  enterDesignMode: () => void;
  exitDesignMode: () => void;
  designFrameReady: (captureId: string) => void;
  listReviewRecipients: () => Promise<{ id: string; label: string; preferred: boolean }[]>;
  selectReviewRecipient: (id: string) => Promise<boolean>;
  inspectElementAtPoint: (
    x: number,
    y: number,
    up?: number,
  ) => Promise<{
    elementId: string;
    tag: string;
    selector: string;
    textSnippet?: string;
    role?: string;
    bounds: { x: number; y: number; width: number; height: number };
  } | null>;
  saveDesignDraft: (draft: any) => Promise<{ ok: boolean; id?: string; error?: string }>;
  sendDesignFeedback: (draft: any) => Promise<{ ok: boolean; id?: string; error?: string; noConnectedAgent?: boolean }>;
  onInputFocusChanged: (callback: (focused: boolean) => void) => void;
  onSetKeyHelpVisible: (
    callback: (data: {
      visible: boolean;
      bindings?: ShortcutBinding[];
    }) => void,
  ) => void;
  onPermissionRequest: (
    callback: (req: { id: number; permission: string; url: string; mediaTypes?: string[] }) => void,
  ) => void;
  resolvePermission: (
    id: number,
    allowed: boolean,
    url: string,
    permission: string,
    mediaTypes?: string[],
  ) => void;
  getSitePermissions: (url: string) => Promise<Record<string, SitePermissionValue>>;
  setSitePermission: (url: string, permission: string, choice: PermissionChoice) => void;
  getSiteInfo: (url: string) => Promise<SiteInfo | null>;
  clearSiteCookies: (url: string) => Promise<number>;
  onSitePermissionsChanged: (
    callback: (perms: Record<string, SitePermissionValue>) => void,
  ) => void;
  onScrollSuggestions: (callback: (deltaY: number) => void) => void;
  toggleUrlBar: () => void;
  toggleKeyHelp: () => void;
  selectTab: (index: number) => void;
  closeTabAt: (index: number) => void;
  onSetTabs: (callback: (tabs: OpenTab[]) => void) => void;
  toggleFind: () => void;
  openInNewWindow: (url: string) => void;
  setZoom: (factor: number) => void;
}

declare global {
  interface Window {
    ipc: BrowserToolbar;
  }
}
