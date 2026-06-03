import { type Connection, directConnection } from "../lib/connection";

/**
 * Hook that provides the current connection to the server.
 *
 * Returns the DirectConnection (REST + upload via HTTP).
 *
 * Note: Subscriptions (session/activity streams) are handled separately
 * by useSSE and ActivityBus, which always use WebSocket.
 *
 * @returns The active Connection instance
 */
export function useConnection(): Connection {
  return directConnection;
}
