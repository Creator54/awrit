import { createSignal, Show, onMount, onCleanup, For, createEffect } from 'solid-js';
import { debounce } from '../../debounce';

export interface NavigationState {
  canGoBack: boolean;
  canGoForward: boolean;
}

export interface BrowserToolbar {
  navigateBack: () => void;
  navigateForward: () => void;
  refresh: () => void;
  navigateTo: (url: string) => void;
  findInPage: (text: string, options?: any) => void;
  stopFindInPage: () => void;
  onToggleFind: (callback: () => void) => void;
  onFindResult: (callback: (result: { activeMatchOrdinal: number; matches: number }) => void) => void;
  onFindNext: (callback: () => void) => void;
  onFindPrev: (callback: () => void) => void;
  onUrlChanged: (callback: (url: string) => void) => void;
  onUpdateTargetUrl: (callback: (url: string) => void) => void;
  onNavigationStateChanged: (callback: (state: NavigationState) => void) => void;
  onLoadingStarted: (callback: () => void) => void;
  onLoadingStopped: (callback: () => void) => void;
  onLoadingProgress: (callback: (progress: number) => void) => void;
  onLoadingUrl: (callback: (url: string) => void) => void;
  onToggleUrlBar: (callback: () => void) => void;
  onSetUrlBarVisible: (callback: (visible: boolean) => void) => void;
  onDesignModeChanged: (callback: (active: boolean) => void) => void;
  onInputFocusChanged: (callback: (focused: boolean) => void) => void;
  onSetKeyHelpVisible: (callback: (data: { visible: boolean; bindings?: Array<{ action: string; keys: string[] }> }) => void) => void;
  onPermissionRequest: (callback: (req: { id: number; permission: string; url: string; mediaTypes?: string[] }) => void) => void;
  resolvePermission: (id: number, allowed: boolean, url: string, permission: string, mediaTypes?: string[]) => void;
  getSitePermissions: (url: string) => Promise<Record<string, boolean>>;
  revokeSitePermission: (url: string, permission: string) => void;
  onSitePermissionsChanged: (callback: (perms: Record<string, boolean>) => void) => void;
  toggleUrlBar: () => void;
  toggleKeyHelp: () => void;
  toggleFind: () => void;
}

declare global {
  interface Window {
    ipc: BrowserToolbar;
  }
}

interface HistoryItem {
  title: string;
  url: string;
  isSearch: boolean;
}

interface Suggestion extends HistoryItem {
  type: 'history' | 'action';
}

