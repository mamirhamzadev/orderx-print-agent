import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import {
  AGENT_HOST,
  AGENT_PORT,
  HEARTBEAT_INTERVAL_MS,
} from "./constants";
import {
  completePairing,
  clearAuth,
  getPairingError,
  getPendingPairingCode,
  initAuth,
  isPaired,
  loadAuth,
  PairingError,
  authorizeWsRequest,
  verifyBearerToken,
} from "./auth";
import type {
  AgentCommandType,
  AgentMessage,
  AgentStatusSnapshot,
  HealthResponse,
  PairConfirmResponse,
} from "./protocol";
import {
  initConfigStore,
  loadConfig,
  saveConfig,
} from "./printer/configStore";
import {
  startDiscovery,
  cancelDiscovery,
  isDiscovering,
} from "./printer/discovery";
import {
  connectPrinter,
  disconnectPrinter,
  testPrinter,
  isPrinterConnected,
  getActivePrinter,
  restoreSavedPrinter,
} from "./printer/connection";
import { printPngBase64 } from "./printer/escpos";

export type ServerOptions = {
  host?: string;
  port?: number;
  version: string;
  userDataDir: string;
};

type StatusListener = (status: AgentStatusSnapshot) => void;

let options: ServerOptions | null = null;
let httpServer: http.Server | null = null;
let wss: WebSocketServer | null = null;
let heartbeat: NodeJS.Timeout | null = null;
let lastError: string | null = null;
const statusListeners = new Set<StatusListener>();
const openSockets = new Set<Socket>();

const send = (socket: WebSocket, message: AgentMessage): void => {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(message));
  }
};

const isLocalOrigin = (origin: string): boolean => {
  try {
    const url = new URL(origin);
    return (
      url.hostname === "127.0.0.1" ||
      url.hostname === "localhost" ||
      url.hostname === "0.0.0.0"
    );
  } catch {
    return false;
  }
};

const setLocalCors = (req: IncomingMessage, res: ServerResponse): void => {
  const origin = req.headers.origin;
  if (origin && isLocalOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  } else {
    res.setHeader("Access-Control-Allow-Origin", "*");
  }
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, POST, OPTIONS",
  );
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization",
  );
};

const json = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

export const getStatusSnapshot = (): AgentStatusSnapshot => ({
  running: Boolean(httpServer?.listening),
  version: options?.version ?? "0.0.0",
  paired: isPaired(),
  discovering: isDiscovering(),
  printerConnected: isPrinterConnected(),
  printer: getActivePrinter(),
  queue: 0,
  lastError,
  host: options?.host ?? AGENT_HOST,
  port: options?.port ?? AGENT_PORT,
  clients: wss?.clients.size ?? 0,
  pendingPairing: Boolean(getPendingPairingCode()),
  shopId: loadAuth()?.shopId ?? null,
  pairingError: getPairingError(),
});

const broadcast = (message: AgentMessage): void => {
  if (!wss) {
    return;
  }
  for (const client of wss.clients) {
    send(client, message);
  }
};

export const notifyStatus = (): AgentStatusSnapshot => {
  const snapshot = getStatusSnapshot();
  broadcast({ type: "agent.status", payload: snapshot });
  for (const listener of statusListeners) {
    listener(snapshot);
  }
  return snapshot;
};

export const onStatusChange = (listener: StatusListener): (() => void) => {
  statusListeners.add(listener);
  return () => {
    statusListeners.delete(listener);
  };
};

const readJsonBody = (
  req: IncomingMessage,
  limit = 64_000,
): Promise<unknown> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new PairingError(413, "payload_too_large", "Payload too large"));
        req.destroy();
      } else {
        chunks.push(chunk);
      }
    });
    req.on("end", () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new PairingError(400, "invalid_json", "Invalid JSON"));
      }
    });
    req.on("error", reject);
  });

