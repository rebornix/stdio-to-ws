import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { inspect } from "node:util";
import { WebSocket, WebSocketServer } from "ws";

let isQuiet = false;

function logError(...args: unknown[]): void {
  if (!isQuiet) console.error("[stdio-to-ws]", ...args);
}
function log(...args: unknown[]): void {
  if (!isQuiet) console.log("[stdio-to-ws]", ...args);
}

function prettyPrintMessage(
  direction: "[Client → Server]" | "[Server → Client]",
  message: string,
): void {
  try {
    const parsed = JSON.parse(message);
    console.log(`${direction}:`, inspect(parsed, { depth: 5, colors: true }));
  } catch {
    // Not JSON, print as-is
    console.log(`${direction}:`, message);
  }
}

// Persistence support for reconnections
interface Client {
  id: string;
  child: ChildProcess;
  ws: WebSocket;
  buffer: string[];
  cleanupTimer?: NodeJS.Timeout;
}

const clients = new Map<string, Client>();

function cleanupClient(clientId: string): void {
  const client = clients.get(clientId);
  if (!client) return;

  log(`Cleaning up client ${clientId}`);
  if (client.cleanupTimer) {
    clearTimeout(client.cleanupTimer);
  }
  client.child.kill();
  clients.delete(clientId);
}

function handleWebSocketConnection(
  command: string[],
  webSocket: WebSocket,
  options: { persist: boolean; gracePeriodMs: number; pingIntervalMs: number; clientId?: string },
): void {
  const { persist, gracePeriodMs, pingIntervalMs, clientId: requestedId } = options;

  // -1 means infinite grace period (no cleanup)
  const isInfinite = gracePeriodMs === -1;

  let pingTimer: NodeJS.Timeout | null = null;
  if (pingIntervalMs) {
    pingTimer = setInterval(() => webSocket.ping(), pingIntervalMs);
  }

  // Check if reconnecting to existing client
  if (persist && requestedId && clients.has(requestedId)) {
    const client = clients.get(requestedId)!;
    log(`Reconnecting to existing client ${client.id}`);

    // Cancel cleanup timer
    if (client.cleanupTimer) {
      clearTimeout(client.cleanupTimer);
      client.cleanupTimer = undefined;
    }

    // Update WebSocket reference
    client.ws = webSocket;

    // Send reconnect confirmation and flush buffered messages
    webSocket.send(JSON.stringify({ type: "reconnect", clientId: client.id }));
    for (const msg of client.buffer) {
      webSocket.send(msg);
    }
    client.buffer = [];

    // Setup WebSocket listeners
    webSocket.on("message", (data) => {
      try {
        const message = data.toString();
        const content = message.replace(/^Content-Length: \d+\r?\n\r?\n/, "");
        prettyPrintMessage("[Client → Server]", content);
        client.child.stdin?.write(content);
      } catch (error) {
        logError("Failed to write to child stdin:", error);
      }
    });

    webSocket.on("close", () => {
      log(`WebSocket closed for client ${client.id}${isInfinite ? " (infinite persistence)" : ", starting grace period"}`);
      if (pingTimer) {
        clearInterval(pingTimer);
      }
      if (!isInfinite) {
        client.cleanupTimer = setTimeout(() => {
          cleanupClient(client.id);
        }, gracePeriodMs);
      }
    });

    return;
  }

  // Create new connection
  const child = spawn(command[0]!, command.slice(1));
  const clientId = requestedId || randomUUID();

  const client: Client = { id: clientId, child, ws: webSocket, buffer: [] };
  if (persist) {
    clients.set(clientId, client);
    log(`Created new client ${clientId}`);
    webSocket.send(JSON.stringify({ type: "connected", clientId }));
  }

  child.on("error", (error) => {
    logError("Child process error:", error);
    if (persist) cleanupClient(clientId);
    webSocket.close();
  });

  child.on("exit", (code) => {
    log(`Child process exited with code ${code}`);
    if (persist) cleanupClient(clientId);
    webSocket.close();
  });

  webSocket.on("message", (data) => {
    try {
      const message = data.toString();
      const content = message.replace(/^Content-Length: \d+\r?\n\r?\n/, "");
      prettyPrintMessage("[Client → Server]", content);
      child.stdin?.write(content);
    } catch (error) {
      logError("Failed to write to child stdin:", error);
    }
  });

  webSocket.on("close", () => {
    if (persist) {
      const isInfinite = gracePeriodMs === -1;
      log(`WebSocket closed for client ${clientId}${isInfinite ? " (infinite persistence)" : ", starting grace period"}`);
      if (pingTimer) {
        clearInterval(pingTimer);
      }
      if (!isInfinite) {
        client.cleanupTimer = setTimeout(() => {
          cleanupClient(clientId);
        }, gracePeriodMs);
      }
    } else {
      child.kill();
    }
  });

  child.stdout.on("data", (data) => {
    try {
      const message = data.toString();
      const content = message.replace(/^Content-Length: \d+\r?\n\r?\n/, "");
      prettyPrintMessage("[Server → Client]", content);
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(content);
      } else if (persist) {
        client.buffer.push(content);
      }
    } catch (error) {
      logError("Failed to send data to WebSocket:", error);
    }
  });

  child.stderr.on("data", (data) => {
    logError("Child stderr:", data.toString());
  });
}

export function startWebSocketServer(opts: {
  port: number;
  command: string[];
  corsOrigin?: string | string[] | boolean;
  quiet?: boolean;
  persist?: boolean;
  gracePeriodMs?: number;
  pingIntervalMs?: number;
}): void {
  const { port, command, corsOrigin, quiet = false, persist = false, gracePeriodMs = 30000, pingIntervalMs = 0 } = opts;
  isQuiet = quiet;

  const wss = new WebSocketServer({
    port,
    verifyClient: corsOrigin
      ? ({ origin }: { origin: string }) => {
        if (corsOrigin === true) return true;
        if (typeof corsOrigin === "string") return origin === corsOrigin;
        if (Array.isArray(corsOrigin)) return corsOrigin.includes(origin);
        return false;
      }
      : undefined,
  });

  wss.on("error", (error) => {
    logError("WebSocket server error:", error);
  });

  wss.on("connection", (webSocket, request) => {
    const clientId = request.headers["x-client-id"] as string | undefined;
    log("New WebSocket connection", clientId ? `(X-Client-Id: ${clientId})` : "(no X-Client-Id header)");
    handleWebSocketConnection(command, webSocket, { persist, gracePeriodMs, pingIntervalMs, clientId });
  });

  const graceDisplay = gracePeriodMs === -1 ? "infinite" : `${gracePeriodMs / 1000}s`;
  log(`WebSocket server listening on port ${port}${persist ? ` (persistence enabled, grace period: ${graceDisplay})` : ''}`);
}
