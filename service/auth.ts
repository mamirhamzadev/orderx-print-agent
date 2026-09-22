import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import fs from "node:fs";
import path from "node:path";
import {
  AGENT_HOST,
  AGENT_PORT,
  PAIRING_CODE_MAX,
  PAIRING_CODE_MIN,
  PAIRING_TTL_MS,
} from "./constants";

export type AuthRecord = {
  token: string;
  shopId: string;
  pairedAt: string;
};

type PendingPair = {
  code: string;
  createdAt: number;
};

export class PairingError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

let userDataDir = "";
let pending: PendingPair | null = null;
let pairingError: string | null = null;

export function initAuth(dir: string): void {
  userDataDir = dir;
  fs.mkdirSync(userDataDir, { recursive: true });
}

function authPath(): string {
  if (!userDataDir) {
    throw new Error("Auth store is not initialized");
  }
  return path.join(userDataDir, "agent-auth.json");
}

export function loadAuth(): AuthRecord | null {
  if (!userDataDir) {
    return null;
  }
  try {
    const data = JSON.parse(fs.readFileSync(authPath(), "utf8")) as AuthRecord;
    if (data?.token && data?.shopId) {
      return data;
    }
  } catch {
    // no token yet
  }
  return null;
}

export function saveAuth(record: AuthRecord): AuthRecord {
  fs.writeFileSync(authPath(), `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return record;
}

export function clearAuth(): void {
  pending = null;
  pairingError = null;
  if (!userDataDir) {
    return;
  }
  try {
    fs.writeFileSync(authPath(), "{}\n", "utf8");
    fs.unlinkSync(authPath());
  } catch {
    try {
      fs.writeFileSync(authPath(), "{}\n", "utf8");
    } catch {
      // ignore
    }
  }
}

export function isPaired(): boolean {
  return loadAuth() !== null;
}

export function normalizePairingCode(code: string): string {
  return code.trim().toUpperCase();
}

export function isValidPairingCode(code: string): boolean {
  const value = normalizePairingCode(code);
  return (
    value.length >= PAIRING_CODE_MIN &&
    value.length <= PAIRING_CODE_MAX &&
    /^[A-Z0-9]+$/.test(value)
  );
}

export function setPendingPairingCode(code: string): string {
  if (isPaired()) {
    throw new Error("Already paired. Unpair before entering a new code.");
  }
  const value = normalizePairingCode(code);
  if (!isValidPairingCode(value)) {
    throw new Error(
      `Pairing code must be ${PAIRING_CODE_MIN}–${PAIRING_CODE_MAX} letters or numbers`,
    );
  }
  pairingError = null;
  pending = { code: value, createdAt: Date.now() };
  return value;
}

export function getPendingPairingCode(): string | null {
  if (!pending) {
    return null;
  }
  if (Date.now() - pending.createdAt > PAIRING_TTL_MS) {
    pending = null;
    return null;
  }
  return pending.code;
}

export function getPairingError(): string | null {
  return pairingError;
}

export function clearPendingPairingCode(): void {
  pending = null;
}

export function tokensMatch(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}

export function verifyBearerToken(header?: string): AuthRecord | null {
  if (!header?.startsWith("Bearer ")) {
    return null;
  }
  const token = header.slice("Bearer ".length).trim();
  return verifyAccessToken(token);
}

export function verifyAccessToken(
  token: string,
  shopId?: string,
): AuthRecord | null {
  const auth = loadAuth();
  if (!auth || !token || !tokensMatch(auth.token, token)) {
    return null;
  }
  if (shopId && auth.shopId !== shopId) {
    return null;
  }
  return auth;
}

export function authorizeWsRequest(req: IncomingMessage): AuthRecord | null {
  const host = req.headers.host || `${AGENT_HOST}:${AGENT_PORT}`;
  let url: URL;
  try {
    url = new URL(req.url || "/", `http://${host}`);
  } catch {
    return null;
  }
  const headerToken = req.headers.authorization?.startsWith("Bearer ")
    ? req.headers.authorization.slice("Bearer ".length).trim()
    : "";
  const token = (url.searchParams.get("token") || headerToken).trim();
  const shopId = (url.searchParams.get("shopId") || "").trim();
  return verifyAccessToken(token, shopId || undefined);
}

export function completePairing(code: string, shopId: string): AuthRecord {
  const trimmedShopId = shopId.trim();
  if (!trimmedShopId) {
    throw new PairingError(400, "invalid_shop", "shopId is required");
  }
  if (!isValidPairingCode(code)) {
    throw new PairingError(400, "invalid_code", "Pairing code is invalid");
  }

  const existing = loadAuth();
  const normalized = normalizePairingCode(code);
  if (existing) {
    if (existing.shopId === trimmedShopId) {
      clearPendingPairingCode();
      return existing;
    }
    pairingError = "This agent is already paired. Unpair first.";
    throw new PairingError(
      409,
      "already_paired",
      pairingError,
    );
  }

  const pendingCode = getPendingPairingCode();
  if (!pendingCode) {
    throw new PairingError(
      400,
      "waiting_for_agent",
      "Enter the code in the Print Agent first",
    );
  }
  if (pendingCode !== normalized) {
    pairingError = "Wrong code. Check Printer Settings and try again.";
    clearPendingPairingCode();
    throw new PairingError(
      400,
      "code_mismatch",
      pairingError,
    );
  }

  pairingError = null;
  const record: AuthRecord = {
    token: randomBytes(32).toString("base64url"),
    shopId: trimmedShopId,
    pairedAt: new Date().toISOString(),
  };
  saveAuth(record);
  clearPendingPairingCode();
  return record;
}
