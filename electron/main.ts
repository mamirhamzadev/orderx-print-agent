import path from "node:path";
import {
  app,
  BrowserWindow,
  Menu,
  Tray,
  ipcMain,
  nativeImage,
  type NativeImage,
} from "electron";
import {
  AGENT_HOST,
  AGENT_PORT,
  SERVICE_IDLE_STOP_MS,
} from "../service/constants";
import {
  initAuth,
  isPaired,
  isValidPairingCode,
  setPendingPairingCode,
} from "../service/auth";
import {
  getStatusSnapshot,
  isServiceRunning,
  onStatusChange,
  startServer,
  stopServer,
  unpairAgent,
} from "../service/server";
import type { AgentStatusSnapshot } from "../service/protocol";

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
let stoppingForQuit = false;
let idleStopTimer: NodeJS.Timeout | null = null;

const HIDDEN_LAUNCH_FLAG = "--hidden";

const startedHidden = (): boolean => process.argv.includes(HIDDEN_LAUNCH_FLAG);

const registerStartWithWindows = (): void => {
  if (process.platform !== "win32" || !app.isPackaged) {
    return;
  }
  app.setLoginItemSettings({
    openAtLogin: true,
    openAsHidden: true,
    args: [HIDDEN_LAUNCH_FLAG],
  });
};

const iconPath = path.join(__dirname, "../../assets/icon.png");

const loadIcon = (): NativeImage => {
  const image = nativeImage.createFromPath(iconPath);
  if (image.isEmpty()) {
    return nativeImage.createEmpty();
  }
  return image;
};

const loadTrayIcon = (): NativeImage => {
  const image = loadIcon();
  if (image.isEmpty()) {
    return image;
  }
  return image.resize({ width: 32, height: 32, quality: "best" });
};

const pushStatus = (status?: AgentStatusSnapshot): void => {
  const snapshot = status ?? getStatusSnapshot();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("agent:status", snapshot);
  }
  updateTrayMenu();
};

const startLocalService = async (): Promise<AgentStatusSnapshot> => {
  const status = await startServer({
    host: AGENT_HOST,
    port: AGENT_PORT,
    version: app.getVersion(),
    userDataDir: app.getPath("userData"),
  });
  pushStatus(status);
  return status;
};

const stopLocalService = async (): Promise<AgentStatusSnapshot> => {
  await stopServer();
  const status = getStatusSnapshot();
  pushStatus(status);
  return status;
};

const stopServiceIfIdle = (): void => {
  if (idleStopTimer) {
    clearTimeout(idleStopTimer);
  }
  idleStopTimer = setTimeout(() => {
    idleStopTimer = null;
    const snapshot = getStatusSnapshot();
    if (snapshot.paired || snapshot.pendingPairing || !isServiceRunning()) {
      return;
    }
    void stopLocalService();
  }, SERVICE_IDLE_STOP_MS);
};

const showWindow = (): void => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow(true);
    return;
  }
  mainWindow.setSkipTaskbar(false);
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.show();
  mainWindow.focus();
  mainWindow.setAlwaysOnTop(true);
  mainWindow.setAlwaysOnTop(false);
};

const updateTrayMenu = (): void => {
  if (!tray) {
    return;
  }
  const snapshot = getStatusSnapshot();
  tray.setToolTip(
    snapshot.paired
      ? "OrderX Print Agent — paired"
      : "OrderX Print Agent — not paired",
  );
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Open", click: () => showWindow() },
      { type: "separator" },
      {
        label: "Quit",
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]),
  );
};

const createTray = (): void => {
  tray = new Tray(loadTrayIcon());
  tray.on("click", () => showWindow());
  updateTrayMenu();
};

const createWindow = (visible: boolean): void => {
  mainWindow = new BrowserWindow({
    width: 440,
    height: 520,
    minWidth: 400,
    minHeight: 460,
    title: "OrderX Print Agent",
    icon: iconPath,
    show: visible,
    skipTaskbar: !visible,
    autoHideMenuBar: true,
    backgroundColor: "#F5F4F6",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.setMenuBarVisibility(false);
  void mainWindow.loadFile(path.join(__dirname, "../../ui/index.html"));

  mainWindow.on("close", (event) => {
    if (!quitting) {
      if (isPaired()) {
        event.preventDefault();
        mainWindow?.setSkipTaskbar(true);
        mainWindow?.hide();
      } else {
        quitting = true;
        app.quit();
      }
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
};

const registerIpc = (): void => {
  ipcMain.handle("agent:getStatus", () => getStatusSnapshot());

  ipcMain.handle("agent:setPendingCode", async (_event, code: string) => {
    if (isPaired()) {
      throw new Error("Already paired. Unpair before entering a new code.");
    }
    if (!isValidPairingCode(code)) {
      throw new Error("Enter a 6–8 character code from POS Settings");
    }
    setPendingPairingCode(code);
    await startLocalService();
    const status = getStatusSnapshot();
    pushStatus(status);
    return status;
  });

  ipcMain.handle("agent:unpair", async () => {
    unpairAgent();
    await new Promise((resolve) => setTimeout(resolve, SERVICE_IDLE_STOP_MS));
    return stopLocalService();
  });
};

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => showWindow());

  app.whenReady().then(async () => {
    app.setName("OrderX Print Agent");
    try {
      app.setAsDefaultProtocolClient("orderx-print-agent");
    } catch {}
    initAuth(app.getPath("userData"));
    registerIpc();
    onStatusChange((status) => {
      pushStatus(status);
    });

    try {
      await startLocalService();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      pushStatus({
        ...getStatusSnapshot(),
        lastError: message,
      });
    }

    createWindow(!startedHidden());

    try {
      createTray();
    } catch {}

    try {
      registerStartWithWindows();
    } catch {}
  });

  app.on("before-quit", (event) => {
    quitting = true;
    if (stoppingForQuit || !isServiceRunning()) {
      return;
    }
    event.preventDefault();
    stoppingForQuit = true;
    void stopLocalService().finally(() => {
      app.quit();
    });
  });

  app.on("window-all-closed", () => {
    // Keep running in the tray on Windows.
  });
}
