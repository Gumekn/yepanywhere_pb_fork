export type {
  Connection,
  StreamHandlers,
  Subscription,
  UploadOptions,
} from "./types";
export {
  WebSocketCloseError,
  SubscriptionError,
  isNonRetryableError,
  NON_RETRYABLE_CLOSE_CODES,
} from "./types";
export {
  ConnectionManager,
  type ConnectionState,
  type ConnectionManagerConfig,
  type ReconnectFn,
  type SendPingFn,
  type TimerInterface,
  type VisibilityInterface,
} from "./ConnectionManager";
export { DirectConnection, directConnection } from "./DirectConnection";
export {
  WebSocketConnection,
  getWebSocketConnection,
} from "./WebSocketConnection";

/**
 * Singleton ConnectionManager for the app.
 * Both ActivityBus and useSessionStream feed events into this instance.
 */
import { ConnectionManager } from "./ConnectionManager";
export const connectionManager = new ConnectionManager();
