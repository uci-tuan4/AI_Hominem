const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("aiHominem", {
  isDesktopApp: true,
  notifyFlag: (flag) => ipcRenderer.invoke("notify-flag", flag)
});
