import fs from "node:fs";
import path from "node:path";

export type PaperWidth = "58mm" | "80mm";

export type AgentPrinterConfig = {
  ip: string;
  port: number;
  name?: string;
  paperWidth: PaperWidth;
  autoPrintOnOrderConfirm: boolean;
  autoPrintKOT: boolean;
};

export const defaultPrinterConfig = (): AgentPrinterConfig => ({
  ip: "",
  port: 9100,
  paperWidth: "80mm",
  autoPrintOnOrderConfirm: true,
  autoPrintKOT: true,
});

let userDataDir = "";
let config: AgentPrinterConfig = defaultPrinterConfig();

export function initConfigStore(dir: string): void {
  userDataDir = dir;
  try {
    fs.mkdirSync(userDataDir, { recursive: true });
  } catch {
    // directory may already exist
  }
  loadConfig();
}

function configPath(): string {
  if (!userDataDir) {
    return "";
  }
  return path.join(userDataDir, "printer-config.json");
}

export function loadConfig(): AgentPrinterConfig {
  const filePath = configPath();
  if (filePath && fs.existsSync(filePath)) {
    try {
      const data = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<AgentPrinterConfig>;
      config = { ...defaultPrinterConfig(), ...data };
    } catch {
      // ignore read/parse error
    }
  }
  return { ...config };
}

export function saveConfig(next: Partial<AgentPrinterConfig>): AgentPrinterConfig {
  config = { ...config, ...next };
  const filePath = configPath();
  if (filePath) {
    try {
      fs.writeFileSync(filePath, JSON.stringify(config, null, 2), "utf8");
    } catch {
      // ignore write error
    }
  }
  return { ...config };
}

