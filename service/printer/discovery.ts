import net from "node:net";
import os from "node:os";
import { exec } from "node:child_process";
import type { PrinterInfo } from "../protocol";
import { loadConfig } from "./configStore";

export type DiscoveryProgress = {
  scanned: number;
  total: number;
  found: PrinterInfo[];
};

type ProgressCallback = (progress: DiscoveryProgress) => void;

let discovering = false;
let cancelRequested = false;
const activeSockets = new Set<net.Socket>();

export function isDiscovering(): boolean {
  return discovering;
}

export function cancelDiscovery(): void {
  if (!discovering) return;
  cancelRequested = true;
  for (const socket of activeSockets) {
    try {
      socket.destroy();
    } catch {
      // ignore
    }
  }
  activeSockets.clear();
}

/**
 * Snappy TCP port probe with quick timeout.
 */
function probePort(
  ip: string,
  port = 9100,
  timeoutMs = 350,
): Promise<boolean> {
  return new Promise((resolve) => {
    if (cancelRequested) {
      resolve(false);
      return;
    }

    let socket: net.Socket | null = null;
    let timer: NodeJS.Timeout | null = null;
    let settled = false;

    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (socket) {
        activeSockets.delete(socket);
        socket.removeAllListeners();
        socket.destroy();
        socket = null;
      }
    };

    socket = net.createConnection({ host: ip, port });
    activeSockets.add(socket);

    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(false);
    }, timeoutMs);

    socket.on("connect", () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(true);
    });

    socket.on("error", () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(false);
    });
  });
}

/**
 * Fast OS ARP table scanner.
 * In Windows, 'arp -a' completes in ~30ms and lists all active LAN devices.
 */
