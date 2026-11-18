import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import { debounce } from '../../debounce';
import { LOOPBACK_ADDRESS } from '../../loopback';
import { groupShortcuts, type ShortcutBinding } from '../../shortcutReference';
import { DesignModeOverlay } from './DesignModeOverlay';
import type { ReviewContext } from './DesignModeOverlay';
import { Icon } from './Icon';
import type { OpenTab, SiteInfo, SitePermissionValue } from './ipc';

import { connectionOf, PERMISSION_LABELS, permissionChoice } from './siteInfo';

interface HistoryItem {
  title: string;
  url: string;
  isSearch: boolean;
}

interface Suggestion extends HistoryItem {
  type: 'history' | 'action' | 'tab';
  /** Position in the pane's tab list; set for `tab` suggestions. */
  tabIndex?: number;
}

export function Toolbar() {
  const [loadingProgress, setLoadingProgress] = createSignal(0);
  const [url, setUrl] = createSignal('');
  const [hoveredUrl, setHoveredUrl] = createSignal('');
  const [keyHelp, setKeyHelp] = createSignal<{
    visible: boolean;
    bindings: ShortcutBinding[];
  }>({
    visible: false,
    bindings: [],
  });
  const [shortcutQuery, setShortcutQuery] = createSignal('');
  const shortcutGroups = createMemo(() => groupShortcuts(keyHelp().bindings, shortcutQuery()));
  let shortcutSearch: HTMLInputElement | undefined;
  let helpReturnFocus: HTMLElement | null = null;
  window.ipc.onSetKeyHelpVisible((data) => {
    if (data.visible) {
      helpReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setShortcutQuery('');
    }
    setKeyHelp({ visible: data.visible, bindings: data.bindings ?? [] });
    queueMicrotask(() => {
      if (data.visible) shortcutSearch?.focus();
      else if (helpReturnFocus?.isConnected) helpReturnFocus.focus();
    });
  });
  const [loadingUrl, setLoadingUrl] = createSignal('');
  const [lastCommittedUrl, setLastCommittedUrl] = createSignal('');
  const [omniboxVisible, setOmniboxVisible] = createSignal(false);
  const [openTabs, setOpenTabs] = createSignal<OpenTab[]>([]);
  window.ipc.onSetTabs((tabs) => setOpenTabs(tabs));
  const [history, setHistory] = createSignal<HistoryItem[]>([]);
  const [selectedIndex, setSelectedIndex] = createSignal(-1);
  const [permissionReq, setPermissionReq] = createSignal<{
    id: number;
    permission: string;
    url: string;
    mediaTypes?: string[];
  } | null>(null);
  const [siteInfoOpen, setSiteInfoOpen] = createSignal(false);
  const [siteInfo, setSiteInfo] = createSignal<SiteInfo | null>(null);
  const [cookieError, setCookieError] = createSignal('');
  const [sitePerms, setSitePerms] = createSignal<Record<string, SitePermissionValue>>({});

  const [findVisible, setFindVisible] = createSignal(false);
  const [findText, setFindText] = createSignal('');
  const [activeMatch, setActiveMatch] = createSignal(0);
  // null until the page answers the current search.
  const [totalMatches, setTotalMatches] = createSignal<number | null>(null);
  const [zoom, setZoom] = createSignal(1);
  const [designModeActive, setDesignModeActive] = createSignal(false);
  const [reviewContext, setReviewContext] = createSignal<ReviewContext | null>(null);

  let inputRef: HTMLInputElement | undefined;
  let findInputRef: HTMLInputElement | undefined;
  let suggestionsContainerRef: HTMLDivElement | undefined;
  let siteInfoPanelRef: HTMLDivElement | undefined;
  let leavingReview = false;

  // IPC Listeners
  window.ipc.onUrlChanged((newUrl: string) => {
    setLastCommittedUrl(newUrl);
    // Reset the zoom indicator; the main process re-applies the per-origin
    // saved zoom on navigation and sends content:zoom-changed back.
    setZoom(1);
    if (!omniboxVisible()) {
      setUrl(newUrl);
    }
  });

  window.ipc.onUpdateTargetUrl((hoverUrl: string) => {
    setHoveredUrl(hoverUrl);
  });

  window.ipc.onDesignModeChanged((active: boolean) => {
    setDesignModeActive(active);
  });
  window.ipc.onZoomChanged((factor: number) => setZoom(factor));
  window.ipc.onLoadingProgress((p) => setLoadingProgress(p));
  window.ipc.onLoadingUrl((lUrl) => setLoadingUrl(lUrl));
  window.ipc.onLoadingStopped(() => setLoadingProgress(0));

  createEffect(() => window.ipc.setSiteInfoOpen(siteInfoOpen()));
  window.ipc.onCloseSiteInfo(() => { setSiteInfoOpen(false); if (omniboxVisible()) inputRef?.focus(); });
  let urlFocusTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(urlFocusTimer));
  window.ipc.onSetUrlBarVisible((visible: boolean) => {
    clearTimeout(urlFocusTimer);
    setOmniboxVisible(visible);
    setSiteInfoOpen(false);
    if (visible) {
      // Restore URL to the current page when opening
      setUrl(lastCommittedUrl());
      setSelectedIndex(-1);
      urlFocusTimer = setTimeout(() => {
        if (!omniboxVisible()) return;
        inputRef?.focus();
        inputRef?.select();
      }, 50);
    }
  });
  createEffect(() => {
    if (!omniboxVisible()) clearTimeout(urlFocusTimer);
  });

  window.ipc.onPermissionRequest((req) => {
    setPermissionReq(req);
  });

  window.ipc.onSitePermissionsChanged((perms) => {
    setSitePerms(perms || {});
  });

  // Scroll the suggestion dropdown in response to a terminal mouse-wheel
  // event forwarded from the main process (offscreen webviews don't reliably
  // scroll from synthetic mouseWheel sendInputEvent).
  window.ipc.onScrollSuggestions((deltaY: number) => {
    const el = siteInfoOpen() ? siteInfoPanelRef : suggestionsContainerRef;
    if (el) {
      // Pure scroll only — do NOT move the keyboard selection or call
      // scrollIntoView, otherwise the list snaps back to keep the selected
      // row in view and you can never reach the top/bottom of a long list.
      el.scrollTop += deltaY;
    }
  });

  let findFocusTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(findFocusTimer));
  window.ipc.onToggleFind((visible?: boolean) => {
    clearTimeout(findFocusTimer);
    const isVisible = visible !== undefined ? visible : !findVisible();
    setFindVisible(isVisible);
    if (!isVisible) debouncedFindInPage.cancel();
    setActiveMatch(0);
    setTotalMatches(null);
    if (isVisible) {
      setOmniboxVisible(false);
      findFocusTimer = setTimeout(() => {
        if (!findVisible()) return;
        findInputRef?.focus();
        findInputRef?.select();
      }, 50);
    }
  });

  window.ipc.onFindResult((result) => {
    setActiveMatch(result.activeMatchOrdinal);
    setTotalMatches(result.matches);
  });

  createEffect(() => {
    let current = true;
    onCleanup(() => { current = false; });
    setSitePerms({});
    if (lastCommittedUrl()) {
      window.ipc.getSitePermissions(lastCommittedUrl()).then((perms) => {
        if (current) setSitePerms(perms || {});
      });
    }
  });

  createEffect(() => {
    let current = true;
    onCleanup(() => { current = false; });
    setSiteInfo(null);
    setCookieError('');
    if (siteInfoOpen() && lastCommittedUrl()) {
      window.ipc.getSiteInfo(lastCommittedUrl()).then((info) => {
        if (current) setSiteInfo(info);
      });
    }
  });

  const toggleSiteInfo = () => {
    const open = !siteInfoOpen();
    setSiteInfoOpen(open);
    if (!open) inputRef?.focus();
  };

  const performSearch = (text: string, options?: any) => {
    if (!text) return;
    window.ipc.findInPage(text, options);
  };

  const debouncedFindInPage = debounce(250, (text: string) => {
    if (findVisible()) performSearch(text);
  });
  onCleanup(() => debouncedFindInPage.cancel());

  const handleFindInput = (e: InputEvent) => {
    const val = (e.currentTarget as HTMLInputElement).value;
    setFindText(val);
    if (val) {
      debouncedFindInPage(val);
    } else {
      debouncedFindInPage.cancel();
      setActiveMatch(0);
      setTotalMatches(null);
      window.ipc.stopFindInPage();
    }
  };

  const navigateFind = (forward: boolean) => {
    debouncedFindInPage.cancel();
    if (findText()) performSearch(findText(), { findNext: true, forward });
  };

  const handleFindKeyDown = (e: KeyboardEvent) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter') {
      navigateFind(!e.shiftKey);
      e.stopPropagation();
    } else if (e.key === 'Escape') {
      window.ipc.toggleFind();
      window.ipc.stopFindInPage();
      e.stopPropagation();
    }
  };

  const getUrlOrSearch = (input: string): { url: string; title: string; isSearch: boolean } => {
    const trimmed = input.trim();
    if (!trimmed) return { url: '', title: '', isSearch: false };
    if (/^[a-z]+:\/\//i.test(trimmed))
      return { url: trimmed, title: `Go to ${trimmed}`, isSearch: false };
    if (LOOPBACK_ADDRESS.test(trimmed) && !/\s/.test(trimmed)) {
      try {
        new URL(`http://${trimmed}`);
        return { url: `http://${trimmed}`, title: `Go to http://${trimmed}`, isSearch: false };
      } catch {
        // Invalid ports are search text, not navigable development addresses.
      }
    }
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

  const persistHistory = (items: HistoryItem[]) => {
    try {
      localStorage.setItem('awrit:history', JSON.stringify(items));
    } catch (error) {
      console.warn('Could not save URL history', error);
    }
  };

  const addToHistory = (title: string, url: string, isSearch: boolean) => {
    setHistory((prev) => {
      const filtered = prev.filter((item) => item.url !== url);
      const newHistory = [{ title, url, isSearch }, ...filtered].slice(0, 50);
      persistHistory(newHistory);
      return newHistory;
    });
  };

  const removeFromHistory = (url: string) => {
    setHistory((prev) => {
      const newHistory = prev.filter((item) => item.url !== url);
      persistHistory(newHistory);
      return newHistory;
    });
  };

  const getSuggestions = createMemo<Suggestion[]>(() => {
    const currentInput = url().trim();
    const committed = lastCommittedUrl().trim();

    // Other open tabs come first, so going back to one beats opening a duplicate.
    // An empty box or the untouched current address lists them all; typing narrows them.
    const browsing = !currentInput || currentInput === committed;
    const needle = currentInput.toLowerCase();
    const tabSuggestions: Suggestion[] = openTabs().flatMap((tab, tabIndex) =>
      !tab.current &&
      (browsing ||
        tab.title.toLowerCase().includes(needle) ||
        tab.url.toLowerCase().includes(needle))
        ? [
            {
              title: tab.title || tab.url,
              url: tab.url,
              isSearch: false,
              type: 'tab' as const,
              tabIndex,
            },
          ]
        : [],
    );

    // If input is empty, show open tabs then full history
    if (!currentInput) {
      return [
        ...tabSuggestions,
        ...history().map((h) => ({ ...h, type: 'history' as const })),
      ];
    }

    const action =
      currentInput === committed
        ? { url: committed, title: 'Reload this page', isSearch: false }
        : getUrlOrSearch(currentInput);

    const query = currentInput.toLowerCase();
    const filteredHistory =
      currentInput === committed
        ? history()
        : history().filter(
            (h) => h.title.toLowerCase().includes(query) || h.url.toLowerCase().includes(query),
          );

    const suggestions: Suggestion[] = browsing
      ? [{ ...action, type: 'action' }, ...tabSuggestions]
      : [...tabSuggestions, { ...action, type: 'action' }];
    for (const h of filteredHistory) {
      if (h.url !== action.url) suggestions.push({ ...h, type: 'history' });
    }
    return suggestions;
  });

  const openSuggestion = (item: Suggestion) => {
    if (item.type === 'tab' && item.tabIndex !== undefined) {
      window.ipc.selectTab(item.tabIndex);
      return;
    }
    if (item.type === 'action' && item.url === lastCommittedUrl()) {
      window.ipc.refresh();
    } else {
      window.ipc.navigateTo(item.url);
      addToHistory(
        item.isSearch ? item.title.replace('Search Google for "', '').replace('"', '') : item.title,
        item.url,
        item.isSearch,
      );
    }
    window.ipc.toggleUrlBar();
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.isComposing || e.keyCode === 229) return;
    const suggestions = getSuggestions();
    const selected = suggestions[selectedIndex()] ?? (url().trim() ? suggestions[0] : undefined);
    if (e.key === 'Enter') {
      if (e.ctrlKey) {
        // Ctrl+Enter opens in a new browser window without closing the omnibox
        if (selected?.type === 'tab') {
          openSuggestion(selected);
        } else if (selected) {
          if (selected.type !== 'action' || selected.url !== lastCommittedUrl()) {
            addToHistory(
              selected.isSearch
                ? selected.title.replace('Search Google for "', '').replace('"', '')
                : selected.title,
              selected.url,
              selected.isSearch,
            );
          }
          window.ipc.openInNewWindow(selected.url);
        }
        e.preventDefault();
        return;
      }
      if (selected) openSuggestion(selected);
    } else if (e.key === 'ArrowDown') {
      setSelectedIndex((prev) => Math.max(-1, Math.min(prev + 1, suggestions.length - 1)));
      e.preventDefault();
    } else if (e.key === 'ArrowUp') {
      setSelectedIndex((prev) =>
        suggestions.length ? (prev < 0 ? suggestions.length - 1 : Math.max(prev - 1, 0)) : -1,
      );
      e.preventDefault();
    } else if (e.key === 'Escape') {
      if (siteInfoOpen()) toggleSiteInfo();
      else window.ipc.toggleUrlBar();
    } else if (e.key === 'Delete' && e.shiftKey) {
      // Remove the highlighted history entry from the list (Chrome-like).
      if (selected && selected.type === 'history') {
        removeFromHistory(selected.url);
        e.preventDefault();
      } else if (selected?.type === 'tab' && selected.tabIndex !== undefined) {
        window.ipc.closeTabAt(selected.tabIndex);
        e.preventDefault();
      }
    } else if ((e.ctrlKey || e.metaKey) && (e.key === '+' || e.key === '=')) {
      const next = Math.min(3, Math.round((zoom() + 0.1) * 10) / 10);
      setZoom(next);
      window.ipc.setZoom(next);
      e.preventDefault();
    } else if ((e.ctrlKey || e.metaKey) && (e.key === '-' || e.key === '_')) {
      const next = Math.max(0.5, Math.round((zoom() - 0.1) * 10) / 10);
      setZoom(next);
      window.ipc.setZoom(next);
      e.preventDefault();
    } else if ((e.ctrlKey || e.metaKey) && e.key === '0') {
      setZoom(1);
      window.ipc.setZoom(1);
      e.preventDefault();
    }
  };

  createEffect(() => {
    const count = getSuggestions().length;
    const index = selectedIndex();
    const clamped = Math.max(-1, Math.min(index, count - 1));
    if (index !== clamped) setSelectedIndex(() => clamped);
  });

  // Keep keyboard selection visible when the results change.
  createEffect(() => {
    const index = selectedIndex();
    getSuggestions();
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
      if (e.isComposing || e.keyCode === 229) return;
      const req = permissionReq();
      if (req && e.key === 'Escape') {
        window.ipc.resolvePermission(req.id, false, req.url, req.permission, req.mediaTypes);
        setPermissionReq(null);
      } else if (keyHelp().visible && e.key === 'Escape') {
        window.ipc.toggleKeyHelp();
      } else if (findVisible() && e.key === 'Escape') {
        window.ipc.toggleFind();
        window.ipc.stopFindInPage();
      }
    };
    window.addEventListener('keydown', handleGlobalKeyDown);
    onCleanup(() => window.removeEventListener('keydown', handleGlobalKeyDown));
  });

  onMount(() => {
    let parsed: unknown;
    try {
      const stored = localStorage.getItem('awrit:history');
      if (!stored) return;
      parsed = JSON.parse(stored);
    } catch {
      return; // Unavailable or invalid history must not prevent the toolbar from opening.
    }
    if (!Array.isArray(parsed)) return;
    setHistory(parsed.filter((item): item is HistoryItem =>
      item !== null && typeof item === 'object' &&
      typeof item.title === 'string' && typeof item.url === 'string' &&
      typeof item.isSearch === 'boolean',
    ));
  });

  return (
    <>
      <Show when={loadingProgress() !== 0}>
        <div
          class={`loading-bar${loadingProgress() < 0 ? ' indeterminate' : ''}`}
          style={{
            transform: loadingProgress() < 0 ? undefined : `scaleX(${loadingProgress() / 100})`,
          }}
        />
      </Show>

      {/* Find in Page Popup (top-right floating pill aligned with theme) */}
      <Show when={findVisible()}>
        <div class="fixed top-3 right-4 w-max max-w-[calc(100%-32px)] z-[2500] pointer-events-auto">
          <div
            class="flex flex-wrap justify-end items-center gap-2 bg-[#222228] border border-[var(--palette-border)] rounded-xl px-2.5 py-1.5 shadow-xl text-xs text-white"
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div class="flex min-w-0 flex-[1_1_10.375rem] items-center gap-2 sm:basis-[13.375rem]">
              <Icon name="search" class="w-3.5 h-3.5 shrink-0 text-[var(--text-muted)]" />
              <input
                ref={findInputRef}
                type="text"
                class="min-w-0 w-36 grow bg-transparent text-xs text-white placeholder-[#7e7d8d] focus:outline-none sm:w-48"
                value={findText()}
                onInput={handleFindInput}
                onKeyDown={handleFindKeyDown}
                placeholder="Find in page"
                spellcheck={false}
                autocomplete="off"
                autocorrect="off"
                autocapitalize="off"
              />
            </div>

            <div class="flex max-w-full flex-wrap justify-end items-center gap-2">
              <Show when={findText() && totalMatches() !== null}>
                <span class="px-1.5 py-0.5 rounded bg-white/10 text-[11px] font-mono text-[#c8c7d4] leading-none whitespace-nowrap">
                  {totalMatches() ? `${activeMatch()} / ${totalMatches()}` : 'No matches'}
                </span>
              </Show>

              <div class="flex items-center gap-0.5">
                <button
                  type="button"
                  onClick={() => navigateFind(false)}
                  class="p-1 text-[var(--text-muted)] hover:text-white hover:bg-white/10 rounded-lg transition-colors cursor-pointer"
                  title="Previous (Shift+Enter)"
                  aria-label="Previous match"
                >
                  <Icon name="chevron-up" class="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => navigateFind(true)}
                  class="p-1 text-[var(--text-muted)] hover:text-white hover:bg-white/10 rounded-lg transition-colors cursor-pointer"
                  title="Next (Enter)"
                  aria-label="Next match"
                >
                  <Icon name="chevron-down" class="w-3.5 h-3.5" />
                </button>
              </div>

              <div class="w-px h-3.5 bg-white/10 mx-0.5" aria-hidden="true" />

              <button
                type="button"
                onClick={() => {
                  window.ipc.toggleFind();
                  window.ipc.stopFindInPage();
                }}
                class="p-1 text-[var(--text-muted)] hover:text-white hover:bg-white/10 rounded-lg transition-colors cursor-pointer"
                title="Close (Escape)"
                aria-label="Close find"
              >
                <Icon name="clear" class="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        </div>
      </Show>

      <Show when={omniboxVisible()}>
        <div class="zen-fixed-wrapper">
          {/* Transparent layer to catch clicks outside the palette */}
          <div class="zen-backdrop" onMouseDown={() => window.ipc.toggleUrlBar()} />

          <div
            class="floating-palette"
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
          >
            {/* Input Row */}
            <div class="input-container">
              <Show
                when={connectionOf(lastCommittedUrl()) !== 'local'}
                fallback={
                  <div class="suggestion-icon flex items-center">
                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        stroke-width="2.5"
                        d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                      />
                    </svg>
                  </div>
                }
              >
                <button
                  type="button"
                  class="site-info-btn flex items-center"
                  classList={{
                    insecure: connectionOf(lastCommittedUrl()) === 'insecure',
                    open: siteInfoOpen(),
                  }}
                  onClick={toggleSiteInfo}
                  aria-expanded={siteInfoOpen()}
                  aria-controls="awrit-site-info"
                  title={
                    connectionOf(lastCommittedUrl()) === 'secure'
                      ? 'Connection is secure'
                      : 'Connection is not secure'
                  }
                  aria-label={`Site information: ${connectionOf(lastCommittedUrl()) === 'secure' ? 'connection is secure' : 'connection is not secure'}`}
                >
                  <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      stroke-width="2"
                      d={
                        connectionOf(lastCommittedUrl()) === 'secure'
                          ? 'M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z'
                          : 'M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.008v.008H12v-.008z'
                      }
                    />
                  </svg>
                </button>
              </Show>

              <input
                ref={inputRef}
                type="text"
                class="palette-input"
                role="combobox"
                aria-label="Search or enter address"
                aria-autocomplete="list"
                aria-expanded={omniboxVisible()}
                aria-controls="awrit-suggestions"
                aria-activedescendant={
                  selectedIndex() >= 0 && getSuggestions().length
                    ? `awrit-suggestion-${selectedIndex()}`
                    : undefined
                }
                value={url()}
                onInput={(e) => {
                  setUrl(e.currentTarget.value);
                  setSelectedIndex(e.currentTarget.value.trim() ? 0 : -1);
                }}
                onKeyDown={handleKeyDown}
                placeholder="Search or enter address"
                spellcheck={false}
                autocomplete="off"
                autocorrect="off"
                autocapitalize="off"
              />
              <Show when={Math.round(zoom() * 100) !== 100}>
                <button
                  type="button"
                  class="zoom-chip"
                  title="Reset zoom to 100% (Ctrl+0)"
                  aria-label={`Page zoom ${Math.round(zoom() * 100)} percent, reset to 100 percent`}
                  onClick={() => {
                    setZoom(1);
                    window.ipc.setZoom(1);
                    inputRef?.focus();
                  }}
                >
                  {Math.round(zoom() * 100)}%
                </button>
              </Show>
            </div>

            <div class="palette-divider" />

            <Show when={siteInfoOpen()}>
              <div
                ref={siteInfoPanelRef}
                id="awrit-site-info"
                class="site-info-panel"
                role="dialog"
                aria-label="Site information"
              >
                <div class="site-info-host">{new URL(lastCommittedUrl()).host}</div>
                <div
                  class="site-info-row"
                  classList={{ insecure: connectionOf(lastCommittedUrl()) === 'insecure' }}
                >
                  <span>
                    {connectionOf(lastCommittedUrl()) === 'secure'
                      ? 'Connection is secure'
                      : 'Connection is not secure'}
                  </span>
                </div>
                <Show when={siteInfo()?.certificate}>
                  {(cert) => (
                    <div class="site-info-row muted">
                      Issued by {cert().issuer} · expires{' '}
                      {new Date(cert().expires * 1000).toLocaleDateString()}
                    </div>
                  )}
                </Show>
                <div class="site-info-row">
                  <Show when={(siteInfo()?.cookies ?? 0) > 0}>
                    <span>Cookies: {siteInfo()?.cookies}</span>
                    <button
                      type="button"
                      class="site-info-action"
                      onClick={() => {
                        const target = siteInfo();
                        setCookieError('');
                        window.ipc
                          .clearSiteCookies(lastCommittedUrl())
                          .then((cookies) =>
                            setSiteInfo((info) => (info && info === target ? { ...info, cookies } : info)),
                          )
                          .catch(() => {
                            if (siteInfo() === target) setCookieError('Could not clear cookies. Some may already be removed.');
                          });
                      }}
                    >
                      Clear
                    </button>
                  </Show>
                </div>
                <Show when={cookieError()}><div class="site-info-row" role="alert">{cookieError()}</div></Show>
                <For each={Object.entries(PERMISSION_LABELS)}>
                  {([key, label]) => (
                    <div class="site-info-row">
                      <span>{label}</span>
                      <div class="site-info-choice" role="group" aria-label={label}>
                        <For each={['ask', 'allow', 'block'] as const}>
                          {(choice) => (
                            <button
                              type="button"
                              aria-pressed={permissionChoice(sitePerms()[key]) === choice}
                              classList={{ active: permissionChoice(sitePerms()[key]) === choice }}
                              onClick={() =>
                                window.ipc.setSitePermission(lastCommittedUrl(), key, choice)
                              }
                            >
                              {choice === 'ask' ? 'Ask' : choice === 'allow' ? 'Allow' : 'Block'}
                            </button>
                          )}
                        </For>
                      </div>
                    </div>
                  )}
                </For>
              </div>
            </Show>

            {/* Suggestions Dropdown */}
            <div
              ref={suggestionsContainerRef}
              hidden={siteInfoOpen()}
              id="awrit-suggestions"
              role="listbox"
              aria-label="Address suggestions"
              class="suggestions-container"
              onWheel={(e) => {
                e.preventDefault();
                e.stopPropagation();
              }} // Fully contain scrolling inside the dropdown
            >
              <For each={getSuggestions()}>
                {(item, index) => (
                  <div
                    id={`awrit-suggestion-${index()}`}
                    role="option"
                    aria-selected={index() === selectedIndex()}
                    class="suggestion-item"
                    classList={{ selected: index() === selectedIndex() }}
                    onMouseEnter={() => setSelectedIndex(index())}
                    onClick={() => openSuggestion(item)}
                  >
                    <div class="suggestion-icon flex-shrink-0">
                      {item.isSearch ? (
                        <svg
                          class="w-4 h-4"
                          fill="none"
                          stroke="currentColor"
                          stroke-width="1.5"
                          stroke-linecap="round"
                          stroke-linejoin="round"
                          viewBox="0 0 24 24"
                        >
                          <path
                            stroke-linecap="round"
                            stroke-linejoin="round"
                            stroke-width="2.5"
                            d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                          />
                        </svg>
                      ) : (
                        <svg
                          class="w-4 h-4"
                          fill="none"
                          stroke="currentColor"
                          stroke-width="1.5"
                          stroke-linecap="round"
                          stroke-linejoin="round"
                          viewBox="0 0 24 24"
                        >
                          <Show
                            when={item.type === 'action'}
                            fallback={
                              item.type === 'tab' ? (
                                <>
                                  <rect x="3" y="5" width="18" height="14" rx="2" />
                                  <path d="M3 9h18" />
                                </>
                              ) : (
                                <>
                                  <circle cx="12" cy="12" r="9" />
                                  <path d="M12 7v5l3 2" />
                                </>
                              )
                            }
                          >
                            <Show
                              when={item.url === lastCommittedUrl()}
                              fallback={<path d="M7 17 17 7M7 7h10v10" />}
                            >
                              <path d="M20 7v5h-5M19 12a7 7 0 1 0-2 5" />
                            </Show>
                          </Show>
                        </svg>
                      )}
                    </div>
                    <div class="flex items-center gap-2 overflow-hidden flex-1">
                      <span class="suggestion-title truncate">
                        {item.title.startsWith('Go to ') ? item.title.slice(6) : item.title}
                      </span>
                      <Show when={!item.isSearch && !item.title.includes(item.url)}>
                        <span class="suggestion-domain text-[13px] truncate">
                          — {getDomain(item.url)}
                        </span>
                      </Show>
                    </div>
                    <Show when={item.type === 'tab'}>
                      <Show when={index() === selectedIndex()}>
                        <button
                          type="button"
                          title="Close tab (Shift+Delete)"
                          aria-label={`Close tab ${item.title}`}
                          tabindex={-1}
                          class="suggestion-remove-btn"
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={(e) => {
                            e.stopPropagation();
                            if (item.tabIndex !== undefined) window.ipc.closeTabAt(item.tabIndex);
                          }}
                        >
                          <Icon name="clear" class="w-3.5 h-3.5" />
                        </button>
                      </Show>
                    </Show>
                    {/* Remove-from-history control, shown only on the highlighted row */}
                    <Show when={item.type === 'history' && index() === selectedIndex()}>
                      <button
                        type="button"
                        title="Remove from history (Shift+Delete)"
                        aria-label={`Remove ${item.title} from history`}
                        tabindex={-1}
                        class="suggestion-remove-btn"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={(e) => {
                          e.stopPropagation();
                          removeFromHistory(item.url);
                        }}
                      >
                        <svg
                          class="w-3.5 h-3.5"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            stroke-linecap="round"
                            stroke-linejoin="round"
                            stroke-width="2.5"
                            d="M6 18L18 6M6 6l12 12"
                          />
                        </svg>
                      </button>
                    </Show>
                  </div>
                )}
              </For>
            </div>
          </div>
        </div>
      </Show>

      {/* Hover Link Indicator */}
      <Show when={loadingUrl() || hoveredUrl()}>
        <div class="hover-link-indicator">{loadingUrl() || hoveredUrl()}</div>
      </Show>

      <Show when={keyHelp().visible}>
        <div
          class="h-screen w-screen flex items-center justify-center bg-black/60 pointer-events-auto"
          onClick={() => window.ipc.toggleKeyHelp()}
        >
          <div
            class="w-[520px] max-w-[calc(100vw-24px)] max-h-[calc(100dvh-24px)] flex flex-col overflow-y-auto bg-[#1c1b22] border border-[#30303a] rounded-xl p-4 [@media(max-height:200px)]:p-2"
            role="dialog"
            aria-modal="true"
            aria-label="Keyboard shortcuts"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key !== 'Tab') return;
              const controls = [...e.currentTarget.querySelectorAll<HTMLElement>('input, button, summary')].filter(el => el.getClientRects().length > 0);
              if (!controls.length) return;
              const index = controls.indexOf(document.activeElement as HTMLElement);
              if ((e.shiftKey && index <= 0) || (!e.shiftKey && index === controls.length - 1)) {
                e.preventDefault();
                controls[e.shiftKey ? controls.length - 1 : 0]?.focus();
              }
            }}
          >
            <div class="flex shrink-0 items-center justify-between mb-4 [@media(max-height:200px)]:mb-1">
              <h2 class="text-white/90 text-lg font-semibold">Keyboard shortcuts</h2>
              <button type="button" class="p-1 rounded-lg text-[#c8c7d4] hover:bg-[#30303a] focus-visible:outline-2 focus-visible:outline-[#a0a0b0]" title="Close (Escape)" aria-label="Close keyboard shortcuts" onClick={() => window.ipc.toggleKeyHelp()}>
                <Icon name="clear" />
              </button>
            </div>
            <input ref={shortcutSearch} type="search" value={shortcutQuery()} onInput={e => setShortcutQuery(e.currentTarget.value)} aria-label="Search shortcuts" placeholder="Search shortcuts" class="w-full shrink-0 bg-[#222228] border border-[#30303a] rounded-lg px-3 py-2 mb-3 [@media(max-height:200px)]:mb-1 [@media(max-height:200px)]:py-1 text-sm text-[#fbfbfe] placeholder-[var(--text-muted)] focus-visible:outline-2 focus-visible:outline-[#a0a0b0]" />
            <div class="awrit-feedback-input min-h-0 overflow-y-auto max-h-[60vh] pr-2 pb-2 [@media(max-height:200px)]:min-h-max [@media(max-height:200px)]:max-h-none">
              <Show when={shortcutGroups().length} fallback={<p class="text-sm text-[#c8c7d4] py-3">No matching shortcuts</p>}>
                <For each={shortcutGroups()}>
                  {group => (
                    <section class="mb-5 last:mb-0" aria-label={group.name}>
                      <h3 class="text-xs font-semibold text-[var(--text-muted)] mb-2">{group.name}</h3>
                      <Show when={group.name === 'Advanced'}><p class="text-xs text-[var(--text-muted)] mb-2">Plain navigation keys apply outside text inputs.</p></Show>
                      <For each={group.items}>
                        {item => (
                          <div class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-1.5">
                            <span class="text-[var(--text-primary)] text-sm">{item.action}</span>
                            <div class="min-w-0 max-w-full text-right">
                              <kbd class="inline-block max-w-full break-words px-2 py-0.5 bg-[#30303a] rounded-md text-[#c8c7d4] text-xs font-mono">{item.keys[0]}</kbd>

                            </div>
                          </div>
                        )}
                      </For>
                    </section>
                  )}
                </For>
                <Show when={shortcutGroups().some(group => group.items.some(item => item.keys.length > 1))}>
                  <details class="text-xs text-[var(--text-muted)]">
                    <summary class="cursor-pointer py-2 focus-visible:outline-2 focus-visible:outline-[#a0a0b0]">Additional shortcuts</summary>
                    <For each={shortcutGroups().flatMap(group => group.items).filter(item => item.keys.length > 1)}>
                      {item => <div class="flex flex-wrap justify-between gap-2 py-1.5"><span>{item.action}</span><div class="flex flex-wrap gap-2"><For each={item.keys.slice(1)}>{key => <kbd class="break-words">{key}</kbd>}</For></div></div>}
                    </For>
                  </details>
                </Show>
              </Show>
            </div>
          </div>
        </div>
      </Show>

      <Show when={permissionReq()}>
        {(req) => (
          <div class="zen-fixed-wrapper" style={{ 'z-index': 3000, 'pointer-events': 'auto' }}>
            <div
              class="zen-backdrop"
              onMouseDown={() => {
                window.ipc.resolvePermission(
                  req().id,
                  false,
                  req().url,
                  req().permission,
                  req().mediaTypes,
                );
                setPermissionReq(null);
              }}
            />
            <div
              class="permission-palette"
              role="alertdialog"
              aria-label={`${getDomain(req().url)} permission request`}
              onMouseDown={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                if (e.key === 'Tab') {
                  const buttons = [...e.currentTarget.querySelectorAll('button')];
                  const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
                  const next = e.shiftKey ? index - 1 : index + 1;
                  e.preventDefault();
                  buttons[(next + buttons.length) % buttons.length]?.focus();
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  window.ipc.resolvePermission(
                    req().id,
                    false,
                    req().url,
                    req().permission,
                    req().mediaTypes,
                  );
                  setPermissionReq(null);
                }
              }}
            >
              <div class="permission-body">
                <div class="permission-host">{getDomain(req().url)}</div>
                <div class="permission-text">
                  Wants to use your{' '}
                  <span class="permission-what">
                    {req().permission === 'media'
                      ? req().mediaTypes?.includes('video') && req().mediaTypes?.includes('audio')
                        ? 'camera and microphone'
                        : req().mediaTypes?.includes('video')
                          ? 'camera'
                          : req().mediaTypes?.includes('audio')
                            ? 'microphone'
                            : 'camera or microphone'
                      : req().permission === 'geolocation'
                        ? 'location'
                        : req().permission === 'notifications'
                          ? 'notifications'
                          : req().permission}
                  </span>
                </div>
              </div>
              <div class="permission-actions">
                <button
                  ref={(el) => queueMicrotask(() => el.focus())}
                  class="permission-btn"
                  onClick={() => {
                    window.ipc.resolvePermission(
                      req().id,
                      false,
                      req().url,
                      req().permission,
                      req().mediaTypes,
                    );
                    setPermissionReq(null);
                  }}
                >
                  Deny
                </button>
                <button
                  class="permission-btn primary"
                  onClick={() => {
                    window.ipc.resolvePermission(
                      req().id,
                      true,
                      req().url,
                      req().permission,
                      req().mediaTypes,
                    );
                    setPermissionReq(null);
                  }}
                >
                  Allow
                </button>
              </div>
            </div>
          </div>
        )}
      </Show>

      {/* Design Mode Overlay */}
      <DesignModeOverlay
        active={designModeActive()}
        onReviewContextChange={setReviewContext}
        onExit={async () => {
          if (leavingReview) return;
          leavingReview = true;
          try {
            await reviewContext()?.saveBeforeLeave?.();
          } catch (error) {
            // The review reports save errors; keep it open so edits can be recovered.
            console.error('Could not leave review:', error);
            return;
          } finally {
            leavingReview = false;
          }
          setDesignModeActive(false);
          window.ipc.exitDesignMode();
        }}
      />

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
