const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('desktopSetup',{
  installOllama:()=>ipcRenderer.invoke('lecture:install-ollama'),
  progress:()=>ipcRenderer.invoke('lecture:setup-progress'),
  platform:()=>ipcRenderer.invoke('lecture:platform'),
  requestMicrophone:()=>ipcRenderer.invoke('lecture:microphone')
});
