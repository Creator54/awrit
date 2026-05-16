export type Toolbar = {
  navigateBack: () => void;
  navigateForward: () => void;
  refresh: () => void;
  navigateTo: (url: string) => void;
};

export type Content = {
  loadingStarted: () => void;
  loadingStopped: () => void;
  loadingProgress: (progress: number) => void;
  urlChanged: (url: string) => void;
  navigationStateChanged: (state: { canGoBack: boolean; canGoForward: boolean }) => void;
};

export const Toolbar: Array<keyof Toolbar> = [
  'navigateBack',
  'navigateForward',
  'refresh',
  'navigateTo',
];

export const Content: Array<keyof Content> = [
  'loadingStarted',
  'loadingStopped',
  'loadingProgress',
  'urlChanged',
  'navigationStateChanged',
];

export type IPC = {
  toolbar: Toolbar;
  content: Content;
};

type fn = (...args: any[]) => any;

export type TypedIpcMain<I extends keyof IPC = 'toolbar', O extends keyof IPC = 'content'> = {
  on: <K extends keyof IPC[I]>(event: K, listener: IPC[I][K]) => void;
  send: <K extends keyof IPC[O]>(event: K, ...args: Parameters<IPC[O][K] & fn>) => void;
};

export type TypedIpcRenderer<I extends keyof IPC = 'content', O extends keyof IPC = 'toolbar'> = {
  on: <K extends keyof IPC[I]>(event: K, listener: IPC[I][K]) => void;
  send: <K extends keyof IPC[O]>(event: K, ...args: Parameters<IPC[O][K] & fn>) => void;
};
