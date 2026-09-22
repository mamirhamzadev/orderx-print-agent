import net from "node:net";
import type { PrinterInfo } from "../protocol";
import { loadConfig, saveConfig } from "./configStore";

let activePrinter: PrinterInfo | null = null;

export function isPrinterConnected(): boolean {
  return activePrinter !== null;
}

export function getActivePrinter(): PrinterInfo | null {
  return activePrinter ? { ...activePrinter } : null;
}

export function restoreSavedPrinter(): PrinterInfo | null {
  const cfg = loadConfig();
  if (cfg?.ip) {
    activePrinter = {
      ip: cfg.ip,
      port: cfg.port || 9100,
      name: cfg.name || `Thermal Printer (${cfg.ip})`,
    };
  } else {
    activePrinter = null;
  }
  return getActivePrinter();
}

export function verifyTcpConnection(
  ip: string,
  port = 9100,
  timeoutMs = 3000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: ip, port });
    let timer: NodeJS.Timeout | null = null;
    let finished = false;

    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      socket.removeAllListeners();
      socket.destroy();
    };

    timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      cleanup();
      reject(new Error(`Connection to printer at ${ip}:${port} timed out (${timeoutMs}ms)`));
    }, timeoutMs);

    socket.on("connect", () => {
      if (finished) return;
      finished = true;
      cleanup();
      resolve();
    });

    socket.on("error", (err) => {
      if (finished) return;
      finished = true;
      cleanup();
      reject(new Error(`Printer connection failed: ${err.message}`));
    });
  });
}

export async function connectPrinter(
  ip: string,
  port = 9100,
  name?: string,
): Promise<PrinterInfo> {
  const cleanIp = ip.trim();
  const cleanPort = Number(port) || 9100;
  if (!cleanIp) {
    throw new Error("Printer IP address is required");
  }

  await verifyTcpConnection(cleanIp, cleanPort);

  const printer: PrinterInfo = {
    ip: cleanIp,
    port: cleanPort,
    name: name?.trim() || `Thermal Printer (${cleanIp})`,
  };

  activePrinter = printer;
  saveConfig({
    ip: printer.ip,
    port: printer.port,
    name: printer.name,
  });

  return { ...printer };
}

export async function disconnectPrinter(): Promise<void> {
  activePrinter = null;
  saveConfig({
    ip: "",
    name: "",
  });
}

export function sendRawToPrinter(
  data: Buffer,
  ip = activePrinter?.ip,
  port = activePrinter?.port || 9100,
  timeoutMs = 5000,
): Promise<void> {
  if (!ip) {
    return Promise.reject(new Error("No printer IP provided"));
  }

  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: ip, port });
    let timer: NodeJS.Timeout | null = null;
    let finished = false;

    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      socket.removeAllListeners();
      socket.destroy();
    };

    timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      cleanup();
      reject(new Error(`Print transmission timed out (${timeoutMs}ms)`));
    }, timeoutMs);

    socket.on("connect", () => {
      socket.write(data, (writeErr) => {
        if (writeErr) {
          if (finished) return;
          finished = true;
          cleanup();
          reject(new Error(`Failed to write print data: ${writeErr.message}`));
          return;
        }
        // Graceful end
        socket.end(() => {
          if (finished) return;
          finished = true;
          cleanup();
          resolve();
        });
      });
    });

    socket.on("error", (err) => {
      if (finished) return;
      finished = true;
      cleanup();
      reject(new Error(`Socket error during print: ${err.message}`));
    });
  });
}

export async function testPrinter(): Promise<void> {
  if (!activePrinter) {
    throw new Error("No printer is currently connected");
  }

  const ESC = 0x1b;
  const GS = 0x1d;
  const LF = 0x0a;

  const init = Buffer.from([ESC, 0x40]); // ESC @
  const center = Buffer.from([ESC, 0x61, 0x01]); // ESC a 1
  const left = Buffer.from([ESC, 0x61, 0x00]); // ESC a 0
  const boldOn = Buffer.from([ESC, 0x45, 0x01]); // ESC E 1
  const boldOff = Buffer.from([ESC, 0x45, 0x00]); // ESC E 0

  const header = Buffer.from("OrderX Print Agent\n", "utf8");
  const subheader = Buffer.from("Connection Test Successful!\n", "utf8");
  const separator = Buffer.from("--------------------------------\n", "utf8");
  const info = Buffer.from(
    `Printer: ${activePrinter.name || activePrinter.ip}\n` +
    `IP: ${activePrinter.ip}:${activePrinter.port}\n` +
    `Date: ${new Date().toLocaleString()}\n`,
    "utf8",
  );
  const footer = Buffer.from("Ready to print receipts and KOTs.\n", "utf8");
  // Feed lines + Partial Cut (GS V 66 0)
  const cut = Buffer.from([LF, LF, LF, LF, GS, 0x56, 0x42, 0x00]);

  const payload = Buffer.concat([
    init,
    center,
    boldOn,
    header,
    boldOff,
    subheader,
    separator,
    left,
    info,
    center,
    separator,
    footer,
    cut,
  ]);

  await sendRawToPrinter(payload, activePrinter.ip, activePrinter.port);
}
