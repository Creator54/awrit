import { shell, type Session, app } from 'electron';
import * as http from 'node:http';
import * as url from 'node:url';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { console_ } from './console';

export interface OAuthConfig {
  clientId: string;
  scopes: string[];
  redirectPort?: number;
}

export class OAuthManager {
  private server: http.Server | null = null;
  private currentPort = 9223;
  private codeVerifier: string = '';
  private state: string = '';
  private tokenPath: string;

  constructor(private config: OAuthConfig) {
    if (config.redirectPort) {
      this.currentPort = config.redirectPort;
    }
    // Store tokens in the user config directory
    const userDataPath = app.getPath('userData');
    this.tokenPath = path.join(userDataPath, 'google_tokens.json');
  }

  /**
   * Starts the OAuth flow by opening the system browser.
   * Returns a promise that resolves with the access token.
   */
  public async authenticate(): Promise<{ access_token: string, refresh_token?: string }> {
    return new Promise((resolve, reject) => {
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
            reject(new Error('OAuth state mismatch'));
            return;
          }

          if (code) {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end('<h1>Success!</h1><p>Authentication complete. You can close this window.</p>');
            
            try {
              const tokens = await this.exchangeCodeForTokens(code);
              this.cleanup();
              resolve(tokens);
            } catch (err) {
              this.cleanup();
              reject(err);
            }
          } else {
            res.writeHead(400);
            res.end(`Error: ${error || 'Unknown error'}`);
            this.cleanup();
            reject(new Error(error || 'Failed to get authorization code'));
          }
        } else {
          res.writeHead(404);
          res.end();
        }
      });

      this.server.listen(this.currentPort, '127.0.0.1', () => {
        const authUrl = this.buildAuthUrl(codeChallenge);
        console_.log(`Opening system browser for OAuth: ${authUrl}`);
        shell.openExternal(authUrl);
      });

      this.server.on('error', (err) => {
        console_.error('OAuth server error:', err);
        this.cleanup();
        reject(err);
      });
    });
  }

  private async exchangeCodeForTokens(code: string): Promise<any> {
    const redirectUri = `http://127.0.0.1:${this.currentPort}/callback`;
    const params = new URLSearchParams({
      client_id: this.config.clientId,
      code_verifier: this.codeVerifier,
      code,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    });

    const response = await fetch('https://oauth2.googleapis.com/token', {
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

  private saveTokens(tokens: any) {
    try {
      fs.writeFileSync(this.tokenPath, JSON.stringify(tokens, null, 2));
    } catch (err) {
      console_.error('Failed to save OAuth tokens:', err);
    }
  }

  public loadTokens(): any {
    try {
      if (fs.existsSync(this.tokenPath)) {
        return JSON.parse(fs.readFileSync(this.tokenPath, 'utf8'));
      }
    } catch (err) {
      console_.error('Failed to load OAuth tokens:', err);
    }
    return null;
  }

  public async refreshToken(refreshToken: string): Promise<any> {
    const params = new URLSearchParams({
      client_id: this.config.clientId,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    });

    const response = await fetch('https://oauth2.googleapis.com/token', {
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
      } catch (err) {
        console_.error('Token refresh failed, returning last known access token');
        return tokens.access_token;
      }
    }

    return tokens.access_token;
  }

  private buildAuthUrl(codeChallenge: string): string {
    const redirectUri = `http://127.0.0.1:${this.currentPort}/callback`;
    const scopes = encodeURIComponent(this.config.scopes.join(' '));
    
    return `https://accounts.google.com/o/oauth2/v2/auth?` +
      `client_id=${this.config.clientId}&` +
      `redirect_uri=${redirectUri}&` +
      `response_type=code&` +
      `scope=${scopes}&` +
      `state=${this.state}&` +
      `code_challenge=${codeChallenge}&` +
      `code_challenge_method=S256&` +
      `access_type=offline&` +
      `prompt=consent`;
  }

  /**
   * Attempts to exchange an access token for session cookies and inject them.
   * This uses the internal Google OAuthLogin endpoint which is used by some official apps.
   */
  public async establishSession(session: Session, accessToken: string): Promise<void> {
    console_.log('Attempting to establish Google session in Electron...');
    
    // Note: This endpoint is technically internal/legacy but often works for this purpose
    const loginUrl = `https://www.google.com/accounts/OAuthLogin?auth=${accessToken}`;
    
    const response = await fetch(loginUrl, {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
      }
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch session cookies: ${response.statusText}`);
    }

    const body = await response.text();
    // The response body often contains SID=... LSID=... Auth=...
    const lines = body.split('\n');
    for (const line of lines) {
      const [key, value] = line.split('=');
      if (key && value) {
        const cookieName = key.trim();
        const cookieValue = value.trim();
        
        // Inject into Electron's cookie jar
        await session.cookies.set({
          url: 'https://google.com',
          name: cookieName,
          value: cookieValue,
          domain: '.google.com',
          path: '/',
          secure: true,
          httpOnly: true,
          sameSite: 'no_restriction'
        });
      }
    }
    
    console_.log('Session establishment attempt complete.');
  }

  private cleanup() {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }
}

/**
 * Checks if a URL is a Google OAuth initiation or login URL.
 */
export function isGoogleOAuthUrl(urlStr: string): boolean {
  try {
    const parsed = new URL(urlStr);
    if (parsed.hostname !== 'accounts.google.com') return false;
    
    return (
      parsed.pathname.startsWith('/o/oauth2') ||
      parsed.pathname.startsWith('/ServiceLogin') ||
      parsed.pathname.includes('/signin/')
    );
  } catch {
    return false;
  }
}
