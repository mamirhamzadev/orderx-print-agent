export type AgentCommandType =
  | "discover.start"
  | "discover.cancel"
  | "printer.connect"
  | "printer.disconnect"
  | "printer.test"
  | "config.get"
  | "config.set"
  | "print"
  | "unpair";

export type AgentEventType =
  | "agent.hello"
  | "agent.heartbeat"
  | "agent.status"
  | "discover.progress"
  | "discover.result"
  | "printer.connection"
  | "print.started"
  | "print.success"
  | "print.failed"
  | "config.updated";

export type AgentMessage<T = unknown> = {
  type: AgentCommandType | AgentEventType;
  payload?: T;
  id?: string;
};

export type PrinterInfo = {
  ip: string;
  port: number;
  name?: string;
};

export type AgentStatusSnapshot = {
  running: boolean;
  version: string;
  paired: boolean;
  discovering: boolean;
  printerConnected: boolean;
  printer: PrinterInfo | null;
  queue: number;
  lastError: string | null;
  host: string;
  port: number;
  clients: number;
  pendingPairing: boolean;
  shopId: string | null;
  pairingError: string | null;
  ts?: number;
};

export type HealthResponse = {
  running: boolean;
  version: string;
  paired: boolean;
  pendingPairing: boolean;
};

export type PairConfirmRequest = {
  code: string;
  shopId: string;
};

export type PairConfirmResponse = {
  token: string;
  shopId: string;
  port: number;
};

export type PairErrorResponse = {
  error: string;
  message?: string;
};

export type PrintJobType = "kot" | "receipt";

export type PrintCommandPayload = {
  jobId: string;
  type: PrintJobType;
  imageBase64: string;
  paperWidth?: "58mm" | "80mm";
};
