import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("opencorpo", {
  chat: (messages) => ipcRenderer.invoke("ai:chat", messages),
  daemon: {
    getStatus: () => ipcRenderer.invoke("daemon:get-status"),
    restart: () => ipcRenderer.invoke("daemon:restart"),
    getRuntimeConfig: () => ipcRenderer.invoke("daemon:get-runtime-config"),
    openRuntimeFolder: () => ipcRenderer.invoke("daemon:open-runtime-folder")
  }
});
