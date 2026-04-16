import { type ComponentProps, createSignal, Show, splitProps } from 'solid-js';

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
}

declare global {
  interface Window {
    ipc: BrowserToolbar;
  }
}

function Button(props: ComponentProps<'button'>) {
  const [local, others] = splitProps(props, ['class']);
  return (
    <button
      {...others}
      class={`size-6 focus:outline-1 focus:outline-kitty-fg/50 text-lg rounded leading-none hover:bg-kitty-fg/10 disabled:text-kitty-fg/50 disabled:hover:bg-transparent text-kitty-fg ${local.class}`}
    />
  );
}

function Checkbox(props: ComponentProps<'button'> & { checked: boolean }) {
  const [local, others] = splitProps(props, ['class', 'checked']);
  return (
    <button
      {...others}
      class={`size-6 focus:outline-1 focus:outline-kitty-fg/50 text-lg rounded leading-none hover:bg-kitty-fg/10 text-kitty-fg ${local.class}`}
    >
      {local.checked ? '☒' : '☐'}
    </button>
  );
}

export function Toolbar() {
  const [isLoading, setIsLoading] = createSignal(false);
  const [url, setUrl] = createSignal('');
  const [isFindMode, setIsFindMode] = createSignal(false);
  const [urlBarVisible, setUrlBarVisible] = createSignal(true);
  const [navigationState, setNavigationState] = createSignal<NavigationState>({
    canGoBack: false,
    canGoForward: false,
  });
  const [matchCase, setMatchCase] = createSignal(false);

  let inputRef: HTMLInputElement | undefined;
  let findInputRef: HTMLInputElement | undefined;

  window.ipc.onLoadingStarted(() => setIsLoading(true));
  window.ipc.onLoadingStopped(() => setIsLoading(false));
  window.ipc.onUrlChanged((newUrl: string) => setUrl(newUrl));
  window.ipc.onNavigationStateChanged((state: NavigationState) => setNavigationState(state));
  window.ipc.onToggleFind(() => {
    if (!isFindMode()) {
      setIsFindMode(true);
      // Focus the find input on next tick
      setTimeout(() => findInputRef?.focus(), 0);
    } else {
      setIsFindMode(false);
      window.ipc.stopFindInPage();
    }
  });
  window.ipc.onToggleUrlBar(() => {
    setUrlBarVisible((prev) => !prev);
  });
  window.ipc.onSetUrlBarVisible((visible: boolean) => {
    setUrlBarVisible(visible);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      setIsFindMode(false);
      window.ipc.stopFindInPage();
    }
  });

  const handleUrlSubmit = (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      let targetUrl = (e.currentTarget as HTMLInputElement).value.trim();

      // Add https:// if no protocol is specified
      if (!/^https?:\/\//i.test(targetUrl)) {
        targetUrl = 'https://' + targetUrl;
      }

      window.ipc.navigateTo(targetUrl);
    }
  };

  const handleInputClick = (e: MouseEvent) => {
    const input = e.currentTarget as HTMLInputElement;
    if (document.activeElement !== input || input.selectionStart === input.selectionEnd) {
      input.select();
    }
  };

  const handleFind = () => {
    if (!findInputRef) return;
    const text = findInputRef.value;
    window.ipc.findInPage(text, { forward: true, matchCase: matchCase() });
  };

  const handleFindSubmit = (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      const text = (e.currentTarget as HTMLInputElement).value;
      window.ipc.findInPage(text, { forward: !e.shiftKey, matchCase: matchCase() });
    } else if (e.key === 'Escape') {
      setIsFindMode(false);
      window.ipc.stopFindInPage();
    }
  };

  const handleFindNav = (forward: boolean) => {
    if (!findInputRef) return;
    const text = findInputRef.value;
    window.ipc.findInPage(text, { forward, matchCase: matchCase() });
  };

  return (
    <div class={`h-screen flex items-center border-active-border text-kitty-fg ${urlBarVisible() ? 'bg-kitty-bg border-b-2 border-kitty-fg/20' : 'bg-transparent'}`}>
      <Show when={urlBarVisible()}>
      <div class="flex items-center w-full h-full px-1 box-border">
        <Show when={isFindMode()}>
          <div class="flex gap-1 mx-1">
            <Button title="Previous" onClick={() => handleFindNav(false)} class="text-xl pb-[1px]">
              ⯅
            </Button>
            <Button title="Next" onClick={() => handleFindNav(true)} class="text-xl pt-[1px]">
              ⯆
            </Button>
          </div>
          <input
            ref={findInputRef}
            type="text"
            spellcheck="false"
            placeholder="Find in page..."
            onKeyDown={handleFindSubmit}
            onInput={handleFind}
            class="grow h-6 ml-2 px-1 text-sm border rounded-xs border-kitty-fg/50 focus:border-kitty-fg selection:bg-selection-background selection:text-selection-foreground focus:outline-none bg-kitty-fg/10"
          />
          <label class="flex items-center text-sm ml-2">
            <Checkbox
              checked={matchCase()}
              onClick={() => setMatchCase((prev) => !prev)}
              title="Match case"
            />
            <span class="ml-1 pb-0.25">Match case</span>
          </label>
        </Show>
        <Show when={!isFindMode()}>
            <div class="flex gap-1 mx-1">
              <Button
                title="Back"
                disabled={!navigationState().canGoBack}
                onClick={() => window.ipc.navigateBack()}
                class="text-xl pb-[1px]"
              >
                ←
              </Button>
              <Button
                title="Forward"
                disabled={!navigationState().canGoForward}
                onClick={() => window.ipc.navigateForward()}
                class="text-xl pb-[1px]"
              >
                →
              </Button>
              <Button title={isLoading() ? 'Stop' : 'Refresh'} onClick={() => window.ipc.refresh()}>
                {isLoading() ? '✕' : '↻'}
              </Button>
            </div>
            <input
              ref={inputRef}
              type="text"
              placeholder="Enter URL"
              value={url()}
              spellcheck="false"
              onClick={handleInputClick}
              onKeyDown={handleUrlSubmit}
              class={`flex-1 h-6 px-1 text-sm border rounded-xs border-kitty-fg/50 focus:border-kitty-fg selection:bg-selection-background selection:text-selection-foreground focus:outline-none ${
                isLoading() ? 'bg-kitty-fg/10 border-kitty-fg/50 text-kitty-fg/50' : 'bg-kitty-fg/10'
              }`}
            />
        </Show>
      </div>
      </Show>
    </div>
  );
}
