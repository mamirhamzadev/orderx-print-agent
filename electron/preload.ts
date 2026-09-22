import { contextBridge, ipcRenderer } from "electron";
import type { AgentStatusSnapshot } from "../service/protocol";

export type PrintAgentBridge = {
  getStatus: () => Promise<AgentStatusSnapshot>;
  setPendingCode: (code: string) => Promise<AgentStatusSnapshot>;
  unpair: () => Promise<AgentStatusSnapshot>;
  onStatus: (listener: (status: AgentStatusSnapshot) => void) => () => void;
};

const printAgent: PrintAgentBridge = {
  getStatus: () => ipcRenderer.invoke("agent:getStatus"),
  setPendingCode: (code: string) =>
    ipcRenderer.invoke("agent:setPendingCode", code),
  unpair: () => ipcRenderer.invoke("agent:unpair"),
  onStatus: (listener) => {
    const wrapped = (_event: unknown, status: AgentStatusSnapshot) => {
      listener(status);
    };
    ipcRenderer.on("agent:status", wrapped);
    return () => {
      ipcRenderer.removeListener("agent:status", wrapped);
    };
  },
};

contextBridge.exposeInMainWorld("printAgent", printAgent);
