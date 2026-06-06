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
  onNavigationStateChanged: (callback: (state: NavigationState) => void) => void;
  onLoadingStarted: (callback: () => void) => void;
  onLoadingStopped: (callback: () => void) => void;
  onLoadingProgress: (callback: (progress: number) => void) => void;
  onToggleUrlBar: (callback: () => void) => void;
  onSetUrlBarVisible: (callback: (visible: boolean) => void) => void;
  onDesignModeChanged: (callback: (active: boolean) => void) => void;
  onInputFocusChanged: (callback: (focused: boolean) => void) => void;
  onSetKeyHelpVisible: (callback: (data: { visible: boolean; bindings?: Array<{ action: string; keys: string[] }> }) => void) => void;
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
  const [lastCommittedUrl, setLastCommittedUrl] = createSignal('');
  const [omniboxVisible, setOmniboxVisible] = createSignal(false);
  const [history, setHistory] = createSignal<HistoryItem[]>([]);
  const [selectedIndex, setSelectedIndex] = createSignal(0);
  const [navigationState, setNavigationState] = createSignal<NavigationState>({
    canGoBack: false,
    canGoForward: false,
  });

  let inputRef: HTMLInputElement | undefined;
  let suggestionsContainerRef: HTMLDivElement | undefined;

  // IPC Listeners
  window.ipc.onUrlChanged((newUrl: string) => {
    setLastCommittedUrl(newUrl);
    if (!omniboxVisible()) {
      setUrl(newUrl);
    }
  });

  window.ipc.onNavigationStateChanged((state) => setNavigationState(state));
  window.ipc.onLoadingProgress((p) => setLoadingProgress(p));
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
