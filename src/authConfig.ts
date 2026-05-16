import { registerAuthProvider, establishGoogleSession } from './auth';

/**
 * Standard provider templates.
 * These are only used if the user refers to them by name in config.js.
 */
const STANDARD_PROVIDERS: Record<string, any> = {
  google: {
    domains: ['accounts.google.com'],
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    establishSession: establishGoogleSession,
    defaultScopes: ['email', 'profile'],
  },
};

export function registerProviders(config: any) {
  if (config.providers && Array.isArray(config.providers)) {
    for (const provider of config.providers) {
      // If it's a standard provider name, merge with template
      const template = STANDARD_PROVIDERS[provider.name];
      if (template) {
        const merged = {
          ...template,
          ...provider,
          scopes: provider.scopes || template.defaultScopes,
          redirectPort: provider.redirectPort || 9223,
        };
        registerAuthProvider(merged);
      } else {
        // Purely custom provider
        registerAuthProvider(provider);
      }
    }
  }
}
