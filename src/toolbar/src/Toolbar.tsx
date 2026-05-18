import { createSignal, Show, onMount, onCleanup, For } from 'solid-js';
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
  onUrlChanged: (callback: (url: string) => void) => void;
  onNavigationStateChanged: (callback: (state: NavigationState) => void) => void;
  onLoadingStarted: (callback: () => void) => void;
  onLoadingStopped: (callback: () => void) => void;
  onLoadingProgress: (callback: (progress: number) => void) => void;
  onToggleUrlBar: (callback: () => void) => void;
  onSetUrlBarVisible: (callback: (visible: boolean) => void) => void;
  onDesignModeChanged: (callback: (active: boolean) => void) => void;
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
  const [_isLoading, setIsLoading] = createSignal(false);
  const [loadingProgress, setLoadingProgress] = createSignal(0);
  const [url, setUrl] = createSignal('');
  const [omniboxVisible, setOmniboxVisible] = createSignal(false);
  const [findVisible, setFindVisible] = createSignal(false);
  const [findText, setFindText] = createSignal('');
  const [activeMatch, setActiveMatch] = createSignal(0);
  const [totalMatches, setTotalMatches] = createSignal(0);
  const [keyHelp, setKeyHelp] = createSignal<{ visible: boolean; bindings: Array<{ action: string; keys: string[] }> }>({ 
    visible: false, 
    bindings: [] 
  });
  const [history, setHistory] = createSignal<HistoryItem[]>([]);
  const [selectedIndex, setSelectedIndex] = createSignal(0);
  const [navigationState, setNavigationState] = createSignal<NavigationState>({
    canGoBack: false,
    canGoForward: false,
  });

  let inputRef: HTMLInputElement | undefined;
  let findInputRef: HTMLInputElement | undefined;

  window.ipc.onUrlChanged((newUrl: string) => {
    setUrl(newUrl);
  });

  window.ipc.onNavigationStateChanged((state: NavigationState) => {
    setNavigationState(state);
  });

  window.ipc.onLoadingStarted(() => {
    setIsLoading(true);
    setLoadingProgress(5);
  });

  window.ipc.onLoadingStopped(() => {
    setIsLoading(false);
    setLoadingProgress(0);
  });

  window.ipc.onLoadingProgress((progress: number) => {
    setLoadingProgress(progress);
  });

  window.ipc.onSetUrlBarVisible((visible: boolean) => {
    console.log('[Toolbar] Visibility received:', visible);
    setOmniboxVisible(visible);
    if (visible) {
      setFindVisible(false);
      setSelectedIndex(0);
      setTimeout(() => {
        inputRef?.focus();
        inputRef?.select();
      }, 50);
    }
  });

  window.ipc.onToggleFind(() => {
    const visible = !findVisible();
    setFindVisible(visible);
    if (visible) {
      setOmniboxVisible(false);
      setTimeout(() => {
        findInputRef?.focus();
        findInputRef?.select();
      }, 50);
    } else {
      setActiveMatch(0);
      setTotalMatches(0);
      window.ipc.stopFindInPage();
    }
  });

  window.ipc.onFindResult((result) => {
    setActiveMatch(result.activeMatchOrdinal);
    setTotalMatches(result.matches);
  });

  window.ipc.onSetKeyHelpVisible((data) => {
    setKeyHelp({ 
      visible: data.visible, 
      bindings: data.bindings || [] 
    });
  });

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
    if (!currentInput) return history().map(h => ({ ...h, type: 'history' }));

    const filteredHistory = history().filter(h => 
      h.title.toLowerCase().includes(currentInput.toLowerCase()) ||
      h.url.toLowerCase().includes(currentInput.toLowerCase())
    );

    const isUrl = currentInput.includes('.') && !currentInput.includes(' ');
    
    const action: Suggestion = isUrl 
      ? { title: `Go to ${currentInput}`, url: currentInput, isSearch: false, type: 'action' }
      : { title: `Search Google for "${currentInput}"`, url: `https://www.google.com/search?q=${encodeURIComponent(currentInput)}`, isSearch: true, type: 'action' };

    return [action, ...filteredHistory.map(h => ({ ...h, type: 'history' }))];
  };

  const handleInput = (e: InputEvent) => {
    setUrl((e.target as HTMLInputElement).value);
    setSelectedIndex(0);
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

  const handleBack = () => {
    window.ipc.navigateBack();
    window.ipc.toggleUrlBar();
  };

  const handleForward = () => {
    window.ipc.navigateForward();
    window.ipc.toggleUrlBar();
  };

  const _handleRefresh = () => {
    window.ipc.refresh();
    window.ipc.toggleUrlBar();
  };

  const debouncedFindInPage = debounce((text: string) => {
    window.ipc.findInPage(text);
  }, 200);

  const handleFindInput = (e: InputEvent) => {
    const text = (e.target as HTMLInputElement).value;
    setFindText(text);
    if (text) {
      debouncedFindInPage(text);
    } else {
      debouncedFindInPage.cancel();
      setActiveMatch(0);
      setTotalMatches(0);
      window.ipc.stopFindInPage();
    }
  };

  const handleFindKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      if (findText()) {
        window.ipc.findInPage(findText(), { findNext: true, forward: !e.shiftKey });
      }
    } else if (e.key === 'Escape') {
      setFindVisible(false);
      window.ipc.stopFindInPage();
    }
  };

  onMount(() => {
    try {
      const stored = localStorage.getItem('awrit:history');
      if (stored) setHistory(JSON.parse(stored));
    } catch (_e) {}

    const handleGlobalKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && (omniboxVisible() || keyHelp().visible || findVisible())) {
        if (omniboxVisible()) window.ipc.toggleUrlBar();
        if (keyHelp().visible) window.ipc.toggleKeyHelp();
        if (findVisible()) {
          setFindVisible(false);
          window.ipc.stopFindInPage();
        }
      }
    };
    window.addEventListener('keydown', handleGlobalKey);
    onCleanup(() => window.removeEventListener('keydown', handleGlobalKey));
  });

  return (
    <>
      {/* Loading Progress Bar */}
      <Show when={loadingProgress() > 0}>
        <div 
          class="fixed top-0 left-0 h-[2px] bg-blue-500 z-50 transition-all duration-300 ease-out"
          style={{ width: `${loadingProgress()}%` }}
        />
      </Show>

      {/* Find in Page Bar */}
      <Show when={findVisible()}>
        <div 
          class="fixed top-4 right-4 z-50 animate-in slide-in-from-top-4 duration-200"
          onClick={(e) => e.stopPropagation()}
        >
          <div class="bg-[#1C1B22] border border-white/10 rounded-xl shadow-2xl flex items-center p-2 gap-2 font-sans min-w-[300px]">
            <div class="flex-1 relative flex items-center">
              <input
                ref={findInputRef}
                type="text"
                value={findText()}
                onInput={handleFindInput}
                onKeyDown={handleFindKeyDown}
                placeholder="Find in page..."
                class="w-full bg-white/5 border border-white/5 focus:border-blue-500/50 outline-none rounded-lg px-3 py-1.5 text-white placeholder-white/20 transition-all text-[14px]"
              />
              <Show when={totalMatches() > 0}>
                <span class="absolute right-3 text-[12px] text-white/30 font-mono pointer-events-none">
                  {activeMatch()} / {totalMatches()}
                </span>
              </Show>
            </div>
            <div class="flex items-center gap-1 pr-1">
              <button 
                onClick={() => window.ipc.findInPage(findText(), { findNext: true, forward: false })}
                class="p-1.5 hover:bg-white/5 rounded-lg text-white/50 hover:text-white/90 transition-colors"
                title="Previous (Shift+Enter)"
              >
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 15l7-7 7 7" /></svg>
              </button>
              <button 
                onClick={() => window.ipc.findInPage(findText(), { findNext: true, forward: true })}
                class="p-1.5 hover:bg-white/5 rounded-lg text-white/50 hover:text-white/90 transition-colors"
                title="Next (Enter)"
              >
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" /></svg>
              </button>
              <div class="w-px h-4 bg-white/10 mx-1" />
              <button 
                onClick={() => window.ipc.toggleFind()}
                class="p-1.5 hover:bg-white/5 rounded-lg text-white/50 hover:text-white/90 transition-colors"
              >
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            </div>
          </div>
        </div>
      </Show>

      <Show when={omniboxVisible()}>
        <div 
          class="h-screen w-screen flex flex-col items-center pt-[15vh] bg-black/40 backdrop-blur-sm animate-in fade-in duration-200"
          onClick={() => window.ipc.toggleUrlBar()}
        >
          <div 
            class="w-[600px] max-w-[90vw] bg-[#1C1B22] border border-white/10 rounded-xl shadow-2xl overflow-hidden font-sans"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Input Area */}
            <div class="p-4 flex items-center gap-3 border-b border-white/5">
              <div class="flex gap-1">
                 <button 
                  onClick={handleBack}
                  disabled={!navigationState().canGoBack}
                  class="p-2 hover:bg-white/5 rounded-lg disabled:opacity-20 text-white/70 transition-colors"
                >
                  <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" /></svg>
                </button>
                <button 
                  onClick={handleForward}
                  disabled={!navigationState().canGoForward}
                  class="p-2 hover:bg-white/5 rounded-lg disabled:opacity-20 text-white/70 transition-colors"
                >
                  <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" /></svg>
                </button>
              </div>

              <div class="flex-1 relative">
                <input
                  ref={inputRef}
                  type="text"
                  value={url()}
                  onInput={handleInput}
                  onKeyDown={handleKeyDown}
                  placeholder="Search or enter URL"
                  class="w-full bg-white/5 border border-white/5 focus:border-blue-500/50 outline-none rounded-lg px-4 py-2 text-white placeholder-white/20 transition-all text-[15px]"
                />
              </div>
            </div>

            {/* Suggestions List */}
            <div class="max-h-[400px] overflow-y-auto py-2 custom-scrollbar">
              <For each={getSuggestions()}>
                {(item, index) => (
                  <SuggestionItem
                    title={item.title}
                    url={item.url}
                    selected={index() === selectedIndex()}
                    onClick={() => {
                      window.ipc.navigateTo(item.url);
                      addToHistory(item.isSearch ? item.title.replace('Search Google for "', '').replace('"', '') : item.title, item.url, item.isSearch);
                      window.ipc.toggleUrlBar();
                    }}
                    icon={item.isSearch ? 'search' : 'history'}
                  />
                )}
              </For>
            </div>
          </div>
        </div>
      </Show>

      {/* Keybindings Help Overlay */}
      <Show when={keyHelp().visible}>
        <div 
          class="h-screen w-screen flex items-center justify-center bg-black/60 backdrop-blur-md animate-in fade-in duration-200"
          onClick={() => window.ipc.toggleKeyHelp()}
        >
          <div 
            class="w-[500px] max-w-[90vw] bg-[#1C1B22] border border-white/10 rounded-xl shadow-2xl overflow-hidden font-sans p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <div class="flex items-center justify-between mb-6">
              <h2 class="text-white/90 text-lg font-semibold">Keybindings</h2>
              <span class="text-white/30 text-xs px-2 py-1 bg-white/5 rounded">Alt+H to toggle</span>
            </div>
            
            <div class="grid grid-cols-1 gap-y-3 max-h-[60vh] overflow-y-auto pr-2 custom-scrollbar">
              <For each={keyHelp().bindings}>
                {(binding) => (
                  <div class="flex items-center justify-between group py-1">
                    <span class="text-white/80 text-sm font-medium group-hover:text-white transition-colors">
                      {binding.action.replace(/([A-Z])/g, ' $1').replace(/^./, str => str.toUpperCase())}
                    </span>
                    <div class="flex flex-wrap gap-2 justify-end">
                      <For each={binding.keys}>
                        {(key) => (
                          <kbd class="px-2 py-1 bg-white/10 border border-white/10 rounded text-white/60 text-xs font-mono min-w-[2.5rem] text-center">
                            {key}
                          </kbd>
                        )}
                      </For>
                    </div>
                  </div>
                )}
              </For>
            </div>

            <div class="mt-8 pt-4 border-t border-white/5 flex justify-center">
              <button 
                onClick={() => window.ipc.toggleKeyHelp()}
                class="px-4 py-2 bg-white/5 hover:bg-white/10 text-white/50 hover:text-white/90 text-sm rounded-lg transition-all"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      </Show>
    </>
  );
}