function getArpTableIps(): Promise<string[]> {
  return new Promise((resolve) => {
    exec("arp -a", { timeout: 1500 }, (error, stdout) => {
      if (error || !stdout) {
        resolve([]);
        return;
      }
      const ips: string[] = [];
      const lines = stdout.split(/\r?\n/);
      const ipv4Regex = /\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/;

      for (const line of lines) {
        if (line.includes("255.255.255.255") || line.includes("224.0.0")) continue;
        const match = line.match(ipv4Regex);
        if (match) {
          const ip = match[1];
          const parts = ip.split(".").map(Number);
          if (
            (parts[0] === 192 && parts[1] === 168) ||
            parts[0] === 10 ||
            (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
          ) {
            if (parts[3] > 0 && parts[3] < 255) {
              ips.push(ip);
            }
          }
        }
      }
      resolve(Array.from(new Set(ips)));
    });
  });
}

/**
 * Collect local IPv4 subnet prefixes.
 * Also includes the subnet of the saved printer IP as a fallback
 * so VPNs or virtual adapters (WSL, Hyper-V) never hide the physical LAN.
 */
function getLocalSubnetPrefixes(): string[] {
  const prefixes = new Set<string>();
  const interfaces = os.networkInterfaces();

  for (const name of Object.keys(interfaces)) {
    const addresses = interfaces[name];
    if (!addresses) continue;
    for (const iface of addresses) {
      if (iface.family === "IPv4" && !iface.internal) {
        const parts = iface.address.split(".");
        if (parts.length === 4) {
          if (parts[0] === "169" && parts[1] === "254") continue;
          prefixes.add(`${parts[0]}.${parts[1]}.${parts[2]}`);
        }
      }
    }
  }

  // Fallback from saved printer config IP
  try {
    const savedConfig = loadConfig();
    if (savedConfig?.ip) {
      const parts = savedConfig.ip.trim().split(".");
      if (parts.length === 4) {
        prefixes.add(`${parts[0]}.${parts[1]}.${parts[2]}`);
      }
    }
  } catch {
    // ignore
  }

  return Array.from(prefixes);
}

/**
 * Smart IP ordering: checks common static printer ranges (.200-.254)
 * and DHCP pool ranges (.100-.199) before lower ranges.
 */
function getSmartOrderedSubnetIps(prefix: string): string[] {
  const highRange: string[] = []; // 200..254 (Common static printer range)
  const midRange: string[] = [];  // 100..199 (Common DHCP router pool)
  const lowRange: string[] = [];  // 2..99 (Common early static range)
  const gateway: string[] = [`${prefix}.1`];

  for (let i = 200; i <= 254; i++) highRange.push(`${prefix}.${i}`);
  for (let i = 100; i <= 199; i++) midRange.push(`${prefix}.${i}`);
  for (let i = 2; i <= 99; i++) lowRange.push(`${prefix}.${i}`);

  return [...highRange, ...midRange, ...lowRange, ...gateway];
}

/**
 * Ultra-fast multi-stage printer discovery.
 * - Stage 0: Instant probe of saved/known printer IP (< 50ms)
 * - Stage 1: Lightning Windows ARP table parallel probe (~100ms)
 * - Stage 2: Subnet sweep with 50 parallel workers for any remaining devices
 */
export async function startDiscovery(
  onProgress?: ProgressCallback,
): Promise<PrinterInfo[]> {
  if (discovering) {
    cancelDiscovery();
    await new Promise((r) => setTimeout(r, 80));
  }

  discovering = true;
  cancelRequested = false;
  activeSockets.clear();

  const found: PrinterInfo[] = [];
  const scannedIps = new Set<string>();

  const reportFound = (ip: string, port = 9100) => {
    if (cancelRequested) return;
    if (!found.some((p) => p.ip === ip && p.port === port)) {
      found.push({
        ip,
        port,
        name: `Thermal Printer (${ip})`,
      });
      if (onProgress) {
        onProgress({ scanned: scannedIps.size, total: 254, found: [...found] });
      }
    }
  };

  try {
    // -------------------------------------------------------------
    // STAGE 0: Instant Probe of Saved / Configured IP (< 50ms)
    // -------------------------------------------------------------
    const savedConfig = loadConfig();
    const knownIps = [
      savedConfig?.ip?.trim(),
    ].filter((ip): ip is string => Boolean(ip && ip.length > 6));

    if (knownIps.length > 0) {
      await Promise.all(
        knownIps.map(async (ip) => {
          scannedIps.add(ip);
          const isPrinter = await probePort(ip, savedConfig?.port || 9100, 350);
          if (isPrinter) {
            reportFound(ip, savedConfig?.port || 9100);
          }
        }),
      );
    }

    if (cancelRequested) return found;

    // -------------------------------------------------------------
    // STAGE 1: Windows ARP Table Fast-Scan (~50ms - 150ms)
    // Probes all active hardware devices in Windows ARP table in parallel!
    // -------------------------------------------------------------
    const arpIps = await getArpTableIps();
    const unprobedArpIps = arpIps.filter((ip) => !scannedIps.has(ip));

    if (unprobedArpIps.length > 0 && !cancelRequested) {
      await Promise.all(
        unprobedArpIps.map(async (ip) => {
          scannedIps.add(ip);
          const ok9100 = await probePort(ip, 9100, 350);
          if (ok9100) {
            reportFound(ip, 9100);
            return;
          }
          // Fallback check on port 9101
          const ok9101 = await probePort(ip, 9101, 200);
          if (ok9101) {
            reportFound(ip, 9101);
          }
        }),
      );
    }

    if (cancelRequested) return found;

    // -------------------------------------------------------------
    // STAGE 2: High-Speed Subnet Sweep (50 concurrent workers)
    // -------------------------------------------------------------
    const prefixes = getLocalSubnetPrefixes();
    const allSubnetIps: string[] = [];

    for (const prefix of prefixes) {
      const ordered = getSmartOrderedSubnetIps(prefix);
      for (const ip of ordered) {
        if (!scannedIps.has(ip)) {
          allSubnetIps.push(ip);
        }
      }
    }

    const total = scannedIps.size + allSubnetIps.length;
    let index = 0;
    const CONCURRENCY = 50;

    const worker = async () => {
      while (index < allSubnetIps.length && !cancelRequested) {
        const currentIndex = index++;
        const ip = allSubnetIps[currentIndex];
        scannedIps.add(ip);

        const isPrinter = await probePort(ip, 9100, 350);
        if (isPrinter) {
          reportFound(ip, 9100);
        }

        if (
          onProgress &&
          (isPrinter || scannedIps.size % 20 === 0)
        ) {
          onProgress({
            scanned: scannedIps.size,
            total,
            found: [...found],
          });
        }
      }
    };

    const workers: Promise<void>[] = [];
    const poolSize = Math.min(CONCURRENCY, allSubnetIps.length);
    for (let i = 0; i < poolSize; i++) {
      workers.push(worker());
    }

    await Promise.all(workers);

    if (onProgress) {
      onProgress({ scanned: total, total, found: [...found] });
    }
  } finally {
    discovering = false;
    cancelRequested = false;
    activeSockets.clear();
  }

  return found;
}
