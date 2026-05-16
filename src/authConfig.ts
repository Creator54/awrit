import { type OAuthConfig } from './auth';

export let oauthConfig: OAuthConfig = {
  clientId: '',
  scopes: ['email', 'profile'],
  redirectPort: 9223,
};

export function setOAuthConfig(config: Partial<OAuthConfig>) {
  oauthConfig = { ...oauthConfig, ...config };
}
