'use strict';
/*
 * Preload for the bilingual subtitle overlay.
 *
 * The overlay is deliberately powerless: it can render text it is given and ask
 * the main process to hide itself or raise the classroom window. It cannot reach
 * the local runtime, the session token, the filesystem or any network origin.
 */
const {contextBridge, ipcRenderer} = require('electron');

contextBridge.exposeInMainWorld('subtitleOverlay', {
  // Subscribe to text pushes from the main process. Returns an unsubscribe fn so
  // a reload cannot leave an orphaned listener behind.
  onUpdate: handler => {
    if (typeof handler !== 'function') return () => {};
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('subtitle:update', listener);
    return () => ipcRenderer.removeListener('subtitle:update', listener);
  },
  // Ask the main process to hide the overlay. The lesson is not stopped.
  hide: () => ipcRenderer.send('subtitle:hide'),
  // Ask the main process to surface the classroom window again.
  focusOwner: () => ipcRenderer.send('subtitle:owner')
});