const handlePairConfirm = async (
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> => {
  const body = (await readJsonBody(req)) as {
    code?: unknown;
    shopId?: unknown;
  };
  const record = completePairing(
    typeof body.code === "string" ? body.code : "",
    typeof body.shopId === "string" ? body.shopId : "",
  );
  const response: PairConfirmResponse = {
    token: record.token,
    shopId: record.shopId,
    port: options?.port ?? AGENT_PORT,
  };
  json(res, 200, response);
  notifyStatus();
};

const handleUnpair = (req: IncomingMessage, res: ServerResponse): void => {
  if (!verifyBearerToken(req.headers.authorization)) {
    json(res, 401, { error: "unauthorized" });
    return;
  }
  clearAuth();
  json(res, 200, { ok: true });
  notifyStatus();
};

const handleRequestAsync = async (
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> => {
  setLocalCors(req, res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url || "/", `http://${AGENT_HOST}:${AGENT_PORT}`);

  if (req.method === "GET" && url.pathname === "/health") {
    const body: HealthResponse = {
      running: true,
      version: options?.version ?? "0.0.0",
      paired: isPaired(),
      pendingPairing: Boolean(getPendingPairingCode()),
    };
    json(res, 200, body);
    return;
  }

  if (req.method === "GET" && url.pathname === "/status") {
    if (!verifyBearerToken(req.headers.authorization)) {
      json(res, 401, { error: "unauthorized" });
      return;
    }
    json(res, 200, getStatusSnapshot());
    return;
  }

  if (req.method === "POST" && url.pathname === "/pair/confirm") {
    await handlePairConfirm(req, res);
    return;
  }

  if (req.method === "POST" && url.pathname === "/unpair") {
    handleUnpair(req, res);
    return;
  }

  json(res, 404, { error: "not_found" });
};

const handleRequest = (req: IncomingMessage, res: ServerResponse): void => {
  void handleRequestAsync(req, res).catch((error: unknown) => {
    if (error instanceof PairingError) {
      if (error.code === "code_mismatch" || error.code === "already_paired") {
        notifyStatus();
      }
      if (error.code === "code_mismatch") {
        json(res, 400, { error: "waiting_for_agent" });
        return;
      }
      json(res, error.status, { error: error.code, message: error.message });
      return;
    }
    json(res, 500, { error: "internal_error" });
  });
};

const attachWebSocket = (server: http.Server): WebSocketServer => {
  const sockets = new WebSocketServer({
    server,
    verifyClient: (info, done) => {
      if (info.origin && !isLocalOrigin(info.origin)) {
        done(false, 403, "origin not allowed");
        return;
      }
      if (!authorizeWsRequest(info.req)) {
        done(false, 401, "unauthorized");
        return;
      }
      done(true);
    },
  });

  sockets.on("connection", (socket) => {
    send(socket, {
      type: "agent.hello",
      payload: getStatusSnapshot(),
    });

    socket.on("message", (raw) => {
      try {
        const message = JSON.parse(String(raw)) as AgentMessage;
        if (!message?.type) {
          return;
        }

        if (message.type === "unpair") {
          clearAuth();
          notifyStatus();
          return;
        }

        if (message.type === "discover.start") {
          notifyStatus();
          void startDiscovery((progress) => {
            broadcast({ type: "discover.progress", payload: progress });
          })
            .then((printers) => {
              broadcast({ type: "discover.result", payload: { printers } });
              notifyStatus();
            })
            .catch((err: unknown) => {
              const errorMessage = err instanceof Error ? err.message : String(err);
              broadcast({
                type: "discover.result",
                payload: { printers: [], error: errorMessage },
              });
              notifyStatus();
            });

          send(socket, {
            type: "discover.start",
            id: message.id,
            payload: { ok: true },
          });
          return;
        }

        if (message.type === "discover.cancel") {
          cancelDiscovery();
          notifyStatus();
          send(socket, {
            type: "discover.cancel",
            id: message.id,
            payload: { ok: true },
          });
          return;
        }

        if (message.type === "printer.connect") {
          const payload = message.payload as
            | { ip?: string; port?: number; name?: string }
            | undefined;
          if (!payload?.ip) {
            send(socket, {
              type: "printer.connect",
              id: message.id,
              payload: { error: "ip_required" },
            });
            return;
          }

          void connectPrinter(payload.ip, payload.port, payload.name)
            .then((printer) => {
              broadcast({
                type: "printer.connection",
                payload: { connected: true, printer },
              });
              notifyStatus();
              send(socket, {
                type: "printer.connect",
                id: message.id,
                payload: { ok: true, printer },
              });
            })
            .catch((err: unknown) => {
              notifyStatus();
              send(socket, {
                type: "printer.connect",
                id: message.id,
                payload: {
                  error: err instanceof Error ? err.message : String(err),
                },
              });
            });
          return;
        }

        if (message.type === "printer.disconnect") {
          void disconnectPrinter().then(() => {
            broadcast({
              type: "printer.connection",
              payload: { connected: false, printer: null },
            });
            notifyStatus();
            send(socket, {
              type: "printer.disconnect",
              id: message.id,
              payload: { ok: true },
            });
          });
          return;
        }

        if (message.type === "printer.test") {
          void testPrinter()
            .then(() => {
              send(socket, {
                type: "printer.test",
                id: message.id,
                payload: { ok: true },
              });
            })
            .catch((err: unknown) => {
              send(socket, {
                type: "printer.test",
                id: message.id,
                payload: {
                  error: err instanceof Error ? err.message : String(err),
                },
              });
            });
          return;
        }

        if (message.type === "print") {
          const payload = message.payload as
            | {
                jobId?: string;
                type?: "kot" | "receipt";
                imageBase64?: string;
                paperWidth?: "58mm" | "80mm";
              }
            | undefined;

          if (!payload?.imageBase64) {
            send(socket, {
              type: "print",
              id: message.id,
              payload: { error: "imageBase64_required" },
            });
            return;
          }

          const jobId = payload.jobId || `job_${Date.now()}`;
          broadcast({
            type: "print.started",
            payload: { jobId, type: payload.type || "receipt" },
          });

          void printPngBase64(payload.imageBase64, {
            paperWidth: payload.paperWidth,
          })
            .then(() => {
              broadcast({
                type: "print.success",
                payload: { jobId, type: payload.type || "receipt" },
              });
              send(socket, {
                type: "print",
                id: message.id,
                payload: { ok: true, jobId },
              });
            })
            .catch((err: unknown) => {
              const errorMessage =
                err instanceof Error ? err.message : String(err);
              broadcast({
                type: "print.failed",
                payload: { jobId, error: errorMessage },
              });
              send(socket, {
                type: "print",
                id: message.id,
                payload: { error: errorMessage, jobId },
              });
            });
          return;
        }

        if (message.type === "config.get") {
          send(socket, {
            type: "config.get",
            id: message.id,
            payload: loadConfig(),
          });
          return;
        }

        if (message.type === "config.set") {
          const next = message.payload as Record<string, unknown> | undefined;
          const updated = saveConfig(next || {});
          broadcast({ type: "config.updated", payload: updated });
          send(socket, {
            type: "config.set",
            id: message.id,
            payload: { ok: true, config: updated },
          });
          return;
        }

        send(socket, {
          type: message.type,
          id: message.id,
          payload: { error: "not_implemented" },
        });
      } catch {
        // ignore malformed frames
      }
    });
  });

  return sockets;
};

const startHeartbeat = (): void => {
  heartbeat = setInterval(() => {
    if (!isPaired() && !getPendingPairingCode()) {
      notifyStatus();
      return;
    }
    if (!wss || wss.clients.size === 0) {
      return;
    }
    broadcast({
      type: "agent.heartbeat",
      payload: { ts: Date.now(), ...getStatusSnapshot() },
    });
  }, HEARTBEAT_INTERVAL_MS);
  heartbeat.unref();
};

export async function startServer(opts: ServerOptions): Promise<AgentStatusSnapshot> {
  if (httpServer?.listening) {
    return getStatusSnapshot();
  }

  const runtime: ServerOptions = {
    host: opts.host ?? AGENT_HOST,
    port: opts.port ?? AGENT_PORT,
    version: opts.version,
    userDataDir: opts.userDataDir,
  };
  options = runtime;
  initAuth(runtime.userDataDir);
  initConfigStore(runtime.userDataDir);
  restoreSavedPrinter();
  lastError = null;

  await new Promise<void>((resolve, reject) => {
    const server = http.createServer(handleRequest);
    const sockets = attachWebSocket(server);

    const onError = (error: NodeJS.ErrnoException) => {
      lastError =
        error.code === "EADDRINUSE"
          ? "The print service is already running"
          : error.message;
      server.close();
      reject(error);
    };

    server.once("error", onError);
    server.on("connection", (socket) => {
      openSockets.add(socket);
      socket.on("close", () => openSockets.delete(socket));
    });
    server.listen(runtime.port, runtime.host, () => {
      server.off("error", onError);
      httpServer = server;
      wss = sockets;
      startHeartbeat();
      resolve();
    });
  });

  return getStatusSnapshot();
}

export async function stopServer(): Promise<void> {
  if (heartbeat) {
    clearInterval(heartbeat);
    heartbeat = null;
  }

  if (wss) {
    for (const client of wss.clients) {
      client.terminate();
    }
    wss.close();
    wss = null;
  }

  for (const socket of openSockets) {
    socket.destroy();
  }
  openSockets.clear();

  if (httpServer) {
    const server = httpServer;
    httpServer = null;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 1000);
      server.close(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  lastError = null;
}

export function isServiceRunning(): boolean {
  return Boolean(httpServer?.listening);
}

export function unpairAgent(): AgentStatusSnapshot {
  clearAuth();
  return notifyStatus();
}


