// Content preload script for anti-detection
// Injects into all navigated content pages to hide automation indicators
// Runs BEFORE any page JavaScript

// Force dark mode CSS early
const injectDarkMode = () => {
  if (document.documentElement) {
    const style = document.createElement('style');
    style.id = 'awrit-dark-mode';
    style.innerHTML = `
      html { color-scheme: dark !important; }
      
      /* Gmail Landing & Login Page Fixes */
      .TemplateHeader_header, 
      header, 
      [role="banner"],
      .gb_wa, 
      .gb_ka,
      .TemplatePromoBanner,
      .F9f9f,
      .VfPpkd-LgbsSe {
        background-color: #1a1a1a !important;
        color: #ffffff !important;
        border-bottom-color: #333 !important;
      }
      
      .TemplateHeader_logo, .gb_hc {
        filter: invert(1) brightness(2) !important;
      }

      /* Google Sign-in Fixes */
      body {
        background-color: #000000 !important;
        color: #e8eaed !important;
      }
      
      .z97WId, .WfS9Zc, .t5S78d {
        color: #e8eaed !important;
      }
      
      input {
        background-color: #202124 !important;
        color: #ffffff !important;
        border-color: #5f6368 !important;
      }
    `;
    document.documentElement.appendChild(style);
    
    const observer = new MutationObserver(() => {
      if (document.documentElement && !document.getElementById('awrit-dark-mode')) {
        document.documentElement.appendChild(style);
      }
    });
    observer.observe(document.documentElement, { childList: true });
  } else {
    setTimeout(injectDarkMode, 1);
  }
};
injectDarkMode();

// ===========================================
// Core Navigator Overrides (Critical for Detection)
// ===========================================

// 1. Override navigator.webdriver (Google's primary detection vector)
// Override on Navigator.prototype so the property truly disappears from detection
Object.defineProperty(Navigator.prototype, 'webdriver', {
  get: () => undefined,
  configurable: true,
  enumerable: true,
});

// 2. Override navigator.plugins (headless = empty)
// Must override on Navigator.prototype because Chromium defines it there
const mockPlugins = [
  {
    name: 'Chrome PDF Plugin',
    filename: 'internal-pdf-viewer',
    description: 'Portable Document Format',
    length: 1,
    0: { type: 'application/x-google-chrome-pdf', suffixes: 'pdf', description: '' },
    item: function(idx) { return this[idx]; },
    namedItem: function(name) { return null; },
  },
  {
    name: 'Chrome PDF Viewer',
    filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai',
    description: '',
    length: 1,
    0: { type: 'application/pdf', suffixes: 'pdf', description: '' },
    item: function(idx) { return this[idx]; },
    namedItem: function(name) { return null; },
  },
  {
    name: 'Native Client',
    filename: 'internal-nacl-plugin',
    description: '',
    length: 2,
    0: { type: 'application/x-nacl', suffixes: '', description: 'Native Client Executable' },
    1: { type: 'application/x-pnacl', suffixes: '', description: 'Portable Native Client Executable' },
    item: function(idx) { return this[idx]; },
    namedItem: function(name) { return null; },
  },
];
mockPlugins.length = 3;
mockPlugins.item = function(idx) { return this[idx]; };
mockPlugins.namedItem = function(name) {
  for (let i = 0; i < this.length; i++) if (this[i].name === name) return this[i];
  return null;
};
Object.defineProperty(Navigator.prototype, 'plugins', {
  get: () => mockPlugins,
  configurable: true,
  enumerable: true,
});

// 3. Override navigator.mimeTypes
const mockMimeTypes = [
  { type: 'application/x-google-chrome-pdf', suffixes: 'pdf', description: '', enabledPlugin: mockPlugins[0] },
  { type: 'application/pdf', suffixes: 'pdf', description: '', enabledPlugin: mockPlugins[1] },
  { type: 'application/x-nacl', suffixes: '', description: 'Native Client Executable', enabledPlugin: mockPlugins[2] },
  { type: 'application/x-pnacl', suffixes: '', description: 'Portable Native Client Executable', enabledPlugin: mockPlugins[2] },
];
mockMimeTypes.length = 4;
mockMimeTypes.item = function(idx) { return this[idx]; };
mockMimeTypes.namedItem = function(name) {
  for (let i = 0; i < this.length; i++) if (this[i].type === name) return this[i];
  return null;
};
Object.defineProperty(Navigator.prototype, 'mimeTypes', {
  get: () => mockMimeTypes,
  configurable: true,
  enumerable: true,
});

// 4. Override navigator.languages
Object.defineProperty(Navigator.prototype, 'languages', {
  get: () => ['en-US', 'en'],
  configurable: true,
  enumerable: true,
});

// 5. Override navigator.hardwareConcurrency (headless often 0)
Object.defineProperty(Navigator.prototype, 'hardwareConcurrency', {
  get: () => 8,
  configurable: true,
  enumerable: true,
});

// 6. Override navigator.deviceMemory (headless may be 0)
Object.defineProperty(Navigator.prototype, 'deviceMemory', {
  get: () => 8,
  configurable: true,
  enumerable: true,
});

