import { type ComponentProps, createSignal, Show, onMount, onCleanup, For } from 'solid-js';

export interface NavigationState {
  canGoBack: boolean;
  canGoForward: boolean;
}

export interface BrowserToolbar {
  navigateBack: () => void;
  navigateForward: () => void;
  refresh: () => void;
  navigateTo: (url: string) => void;
  onLoadingStarted: (callback: () => void) => void;
  onLoadingStopped: (callback: () => void) => void;
  onUrlChanged: (callback: (url: string) => void) => void;
  onNavigationStateChanged: (callback: (state: NavigationState) => void) => void;
  findInPage: (text: string, options: { forward: boolean; matchCase: boolean }) => void;
  stopFindInPage: () => void;
  onToggleFind: (callback: () => void) => void;
  onToggleUrlBar: (callback: () => void) => void;
  onSetUrlBarVisible: (callback: (visible: boolean) => void) => void;
  toggleUrlBar: () => void;
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
  const [isLoading, setIsLoading] = createSignal(false);
  const [url, setUrl] = createSignal('');
  const [omniboxVisible, setOmniboxVisible] = createSignal(false);
  const [history, setHistory] = createSignal<HistoryItem[]>([]);
  const [selectedIndex, setSelectedIndex] = createSignal(0);
  const [navigationState, setNavigationState] = createSignal<NavigationState>({
    canGoBack: false,
    canGoForward: false,
  });

  let inputRef: HTMLInputElement | undefined;

  window.ipc.onLoadingStarted(() => setIsLoading(true));
  window.ipc.onLoadingStopped(() => setIsLoading(false));
  window.ipc.onUrlChanged((newUrl: string) => setUrl(newUrl));
  window.ipc.onNavigationStateChanged((state: NavigationState) => setNavigationState(state));
  
  window.ipc.onSetUrlBarVisible((visible: boolean) => {
    console.log('[Toolbar] Visibility received:', visible);
    setOmniboxVisible(visible);
    if (visible) {
      setSelectedIndex(0);
      setTimeout(() => {
        inputRef?.focus();
        inputRef?.select();
      }, 50);
    }
  });

  const addToHistory = (title: string, url: string, isSearch: boolean) => {
    setHistory(prev => {
      const filtered = prev.filter(item => item.url !== url);
      const newHistory = [{ title, url, isSearch }, ...filtered].slice(0, 50);
      localStorage.setItem('awrit:history', JSON.stringify(newHistory));
      return newHistory;
    });
  };

  const isLikelyUrl = (text: string) => {
    return /^https?:\/\//i.test(text) || 
           (text.includes('.') && !text.includes(' ')) || 
           text.startsWith('localhost:');
  };

  const filteredHistory = () => {
    const query = url().toLowerCase().trim();
    if (!query) return history().slice(0, 10);
    return history().filter(item => 
      item.title.toLowerCase().includes(query) || 
      item.url.toLowerCase().includes(query)
    ).slice(0, 10);
  };

  const allSuggestions = () => {
    const query = url().trim();
    const suggestions: Suggestion[] = [];
    
    if (query) {
      const isUrl = isLikelyUrl(query);
      if (isUrl) {
        suggestions.push({ 
          title: query, 
          url: 'Go to website', 
          isSearch: false,
          type: 'action'
        });
        suggestions.push({ 
          title: query, 
          url: 'Search with Google', 
          isSearch: true,
          type: 'action'
        });
      } else {
        suggestions.push({ 
          title: query, 
          url: 'Search with Google', 
          isSearch: true,
          type: 'action'
        });
        suggestions.push({ 
          title: query, 
          url: 'Go to website', 
          isSearch: false,
          type: 'action'
        });
      }
    }

    const filtered = filteredHistory();
    const seenUrls = new Set(suggestions.map(s => s.title.toLowerCase()));
    
    for (const item of filtered) {
       const urlPath = item.url.replace(/^https?:\/\//, '').toLowerCase();
       if (!seenUrls.has(item.title.toLowerCase()) && !seenUrls.has(urlPath)) {
         suggestions.push({ ...item, type: 'history' });
         seenUrls.add(item.title.toLowerCase());
       }
    }

    return suggestions.slice(0, 10);
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    const suggestions = allSuggestions();
    
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((prev) => (prev + 1) % Math.max(1, suggestions.length));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((prev) => (prev - 1 + suggestions.length) % Math.max(1, suggestions.length));
    } else if (e.key === 'Enter') {
      const selected = suggestions[selectedIndex()];
      if (selected) {
        executeSuggestion(selected);
      } else if (url().trim()) {
        // Fallback for when no selection is made but Enter is pressed
        const query = url().trim();
        const isUrl = isLikelyUrl(query);
        const finalUrl = isUrl 
          ? (query.startsWith('http') ? query : `https://${query}`)
          : `https://www.google.com/search?q=${encodeURIComponent(query)}`;
        
        addToHistory(query, finalUrl, !isUrl);
        window.ipc.navigateTo(finalUrl);
        window.ipc.toggleUrlBar();
      }
    }
  };

