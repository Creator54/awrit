import { type ComponentProps, createSignal, Show, onMount, onCleanup } from 'solid-js';

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

export function Toolbar() {
  const [isLoading, setIsLoading] = createSignal(false);
  const [url, setUrl] = createSignal('');
  const [omniboxVisible, setOmniboxVisible] = createSignal(false);
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
      setTimeout(() => {
        inputRef?.focus();
        inputRef?.select();
      }, 50);
    }
  });

  const handleUrlSubmit = (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      let targetUrl = (e.currentTarget as HTMLInputElement).value.trim();
      if (!targetUrl) return;

      // Simple URL vs Search detection
      const isUrl = /^https?:\/\//i.test(targetUrl) || 
                  (targetUrl.includes('.') && !targetUrl.includes(' ')) || 
                  targetUrl.startsWith('localhost:');

      if (!isUrl) {
        targetUrl = 'https://www.google.com/search?q=' + encodeURIComponent(targetUrl);
      } else if (!/^https?:\/\//i.test(targetUrl)) {
        targetUrl = 'https://' + targetUrl;
      }

      window.ipc.navigateTo(targetUrl);
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

  const handleRefresh = () => {
    window.ipc.refresh();
    window.ipc.toggleUrlBar();
  };

  onMount(() => {
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
        class="h-screen w-screen flex items-start justify-center pt-[15vh] bg-black/80 backdrop-blur-md transition-all duration-300 animate-in fade-in"
        onClick={handleBackdropClick}
      >
        <div 
          class="w-[750px] max-w-[90vw] bg-kitty-bg border-2 border-kitty-fg/20 rounded-[2rem] shadow-[0_30px_60px_-12px_rgba(0,0,0,0.8)] overflow-hidden scale-in transition-transform duration-200"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header / Input Area */}
          <div class="flex items-center gap-5 p-6 bg-kitty-fg/5">
            <div class="text-4xl text-kitty-fg/40 animate-pulse">
               {isLoading() ? '⚡' : '🔍'}
            </div>
            <input
              ref={inputRef}
              type="text"
              placeholder="Search or enter URL..."
              value={url()}
              spellcheck="false"
              onKeyDown={handleUrlSubmit}
              class="w-full text-3xl font-light bg-transparent border-none outline-none text-kitty-fg placeholder:text-kitty-fg/20 selection:bg-selection-background selection:text-selection-foreground"
            />
          </div>
          
          {/* Main Content / Suggestions */}
          <div class="border-t border-kitty-fg/10 p-4 max-h-[450px] overflow-y-auto custom-scrollbar">
             <div class="text-[10px] font-black text-kitty-fg/30 px-4 py-3 uppercase tracking-[0.2em]">Suggestions</div>
             
             <div class="flex flex-col gap-2">
                <SuggestionItem 
                  icon="🏠" 
                  title="Homepage" 
                  subtitle="Go back to your start page" 
                  onClick={() => {
                    window.ipc.navigateTo('https://github.com/chase/awrit');
                    window.ipc.toggleUrlBar();
                  }} 
                />
                
                <Show when={url()}>
                  <SuggestionItem 
                    icon="🌐" 
                    title={`Go to ${url()}`} 
                    subtitle="Navigate to this address"
                    onClick={() => {
                      handleUrlSubmit({ key: 'Enter', currentTarget: { value: url() } } as any);
                    }}
                  />
                  <SuggestionItem 
                    icon="🔎" 
                    title={`Search for "${url()}"`} 
                    subtitle="Search on Google"
                    onClick={() => {
                      window.ipc.navigateTo(`https://www.google.com/search?q=${encodeURIComponent(url())}`);
                      window.ipc.toggleUrlBar();
                    }}
                  />
                </Show>
             </div>
          </div>
          
          {/* Footer / Shortcut Help */}
          <div class="bg-kitty-fg/5 px-6 py-3 flex justify-between items-center border-t border-kitty-fg/10">
             <div class="flex gap-6 text-[10px] font-bold text-kitty-fg/20 uppercase tracking-widest">
                <div class="flex items-center gap-1.5">
                   <kbd class="bg-kitty-fg/10 px-1.5 py-0.5 rounded border border-kitty-fg/20">⏎</kbd>
                   <span>Navigate</span>
                </div>
                <div class="flex items-center gap-1.5">
                   <kbd class="bg-kitty-fg/10 px-1.5 py-0.5 rounded border border-kitty-fg/20">ESC</kbd>
                   <span>Close</span>
                </div>
             </div>
             
             <div class="flex items-center gap-3 opacity-30 grayscale hover:grayscale-0 hover:opacity-100 transition-all cursor-default">
                <span class="text-[10px] font-black uppercase tracking-widest text-kitty-fg">awrit omnibox</span>
             </div>
          </div>
        </div>
      </div>
    </Show>
  );
}

function SuggestionItem(props: { icon: string; title: string; subtitle: string; onClick: () => void }) {
  return (
    <div 
      class="flex items-center gap-4 px-4 py-4 rounded-2xl hover:bg-kitty-fg/10 cursor-pointer group transition-all duration-200 active:scale-[0.98]"
      onClick={props.onClick}
    >
       <div class="text-2xl w-12 h-12 flex items-center justify-center bg-kitty-fg/5 rounded-xl group-hover:bg-kitty-fg/10 transition-colors">
          <span class="group-hover:scale-110 transition-transform">{props.icon}</span>
       </div>
       <div class="flex flex-col">
          <span class="text-base font-semibold text-kitty-fg group-hover:text-kitty-fg/90 transition-colors">{props.title}</span>
          <span class="text-xs text-kitty-fg/40 group-hover:text-kitty-fg/60 transition-colors">{props.subtitle}</span>
       </div>
       <div class="ml-auto opacity-0 group-hover:opacity-100 transition-opacity text-kitty-fg/30 text-xs font-bold uppercase tracking-widest">
          Select
       </div>
    </div>
  );
}