function SuggestionItem(props: { icon?: any; title: string; url: string; selected?: boolean; onClick: () => void }) {
  return (
    <div
      onClick={props.onClick}
      class={`px-4 py-3 cursor-pointer flex items-center gap-3 transition-colors ${
        props.selected ? 'bg-white/10' : 'hover:bg-white/5'
      }`}
    >
      <div class="text-white/30">
        <Show when={props.icon === 'search'} fallback={
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-12 0 9 9 0 0112 0z" /></svg>
        }>
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
        </Show>
      </div>
      <div class="flex flex-col flex-1 min-w-0">
        <span class="text-white/90 text-[14px] truncate">{props.title}</span>
        <span class="text-white/30 text-[12px] truncate">{props.url}</span>
      </div>
    </div>
  );
}

export function BrowserToolbarItem(props: { icon: string; label: string; active?: boolean; onClick: () => void }) {
  return (
    <button 
      onClick={props.onClick}
      class={`flex flex-col items-center gap-1 p-2 rounded-lg transition-all ${
        props.active ? 'bg-white/10 text-white' : 'text-white/40 hover:bg-white/5 hover:text-white/70'
      }`}
    >
      <span class="text-[11px] font-medium tracking-wide uppercase">{props.label}</span>
    </button>
  );
}

export function NavigationTab(props: { title: string; url: string; active?: boolean }) {
  return (
    <div class={`flex items-center gap-2 px-3 py-2 rounded-lg border transition-all ${
      props.active 
        ? 'bg-white/10 border-white/10 text-white' 
        : 'border-transparent text-white/40 hover:text-white/60'
    }`}>
       <div class="flex flex-col min-w-0 max-w-[120px] gap-2 truncate text-[13px]">
          <span class="text-white/90">{props.title}</span>
          <span class="text-white/40">—</span>
          <span class="text-white/50 truncate">{props.url}</span>
       </div>
    </div>
  );
}