  const executeSuggestion = (selected: Suggestion) => {
    if (selected.type === 'action') {
       if (selected.isSearch) {
          const finalUrl = `https://www.google.com/search?q=${encodeURIComponent(selected.title)}`;
          addToHistory(selected.title, finalUrl, true);
          window.ipc.navigateTo(finalUrl);
       } else {
          const finalUrl = selected.title.startsWith('http') ? selected.title : `https://${selected.title}`;
          addToHistory(selected.title, finalUrl, false);
          window.ipc.navigateTo(finalUrl);
       }
    } else {
      window.ipc.navigateTo(selected.url);
    }
    window.ipc.toggleUrlBar();
  };

  const handleBack = () => {
    window.ipc.navigateBack();
    window.ipc.toggleUrlBar();
  };

  const handleForward = () => {
    window.ipc.navigateForward();
    window.ipc.toggleUrlBar();
  };

  const handleRefresh = () => {
    window.ipc.refresh();
    window.ipc.toggleUrlBar();
  };

  onMount(() => {
    try {
      const stored = localStorage.getItem('awrit:history');
      if (stored) setHistory(JSON.parse(stored));
    } catch (e) {}

    const handleGlobalKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && omniboxVisible()) {
        window.ipc.toggleUrlBar();
      }
    };
    window.addEventListener('keydown', handleGlobalKey);
    onCleanup(() => window.removeEventListener('keydown', handleGlobalKey));
  });

  // Close when clicking backdrop
  const handleBackdropClick = (e: MouseEvent) => {
    if (e.target === e.currentTarget) {
      window.ipc.toggleUrlBar();
    }
  };

  return (
    <Show when={omniboxVisible()}>
      <div 
        class="h-screen w-screen flex items-center justify-center pb-[20vh] bg-black/40 backdrop-blur-sm transition-all duration-200 animate-in fade-in"
        onClick={handleBackdropClick}
      >
        <div 
          class="w-[640px] max-w-[90vw] bg-[#1C1B22] border border-white/10 rounded-xl shadow-2xl overflow-hidden font-sans"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header / Input Area */}
          <div class="flex items-center gap-3 px-4 py-3 border-b border-white/5">
            <input
              ref={inputRef}
              type="text"
              placeholder="Search or enter URL..."
              value={url()}
              spellcheck="false"
              onInput={(e) => {
                setUrl(e.currentTarget.value);
                setSelectedIndex(0);
              }}
              onKeyDown={handleKeyDown}
              class="flex-1 bg-transparent border-none outline-none text-white/90 placeholder:text-white/30 text-[15px]"
            />
            
            {/* Navigation Controls */}
            <div class="flex items-center gap-0.5 ml-2 border-l border-white/10 pl-2">
              <button 
                onClick={handleBack} 
                disabled={!navigationState().canGoBack} 
                title="Back"
                class="p-1.5 hover:bg-white/5 rounded-md text-white/40 hover:text-white transition-all disabled:opacity-20 disabled:cursor-default disabled:hover:bg-transparent disabled:hover:text-white/40"
              >
                <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
              </button>
              <button 
                onClick={handleForward} 
                disabled={!navigationState().canGoForward} 
                title="Forward"
                class="p-1.5 hover:bg-white/5 rounded-md text-white/40 hover:text-white transition-all disabled:opacity-20 disabled:cursor-default disabled:hover:bg-transparent disabled:hover:text-white/40"
              >
                <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
              </button>
            </div>
          </div>
          
          {/* Main Content / Suggestions */}
          <div class="max-h-[400px] overflow-y-auto py-2 custom-scrollbar">
             <div class="flex flex-col">
                <For each={allSuggestions()}>
                  {(item, index) => (
                    <SuggestionItem 
                      icon={
                        item.isSearch 
                          ? <svg class="w-3.5 h-3.5 text-white/50" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>
                          : <svg class="w-3.5 h-3.5 text-white/50" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="2" y1="12" x2="22" y2="12"></line><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path></svg>
                      }
                      title={item.title} 
                      url={item.type === 'action' ? item.url : item.url.replace(/^https?:\/\//, '')} 
                      selected={selectedIndex() === index()}
                      onClick={() => executeSuggestion(item)} 
                    />
                  )}
                </For>
             </div>
          </div>
        </div>
      </div>
    </Show>
  );
}

function SuggestionItem(props: { icon?: any; title: string; url: string; selected?: boolean; onClick: () => void }) {
  return (
    <div 
      class={`flex items-center gap-3 px-4 py-[6px] cursor-pointer transition-colors ${props.selected ? 'bg-white/10' : 'hover:bg-white/5'}`}
      onClick={props.onClick}
    >
       <div class="w-4 h-4 flex items-center justify-center flex-shrink-0">
          {props.icon || (
            <svg class="w-3.5 h-3.5 text-white/50" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path></svg>
          )}
       </div>
       <div class="flex items-center gap-2 truncate text-[13px]">
          <span class="text-white/90">{props.title}</span>
          <span class="text-white/40">—</span>
          <span class="text-white/50 truncate">{props.url}</span>
       </div>
    </div>
  );
}