// 7. Override window.outerWidth/outerHeight (headless = 0)
Object.defineProperty(window, 'outerWidth', {
  get: () => window.innerWidth || 1920,
});
Object.defineProperty(window, 'outerHeight', {
  get: () => window.innerHeight || 1080,
});

// ===========================================
// Chrome API Overrides (Google checks these)
// ===========================================

// 8. Override chrome object (real Chrome exposes this)
// Google's OAuth flow specifically checks chrome.loadTimes()
if (typeof window.chrome === 'undefined') {
  Object.defineProperty(window, 'chrome', {
    value: {},
    writable: false,
    enumerable: false,
    configurable: false,
  });
}

// 9. Chrome.loadTimes() - Google checks this for Chrome identification
if (!window.chrome.loadTimes) {
  Object.defineProperty(window.chrome, 'loadTimes', {
    value: function() {
      const now = Date.now() / 1000;
      return {
        commitLoadTime: now,
        connectionInfo: 'h2',
        finishDocumentLoadTime: now,
        finishLoadTime: now,
        firstPaintAfterLoadTime: 0,
        firstPaintTime: now,
        navigationType: 'Other',
        npnNegotiatedProtocol: 'h2',
        requestTime: now,
        startLoadTime: now,
        wasAlternateProtocolAvailable: false,
        wasFetchedViaSpdy: true,
        wasNpnNegotiated: true,
      };
    },
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

// 10. Chrome.csi() - Google's Customer Satisfaction Index
if (!window.chrome.csi) {
  Object.defineProperty(window.chrome, 'csi', {
    value: function() {
      return {
        onloadT: Date.now(),
        pageT: Date.now() / 1000,
        startE: Date.now(),
        tran: 15,
      };
    },
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

// 11. Chrome.app - Real Chrome has this
if (!window.chrome.app) {
  Object.defineProperty(window.chrome, 'app', {
    value: {
      isInstalled: false,
      InstallState: {
        DISABLED: 'disabled',
        INSTALLED: 'installed',
        NOT_INSTALLED: 'not_installed',
      },
      RunningState: {
        CANNOT_RUN: 'cannot_run',
        READY_TO_RUN: 'ready_to_run',
        RUNNING: 'running',
      },
    },
    writable: false,
    enumerable: false,
    configurable: false,
  });
}

// 12. Chrome.runtime - Real Chrome has this
if (!window.chrome.runtime) {
  Object.defineProperty(window.chrome, 'runtime', {
    value: {
      OnInstalledReason: {
        CHROME_UPDATE: 'chrome_update',
        INSTALL: 'install',
        SHARED_MODULE_UPDATE: 'shared_module_update',
        UPDATE: 'update',
      },
      OnRestartRequiredReason: {
        APP_UPDATE: 'app_update',
        OS_UPDATE: 'os_update',
        PERIODIC: 'periodic',
      },
      PlatformArch: {
        ARM: 'arm',
        MIPS: 'mips',
        MIPS64: 'mips64',
        X86_32: 'x86-32',
        X86_64: 'x86-64',
      },
      PlatformNaclArch: {
        ARM: 'arm',
        MIPS: 'mips',
        MIPS64: 'mips64',
        X86_32: 'x86-32',
        X86_64: 'x86-64',
      },
      PlatformOs: {
        ANDROID: 'android',
        CROS: 'cros',
        LINUX: 'linux',
        MAC: 'mac',
        OPENBSD: 'openbsd',
        WIN: 'win',
      },
      RequestUpdateCheckStatus: {
        NO_UPDATE: 'no_update',
        THROTTLED: 'throttled',
        UPDATE_AVAILABLE: 'update_available',
      },
    },
    writable: false,
    enumerable: false,
    configurable: false,
  });
}

// ===========================================
// WebGL Overrides (Headless = SwiftShader)
// ===========================================

// 13. Override WebGL renderer to hide SwiftShader
const getParameter = WebGLRenderingContext.prototype.getParameter;
WebGLRenderingContext.prototype.getParameter = function(parameter) {
  // UNMASKED_VENDOR_WEBGL
  if (parameter === 37445) {
    return 'Intel Inc.';
  }
  // UNMASKED_RENDERER_WEBGL
  if (parameter === 37446) {
    return 'Intel Iris OpenGL Engine';
  }
  return getParameter.call(this, parameter);
};

// 14. Also override WebGL2 if available
if (typeof WebGL2RenderingContext !== 'undefined') {
  const getParameter2 = WebGL2RenderingContext.prototype.getParameter;
  WebGL2RenderingContext.prototype.getParameter = function(parameter) {
    if (parameter === 37445) {
      return 'Intel Inc.';
    }
    if (parameter === 37446) {
      return 'Intel Iris OpenGL Engine';
    }
    return getParameter2.call(this, parameter);
  };
}

// ===========================================
// Screen & Window Overrides
// ===========================================

// 15. Override screen properties (headless may have abnormal values)
const realScreen = { ...screen };
Object.defineProperty(window, 'screen', {
  get: () => ({
    ...realScreen,
    width: realScreen.width || 1920,
    height: realScreen.height || 1080,
    availWidth: realScreen.availWidth || 1920,
    availHeight: realScreen.availHeight || 1080,
    colorDepth: realScreen.colorDepth || 24,
    pixelDepth: realScreen.pixelDepth || 24,
  }),
});

// ===========================================
// Security & Permissions Overrides
// ===========================================

// 16. Override permissions API (headless may deny all)
if (navigator.permissions) {
  const originalQuery = navigator.permissions.query.bind(navigator.permissions);
  navigator.permissions.query = function(desc) {
    return originalQuery(desc).catch(() => {
      return { state: 'prompt', onchange: null };
    });
  };
}

// 17. Override connection API (headless may have different values)
if (navigator.connection) {
  Object.defineProperty(navigator.connection, 'effectiveType', {
    get: () => '4g',
  });
}

// ===========================================
// CDP Detection Prevention
// ===========================================

// 18. Hide CDP WebSocket connections from detection
const originalWebSocket = window.WebSocket;
if (originalWebSocket) {
  Object.defineProperty(window, 'WebSocket', {
    value: function(url, protocols) {
      // Block WebSocket connections to localhost debugging ports
      if (url && (url.includes('127.0.0.1:9222') || url.includes('localhost:9222'))) {
        throw new Error('Failed to construct WebSocket: Access denied');
      }
      return new originalWebSocket(url, protocols);
    },
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

// 19. Hide fetch to localhost debugging
const originalFetch = window.fetch;
if (originalFetch) {
  window.fetch = function(input, init) {
    const url = typeof input === 'string' ? input : input.url;
    if (url && (url.includes('127.0.0.1:9222') || url.includes('localhost:9222'))) {
      return Promise.reject(new Error('Failed to fetch'));
    }
    return originalFetch.call(this, input, init);
  };
}

// ===========================================
// Internal Chrome State Overrides
// ===========================================

// 20. Hide DevTools detection (Google checks for DevTools availability)
// Override DevTools protocol detection methods
Object.defineProperty(window, '__devtools', {
  get: () => undefined,
});

// 21. Hide CDP internal state
Object.defineProperty(window, '__cdp__', {
  get: () => undefined,
});

// 22. Hide electron-specific properties
Object.defineProperty(window, 'electron', {
  get: () => undefined,
});
Object.defineProperty(window, 'require', {
  get: () => undefined,
});
Object.defineProperty(window, 'process', {
  get: () => undefined,
});
Object.defineProperty(window, '__dirname', {
  get: () => undefined,
});
Object.defineProperty(window, '__filename', {
  get: () => undefined,
});

// 23. Override navigator.platform to match user agent
Object.defineProperty(Navigator.prototype, 'platform', {
  get: () => 'Linux x86_64',
  configurable: true,
  enumerable: true,
});

// 24. Override navigator.vendor (must be Google Inc. for Chrome)
Object.defineProperty(Navigator.prototype, 'vendor', {
  get: () => 'Google Inc.',
  configurable: true,
  enumerable: true,
});

// 25. Mock navigator.userAgentData — Google OAuth queries this via getHighEntropyValues()
// Extract the real Chrome version from the UA so everything stays consistent
const chromeVerMatch = navigator.userAgent.match(/Chrome\/([0-9.]+)/);
const chromeFullVer = chromeVerMatch ? chromeVerMatch[1] : '134.0.0.0';
const chromeMajorVer = chromeFullVer.split('.')[0];

const mockBrands = [
  { brand: 'Google Chrome', version: chromeMajorVer },
  { brand: 'Chromium', version: chromeMajorVer },
  { brand: 'Not/A)Brand', version: '8' },
];

const mockFullVersionList = [
  { brand: 'Google Chrome', version: chromeFullVer },
  { brand: 'Chromium', version: chromeFullVer },
  { brand: 'Not/A)Brand', version: '8.0.0.0' },
];

Object.defineProperty(Navigator.prototype, 'userAgentData', {
  get: () => ({
    brands: mockBrands,
    mobile: false,
    platform: 'Linux',
    getHighEntropyValues: (hints) => {
      const result = {};
      for (const hint of hints) {
        switch (hint) {
          case 'platform':
            result.platform = 'Linux';
            break;
          case 'platformVersion':
            result.platformVersion = '6.8.0';
            break;
          case 'architecture':
            result.architecture = 'x86';
            break;
          case 'bitness':
            result.bitness = '64';
            break;
          case 'model':
            result.model = '';
            break;
          case 'uaFullVersion':
            result.uaFullVersion = chromeFullVer;
            break;
          case 'fullVersionList':
            result.fullVersionList = mockFullVersionList;
            break;
          case 'wow64':
            result.wow64 = false;
            break;
        }
      }
      return Promise.resolve(result);
    },
    toJSON: () => ({
      brands: mockBrands,
      mobile: false,
      platform: 'Linux',
    }),
  }),
});
