import { shell, type Session, app } from 'electron';
import * as http from 'node:http';
import * as url from 'node:url';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { console_ } from './console';

export interface AuthProvider {
  name: string;
  domains: string[];
  clientId: string;
  scopes: string[];
  authorizeUrl: string;
  tokenUrl: string;
  redirectPort?: number;
  /** Optional function to exchange token for cookies/session */
  establishSession?: (session: Session, accessToken: string) => Promise<void>;
}

export class OAuthManager {
  private server: http.Server | null = null;
  private currentPort = 9223;
  private codeVerifier: string = '';
  private state: string = '';
  private tokenPath: string;

  constructor(private provider: AuthProvider) {
    if (provider.redirectPort) {
      this.currentPort = provider.redirectPort;
    }
    // Store tokens in the user config directory
    const userDataPath = app.getPath('userData');
    this.tokenPath = path.join(userDataPath, `auth_tokens_${provider.name}.json`);
  }

  /**
   * Starts the OAuth flow by opening the system browser.
   * Returns a promise that resolves with the access token.
   */
  public async authenticate(): Promise<{ access_token: string, refresh_token?: string }> {
    return new Promise((resolve, reject) => {
      const AUTH_TIMEOUT_MS = 2 * 60 * 1000;

      let settled = false;
      const finish = (err: Error | null, tokens?: any) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        this.cleanup();
        if (err) reject(err);
        else resolve(tokens);
      };

      const timeout = setTimeout(() => {
        finish(new Error('Authentication timed out. The login was not completed within 2 minutes.'));
      }, AUTH_TIMEOUT_MS);

      this.state = crypto.randomBytes(32).toString('hex');
      this.codeVerifier = crypto.randomBytes(64).toString('base64url');
      const codeChallenge = crypto
        .createHash('sha256')
        .update(this.codeVerifier)
        .digest('base64url');

      this.server = http.createServer(async (req, res) => {
        const reqUrl = url.parse(req.url || '', true);
        
        if (reqUrl.pathname === '/callback') {
          const code = reqUrl.query.code as string;
          const returnedState = reqUrl.query.state as string;
          const error = reqUrl.query.error as string;

          if (returnedState !== this.state) {
            res.writeHead(400);
            res.end('State mismatch error');
            finish(new Error('OAuth state mismatch'));
            return;
          }

          if (code) {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end('<h1>Success!</h1><p>Authentication complete. You can close this window.</p>');
            
            try {
              const tokens = await this.exchangeCodeForTokens(code);
              finish(null, tokens);
            } catch (err) {
              finish(err instanceof Error ? err : new Error(String(err)));
            }
          } else {
            res.writeHead(400);
            res.end(`Error: ${error || 'Unknown error'}`);
            finish(new Error(error || 'Failed to get authorization code'));
          }
        } else {
          res.writeHead(404);
          res.end();
        }
      });

      this.server.listen(this.currentPort, '127.0.0.1', () => {
        const authUrl = this.buildAuthUrl(codeChallenge);
        console_.log(`Opening system browser for OAuth [${this.provider.name}]: ${authUrl}`);
        shell.openExternal(authUrl);
      });

      this.server.on('error', (err: NodeJS.ErrnoException) => {
        let message = `OAuth server error [${this.provider.name}]: ${err.message}`;
        if (err.code === 'EADDRINUSE') {
          message = `Port ${this.currentPort} is already in use. Cannot start OAuth callback server.`;
        }
        console_.error(message);
        finish(new Error(message));
      });
    });
  }

  private async exchangeCodeForTokens(code: string): Promise<any> {
    const redirectUri = `http://127.0.0.1:${this.currentPort}/callback`;
    const params = new URLSearchParams({
      client_id: this.provider.clientId,
      code_verifier: this.codeVerifier,
      code,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    });

    const response = await fetch(this.provider.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Token exchange failed: ${errorText}`);
    }

    const tokens = await response.json();
    this.saveTokens(tokens);
    return tokens;
  }

  public saveTokens(tokens: any) {
    try {
      fs.writeFileSync(this.tokenPath, JSON.stringify(tokens, null, 2));
    } catch (err) {
      console_.error(`Failed to save OAuth tokens [${this.provider.name}]:`, err);
    }
  }

  public loadTokens(): any {
    try {
      if (fs.existsSync(this.tokenPath)) {
        return JSON.parse(fs.readFileSync(this.tokenPath, 'utf8'));
      }
    } catch (err) {
      console_.error(`Failed to load OAuth tokens [${this.provider.name}]:`, err);
    }
    return null;
  }

  public async refreshToken(refreshToken: string): Promise<any> {
    const params = new URLSearchParams({
      client_id: this.provider.clientId,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    });

    const response = await fetch(this.provider.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });

    if (!response.ok) {
      throw new Error(`Token refresh failed: ${response.statusText}`);
    }

    const tokens = await response.json();
    // Refresh response may not include a new refresh token
    const current = this.loadTokens();
    const updated = { ...current, ...tokens };
    this.saveTokens(updated);
    return updated;
  }

  /**
   * Returns a valid access token, refreshing it if necessary.
   */
  public async getValidToken(): Promise<string | null> {
    const tokens = this.loadTokens();
    if (!tokens) return null;

    // TODO: Check expiration. For now, just attempt refresh if we have a refresh token
    if (tokens.refresh_token) {
      try {
        const refreshed = await this.refreshToken(tokens.refresh_token);
        return refreshed.access_token;
      } catch (_err) {
        console_.error(`Token refresh failed [${this.provider.name}], returning last known access token`);
        return tokens.access_token;
      }
    }

    return tokens.access_token;
  }

  private buildAuthUrl(codeChallenge: string): string {
    const redirectUri = `http://127.0.0.1:${this.currentPort}/callback`;
    const url = new URL(this.provider.authorizeUrl);
    
    url.searchParams.set('client_id', this.provider.clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', this.provider.scopes.join(' '));
    url.searchParams.set('state', this.state);
    url.searchParams.set('code_challenge', codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    
    // Provider specific extras
    if (this.provider.name === 'google') {
      url.searchParams.set('access_type', 'offline');
      url.searchParams.set('prompt', 'consent');
    }
    
    return url.toString();
  }

  /**
   * Attempts to establish a session using the provider's specific logic.
   */
  public async establishSession(session: Session, accessToken: string): Promise<void> {
    if (this.provider.establishSession) {
      return this.provider.establishSession(session, accessToken);
    }
    
    // Default: no session establishment logic
    console_.log(`No session establishment logic defined for provider: ${this.provider.name}`);
  }

  private cleanup() {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }
}

/**
 * Global registry of auth providers.
 */
const providers: AuthProvider[] = [];

export function registerAuthProvider(provider: AuthProvider) {
  // If provider with same name already exists, replace it
  const index = providers.findIndex(p => p.name === provider.name);
  if (index !== -1) {
    providers[index] = provider;
  } else {
    providers.push(provider);
  }
}

export function getProviderForUrl(urlStr: string): AuthProvider | null {
  try {
    const url = new URL(urlStr);
    const hostname = url.hostname;
    for (const provider of providers) {
      if (provider.domains.some(d => hostname === d || hostname.endsWith('.' + d))) {
        // For Google, only trigger on actual login entry points to avoid 
        // redirecting every search/document visit.
        if (provider.name === 'google') {
          if (hostname === 'accounts.google.com' && (
            url.pathname.startsWith('/o/oauth2') ||
            url.pathname.startsWith('/ServiceLogin') ||
            url.pathname.includes('/signin/')
          )) {
            return provider;
          }
          return null;
        }
        return provider;
      }
    }
  } catch {}
  return null;
}

/**
 * Checks if a URL is an OAuth initiation or login URL for any registered provider.
 */
export function isAuthInitiationUrl(urlStr: string): boolean {
  return getProviderForUrl(urlStr) !== null;
}

/**
 * Handles incoming deep link authentication callbacks.
 * Format: awrit://auth?provider=name&token=...&refresh=...
 */
export async function handleDeepLinkAuth(urlStr: string, session: Session): Promise<void> {
  try {
    const parsed = new URL(urlStr);
    if (parsed.hostname !== 'auth') return;

    const providerName = parsed.searchParams.get('provider');
    const accessToken = parsed.searchParams.get('token');
    
    if (!providerName || !accessToken) {
      console_.error('[DeepLinkAuth] Missing provider or token in URL');
      return;
    }

    const provider = providers.find(p => p.name === providerName);
    if (!provider) {
      console_.error(`[DeepLinkAuth] Unknown provider: ${providerName}`);
      return;
    }

    console_.log(`[DeepLinkAuth] Received callback for ${providerName}`);
    
    // Save tokens if we have them
    const tokens = {
      access_token: accessToken,
      refresh_token: parsed.searchParams.get('refresh') || undefined,
    };
    const manager = new OAuthManager(provider);
    manager.saveTokens(tokens);

    // Establish session
    if (provider.establishSession) {
      await provider.establishSession(session, accessToken);
    }
  } catch (e) {
    console_.error('[DeepLinkAuth] Error handling deep link:', e);
  }
}
