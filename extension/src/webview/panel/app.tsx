/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import type { ViewState, WebviewToHostMessage } from '../../shared/protocol';
import type { ClientTransport } from '../transport/client-transport';
import { EMPTY_VIEW_STATE } from './hooks/use-host-sync';
import { AppBody } from './app-body';

export { EMPTY_VIEW_STATE };

export interface AppAdapter {
  postMessage: (msg: WebviewToHostMessage) => void;
  /** The active client transport (VS Code or browser); host-sync subscribes
   *  through it and renders the connection banner from its state. */
  transport: ClientTransport;
  initialState?: ViewState;
}

export function App({ adapter }: { adapter: AppAdapter }) {
  return <AppBody adapter={adapter} />;
}
