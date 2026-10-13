const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('desktopSetup',{
  installOllama:()=>ipcRenderer.invoke('lecture:install-ollama'),
  progress:()=>ipcRenderer.invoke('lecture:setup-progress'),
  platform:()=>ipcRenderer.invoke('lecture:platform'),
  requestMicrophone:()=>ipcRenderer.invoke('lecture:microphone'),
  prepareSystemCapture:()=>ipcRenderer.invoke('lecture:system-capture'),
  finishSystemCaptureRequest:()=>ipcRenderer.invoke('lecture:system-capture-clear'),
  showSubtitles:()=>ipcRenderer.invoke('lecture:subtitles-show'),
  hideSubtitles:()=>ipcRenderer.invoke('lecture:subtitles-hide'),
  updateSubtitles:payload=>ipcRenderer.send('lecture:subtitles-update',payload)
});