export function Toolbar() {
  const [loadingProgress, setLoadingProgress] = createSignal(0);
  const [url, setUrl] = createSignal('');
  const [hoveredUrl, setHoveredUrl] = createSignal('');
  const [loadingUrl, setLoadingUrl] = createSignal('');
  const [lastCommittedUrl, setLastCommittedUrl] = createSignal('');
  const [omniboxVisible, setOmniboxVisible] = createSignal(false);
  const [history, setHistory] = createSignal<HistoryItem[]>([]);
  const [selectedIndex, setSelectedIndex] = createSignal(0);
  const [navigationState, setNavigationState] = createSignal<NavigationState>({
    canGoBack: false,
    canGoForward: false,
  });
  const [permissionReq, setPermissionReq] = createSignal<{id: number, permission: string, url: string, mediaTypes?: string[]} | null>(null);
  const [sitePerms, setSitePerms] = createSignal<Record<string, boolean>>({});

  let inputRef: HTMLInputElement | undefined;
  let suggestionsContainerRef: HTMLDivElement | undefined;

  // IPC Listeners
  window.ipc.onUrlChanged((newUrl: string) => {
    setLastCommittedUrl(newUrl);
    if (!omniboxVisible()) {
      setUrl(newUrl);
    }
  });

  window.ipc.onUpdateTargetUrl((hoverUrl: string) => {
    setHoveredUrl(hoverUrl);
  });

  window.ipc.onNavigationStateChanged((state) => setNavigationState(state));
  window.ipc.onLoadingProgress((p) => setLoadingProgress(p));
  window.ipc.onLoadingUrl((lUrl) => setLoadingUrl(lUrl));
  window.ipc.onLoadingStopped(() => setLoadingProgress(0));

  window.ipc.onSetUrlBarVisible((visible: boolean) => {
    setOmniboxVisible(visible);
    if (visible) {
      // Restore URL to the current page when opening
      setUrl(lastCommittedUrl());
      setSelectedIndex(0);
      setTimeout(() => {
        inputRef?.focus();
        inputRef?.select();
      }, 50);
    }
  });

  window.ipc.onPermissionRequest((req) => {
    setPermissionReq(req);
  });

  window.ipc.onSitePermissionsChanged((perms) => {
    setSitePerms(perms || {});
  });

  createEffect(() => {
    if (lastCommittedUrl()) {
      window.ipc.getSitePermissions(lastCommittedUrl()).then((perms) => setSitePerms(perms || {}));
    }
  });

  const getUrlOrSearch = (input: string): { url: string; title: string; isSearch: boolean } => {
    const trimmed = input.trim();
    if (!trimmed) return { url: '', title: '', isSearch: false };
    if (/^[a-z]+:\/\//i.test(trimmed)) return { url: trimmed, title: `Go to ${trimmed}`, isSearch: false };
    const hasDot = trimmed.includes('.');
    if (hasDot && !trimmed.includes(' ')) {
      const url = `https://${trimmed}`;
      return { url, title: `Go to ${url}`, isSearch: false };
    }
    return {
      url: `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`,
      title: `Search Google for "${trimmed}"`,
      isSearch: true,
    };
  };

  const addToHistory = (title: string, url: string, isSearch: boolean) => {
    setHistory(prev => {
      const filtered = prev.filter(item => item.url !== url);
      const newHistory = [{ title, url, isSearch }, ...filtered].slice(0, 50);
      localStorage.setItem('awrit:history', JSON.stringify(newHistory));
      return newHistory;
    });
  };

  const getSuggestions = (): Suggestion[] => {
    const currentInput = url().trim();
    const committed = lastCommittedUrl().trim();
    
    // If input is empty or exactly matches current page URL (initial state), show full history
    if (!currentInput || currentInput === committed) {
      return history().map(h => ({ ...h, type: 'history' as const }));
    }

    const action = getUrlOrSearch(currentInput);
    const filteredHistory = history().filter(h => 
      h.title.toLowerCase().includes(currentInput.toLowerCase()) ||
      h.url.toLowerCase().includes(currentInput.toLowerCase())
    );

    const suggestions: Suggestion[] = [{ ...action, type: 'action' }];
    for (const h of filteredHistory) {
      if (h.url !== action.url) suggestions.push({ ...h, type: 'history' });
    }
    return suggestions;
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    const suggestions = getSuggestions();
    if (e.key === 'Enter') {
      const selected = suggestions[selectedIndex()];
      if (selected) {
        window.ipc.navigateTo(selected.url);
        addToHistory(selected.isSearch ? selected.title.replace('Search Google for "', '').replace('"', '') : selected.title, selected.url, selected.isSearch);
        window.ipc.toggleUrlBar();
      }
    } else if (e.key === 'ArrowDown') {
      setSelectedIndex(prev => Math.min(prev + 1, suggestions.length - 1));
      e.preventDefault();
    } else if (e.key === 'ArrowUp') {
      setSelectedIndex(prev => Math.max(prev - 1, 0));
      e.preventDefault();
    } else if (e.key === 'Escape') {
      window.ipc.toggleUrlBar();
    }
  };

  // Keyboard Scroll Fix
  createEffect(() => {
    const index = selectedIndex();
    if (suggestionsContainerRef) {
      const selectedElement = suggestionsContainerRef.children[index] as HTMLElement;
      if (selectedElement) {
        selectedElement.scrollIntoView({ block: 'nearest' });
      }
    }
  });

  // Global Escape handler for permission popup
  createEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      const req = permissionReq();
      if (req && e.key === 'Escape') {
        window.ipc.resolvePermission(req.id, false, req.url, req.permission, req.mediaTypes);
        setPermissionReq(null);
      }
    };
    window.addEventListener('keydown', handleGlobalKeyDown);
    onCleanup(() => window.removeEventListener('keydown', handleGlobalKeyDown));
  });

  onMount(() => {
    const stored = localStorage.getItem('awrit:history');
    if (stored) setHistory(JSON.parse(stored));
  });

  return (
    <>
      {/* Loading Progress Bar - Always at the top */}
      <Show when={loadingProgress() > 0}>
        <div 
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            height: '2px',
            background: '#0060df',
            width: `${loadingProgress()}%`,
            transition: 'width 300ms ease-out',
            'z-index': 2000,
          }}
        />
      </Show>

      <Show when={omniboxVisible()}>
        <div class="zen-fixed-wrapper animate-fade-in">
          {/* Transparent layer to catch clicks outside the palette */}
          <div class="zen-backdrop" onMouseDown={() => window.ipc.toggleUrlBar()} />
          
          <div 
            class="floating-palette" 
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
          >
            {/* Input Row */}
            <div class="input-container">
              <div class="opacity-30 flex items-center">
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
              </div>

              <Show when={typeof sitePerms()?.media === 'string' ? (sitePerms()?.media as string).includes('video') : sitePerms()?.media === true}>
                <div 
                   class="flex items-center text-red-400 cursor-pointer px-1 hover:bg-[#2b2a33] rounded"
                   onClick={(e) => { e.stopPropagation(); window.ipc.revokeSitePermission(lastCommittedUrl(), 'media'); }}
                   title="Click to revoke Camera access"
                >
                   <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" /><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
                </div>
              </Show>
              <Show when={typeof sitePerms()?.media === 'string' ? (sitePerms()?.media as string).includes('audio') : sitePerms()?.media === true}>
                <div 
                   class="flex items-center text-red-400 cursor-pointer px-1 hover:bg-[#2b2a33] rounded"
                   onClick={(e) => { e.stopPropagation(); window.ipc.revokeSitePermission(lastCommittedUrl(), 'media'); }}
                   title="Click to revoke Microphone access"
                >
                   <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" /></svg>
                </div>
              </Show>
              <Show when={sitePerms()?.media === false}>
                <div 
                   class="flex items-center text-gray-400 cursor-pointer px-1 hover:bg-[#2b2a33] rounded"
                   onClick={(e) => { e.stopPropagation(); window.ipc.revokeSitePermission(lastCommittedUrl(), 'media'); }}
                   title="Camera/Microphone blocked. Click to reset."
                >
                   <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" /></svg>
                </div>
              </Show>
              <Show when={sitePerms()?.geolocation === true}>
                <div 
                   class="flex items-center text-blue-400 cursor-pointer px-1 hover:bg-[#2b2a33] rounded"
                   onClick={(e) => { e.stopPropagation(); window.ipc.revokeSitePermission(lastCommittedUrl(), 'geolocation'); }}
                   title="Click to revoke Location access"
                >
                   <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.242-4.243a8 8 0 1111.314 0z" /><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
                </div>
              </Show>
              <Show when={sitePerms()?.geolocation === false}>
                <div 
                   class="flex items-center text-gray-400 cursor-pointer px-1 hover:bg-[#2b2a33] rounded"
                   onClick={(e) => { e.stopPropagation(); window.ipc.revokeSitePermission(lastCommittedUrl(), 'geolocation'); }}
                   title="Location blocked. Click to reset."
                >
                   <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" /></svg>
                </div>
              </Show>
              <Show when={sitePerms()?.notifications === true}>
                <div 
                   class="flex items-center text-yellow-500 cursor-pointer px-1 hover:bg-[#2b2a33] rounded"
                   onClick={(e) => { e.stopPropagation(); window.ipc.revokeSitePermission(lastCommittedUrl(), 'notifications'); }}
                   title="Click to revoke Notifications access"
                >
                   <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" /></svg>
                </div>
              </Show>
              <Show when={sitePerms()?.notifications === false}>
                <div 
                   class="flex items-center text-gray-400 cursor-pointer px-1 hover:bg-[#2b2a33] rounded"
                   onClick={(e) => { e.stopPropagation(); window.ipc.revokeSitePermission(lastCommittedUrl(), 'notifications'); }}
                   title="Notifications blocked. Click to reset."
                >
                   <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" /></svg>
                </div>
              </Show>

              <input
                ref={inputRef}
                type="text"
                class="palette-input"
                value={url()}
                onInput={(e) => { setUrl(e.currentTarget.value); setSelectedIndex(0); }}
                onKeyDown={handleKeyDown}
                placeholder="Search or enter address"
                spellcheck={false}
                autocomplete="off"
                autocorrect="off"
                autocapitalize="off"
              />

              {/* Navigation Buttons */}
              <div class="flex items-center gap-1 opacity-20 pr-1">
                <button 
                  onClick={() => window.ipc.navigateBack()} 
                  disabled={!navigationState().canGoBack}
                  class="p-1 hover:bg-[#2b2a33] rounded-md disabled:hover:bg-transparent"
                >
                  <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M15 19l-7-7 7-7" /></svg>
                </button>
                <button 
                  onClick={() => window.ipc.navigateForward()} 
                  disabled={!navigationState().canGoForward}
                  class="p-1 hover:bg-[#2b2a33] rounded-md disabled:hover:bg-transparent"
                >
                  <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M9 5l7 7-7 7" /></svg>
                </button>
              </div>
            </div>

            {/* Solid Divider (Zen style) */}
            <div class="h-[1px] bg-[#333333] w-full" />

            {/* Suggestions Dropdown */}
            <div 
              ref={suggestionsContainerRef} 
              class="suggestions-container"
              onWheel={(e) => e.stopPropagation()} // Direct wheel capture
            >
              <For each={getSuggestions()}>
                {(item, index) => (
                  <div 
                    class="suggestion-item" 
                    classList={{ selected: index() === selectedIndex() }}
                    onClick={() => {
                      window.ipc.navigateTo(item.url);
                      addToHistory(item.isSearch ? item.title.replace('Search Google for "', '').replace('"', '') : item.title, item.url, item.isSearch);
                      window.ipc.toggleUrlBar();
                    }}
                  >
                    <div class="opacity-30 flex-shrink-0">
                      {item.isSearch ? (
                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
                      ) : (
                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M12 8v4l3 3m6-3a9 9 0 11-12 0 9 9 0 0112 0z" /></svg>
                      )}
                    </div>
                    <div class="flex items-center gap-2 overflow-hidden flex-1">
                      <span class="text-[13.5px] truncate text-[#fbfbfe] font-medium">{item.title}</span>
                      <Show when={!item.isSearch}>
                        <span class="text-[12px] opacity-20 truncate font-mono">{getDomain(item.url)}</span>
                      </Show>
                    </div>
                  </div>
                )}
              </For>
            </div>
          </div>
        </div>
      </Show>

    {/* Hover Link Indicator */}
      <Show when={loadingUrl() || hoveredUrl()}>
        <div class="hover-link-indicator animate-fade-in">
          {loadingUrl() || hoveredUrl()}
        </div>
      </Show>

      {/* Permission Prompt */}
      <Show when={permissionReq()}>
        {(req) => (
          <div class="zen-fixed-wrapper animate-fade-in" style={{ "z-index": 3000, "pointer-events": "auto" }}>
            <div class="zen-backdrop" onMouseDown={() => { window.ipc.resolvePermission(req().id, false, req().url, req().permission, req().mediaTypes); setPermissionReq(null); }} />
            <div class="permission-palette" onMouseDown={(e) => e.stopPropagation()}>
              
              {/* Header Row */}
              <div class="input-container" style={{ "justify-content": "space-between" }}>
                <div class="flex items-center gap-3">
                  <div class="opacity-30 flex items-center">
                    {/* Lock Icon */}
                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8V7a4 4 0 00-8 0v4h8z" />
                    </svg>
                  </div>
                  <span class="text-[14px] text-[#fbfbfe] font-medium truncate" style={{ "max-width": "280px" }}>
                    {getDomain(req().url)}
                  </span>
                </div>
                
                <button
                  class="p-1 opacity-30 hover:opacity-100 hover:bg-[#2b2a33] rounded-md transition-colors"
                  onClick={() => { window.ipc.resolvePermission(req().id, false, req().url, req().permission, req().mediaTypes); setPermissionReq(null); }}
                  title="Dismiss (Deny)"
                >
                  <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M6 18L18 6M6 6l12 12" /></svg>
                </button>
              </div>

              {/* Solid Divider */}
              <div class="h-[1px] bg-[#333333] w-full" />

              {/* Content Area */}
              <div class="p-5 flex flex-col gap-5">
                <div class="text-[13.5px] text-[#8f8f9d] text-center leading-relaxed">
                  wants to use your <span class="text-[#fbfbfe] font-medium">
                    {req().permission === 'media' ? (
                      req().mediaTypes?.includes('video') && req().mediaTypes?.includes('audio') ? 'Camera and Microphone' :
                      req().mediaTypes?.includes('video') ? 'Camera' :
                      req().mediaTypes?.includes('audio') ? 'Microphone' : 'Camera/Microphone'
                    ) : req().permission === 'geolocation' ? 'Location' : 
                        req().permission === 'notifications' ? 'Notifications' : 
                        req().permission}
                  </span>.
                </div>

                {/* Actions */}
                <div class="flex gap-2 justify-center">
                  <button 
                    class="px-5 py-2 text-[13px] font-medium bg-[#0060df] text-white rounded-md hover:bg-[#003eaa] transition-colors focus:outline-none focus:ring-2 focus:ring-[#0060df] focus:ring-offset-2 focus:ring-offset-[#1c1b22]"
                    onClick={() => { window.ipc.resolvePermission(req().id, true, req().url, req().permission, req().mediaTypes); setPermissionReq(null); }}
                  >
                    Allow
                  </button>
                  <button 
                    class="px-5 py-2 text-[13px] font-medium bg-[#2b2a33] text-[#fbfbfe] border border-[#333333] rounded-md hover:bg-[#3e3d46] transition-colors focus:outline-none"
                    onClick={() => { window.ipc.resolvePermission(req().id, false, req().url, req().permission, req().mediaTypes); setPermissionReq(null); }}
                  >
                    Deny
                  </button>
                </div>
              </div>

            </div>
          </div>
        )}
      </Show>
    </>
  );
}

function getDomain(urlStr: string): string {
  try {
    return new URL(urlStr).hostname;
  } catch {
    return urlStr;
  }
}
