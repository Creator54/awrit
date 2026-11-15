/* @refresh reload */
import { render } from 'solid-js/web';
import './index.css';
import { Toolbar } from './Toolbar';
import { installTooltips } from './tooltip';

const scheme = new URLSearchParams(location.search).get('terminalScheme');
document.documentElement.style.setProperty('--awrit-terminal-scheme', scheme === 'light' ? 'light' : 'dark');
document.documentElement.dataset.terminalBackground = new URLSearchParams(location.search).get('terminalBackground') ?? '';
const root = document.getElementById('root');
installTooltips();
// biome-ignore lint/style/noNonNullAssertion: trust the root
render(() => <Toolbar />, root!);
