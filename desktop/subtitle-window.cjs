'use strict';
/*
 * Bilingual subtitle overlay window (Windows + macOS share this module).
 *
 * Contract:
 *   createSubtitleWindow({BrowserWindow, screen, ipcMain, owner, origin})
 *     -> {show(), update({original,translation,status,language}), hide(), destroy()}
 *
 * Design notes:
 * - The window is frameless, always-on-top, draggable and resizable by the user.
 * - It sits bottom-centre of the owner's display and never steals focus
 *   (showInactive). On macOS it is allowed onto every Space / full-screen app.
 * - It loads only the sibling subtitle.html with subtitle-preload.cjs;
 *   contextIsolation on, sandbox on, nodeIntegration off.
 * - Renderer receives text over the single 'subtitle:update' channel; the latest
 *   payload is replayed on every did-finish-load so a late load never shows stale
 *   or empty content.
 * - Two renderer-initiated channels only: 'subtitle:hide' and 'subtitle:owner'.
 *   Both are validated so the sender must be this window's own webContents.
 * - No token, no server capability and no classroom data cross this boundary.
 * - Click-through is deliberately NOT implemented so the controls stay reachable.
 */

const path = require('node:path');

// Guard: keep payloads bounded so a runaway transcript cannot overflow the overlay.
const MAX_CHARS = 1200;
// Guard: the owner must have handed over its own live window object.
const MIN_SIZE = {width: 480, height: 120};
const DEFAULT_SIZE = {width: 900, height: 168};
const BOTTOM_MARGIN = 72;

function cleanText(value) {
  if (typeof value !== 'string') return '';
  // Collapse whitespace and hard-trim so a single long segment cannot push the
  // layout apart; the remainder is reported as truncated by the renderer.
  return value.replace(/\s+/g, ' ').trim().slice(0, MAX_CHARS);
}

function normaliseLanguage(value) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, 32);
}

function normaliseStatus(value) {
  if (typeof value !== 'string') return 'idle';
  return value.replace(/\s+/g, ' ').trim().slice(0, 80) || 'idle';
}

function createSubtitleWindow({BrowserWindow, screen, ipcMain, owner, origin}) {
  if (!BrowserWindow || typeof BrowserWindow !== 'function') throw new Error('createSubtitleWindow requires BrowserWindow');
  if (!screen || typeof screen.getDisplayMatching !== 'function') throw new Error('createSubtitleWindow requires screen');
  if (!ipcMain || typeof ipcMain.handle !== 'function' || typeof ipcMain.on !== 'function') throw new Error('createSubtitleWindow requires ipcMain');
  if (!owner || typeof owner.isDestroyed !== 'function') throw new Error('createSubtitleWindow requires a live owner window');

  const preloadPath = path.join(__dirname, 'subtitle-preload.cjs');
  const htmlPath = path.join(__dirname, 'subtitle.html');

  let win = null;
  let destroyed = false;
  // The most recent payload, replayed after each (re)load of the overlay.
  let latest = {original: '', translation: '', status: 'idle', language: ''};
  let ownerDestroyed = false;

  function ownerAlive() {
    if (ownerDestroyed) return false;
    try {
      return !owner.isDestroyed();
    } catch {
      return false;
    }
  }

  // Resolve the display the classroom window currently occupies so the overlay
  // lands under the right monitor instead of the primary one.
  function targetDisplay() {
    try {
      const bounds = owner.getBounds();
      return screen.getDisplayMatching(bounds);
    } catch {
      return screen.getPrimaryDisplay();
    }
  }

  // Centre the overlay along the bottom of `display`, preserving whatever size
  // the user has resized it to.
  function placeBottomCentre(display) {
    if (!win || win.isDestroyed()) return;
    const area = display && display.workArea ? display.workArea : {x: 0, y: 0, width: DEFAULT_SIZE.width, height: DEFAULT_SIZE.height};
    let width = DEFAULT_SIZE.width;
    let height = DEFAULT_SIZE.height;
    try {
      const current = win.getBounds();
      if (current && current.width) width = current.width;
      if (current && current.height) height = current.height;
    } catch { /* first placement keeps defaults */ }
    const x = Math.round(area.x + (area.width - width) / 2);
    const y = Math.round(area.y + area.height - height - BOTTOM_MARGIN);
    win.setBounds({x, y, width, height});
  }

  function isOverlaySender(event) {
    if (!win || win.isDestroyed()) return false;
    if (!event || !event.sender) return false;
    return event.sender === win.webContents;
  }

  function sendLatest() {
    if (!win || win.isDestroyed()) return;
    win.webContents.send('subtitle:update', latest);
  }

  function ensureWindow() {
    if (destroyed) throw new Error('Subtitle window has been destroyed');
    if (win && !win.isDestroyed()) return win;

    win = new BrowserWindow({
      width: DEFAULT_SIZE.width,
      height: DEFAULT_SIZE.height,
      minWidth: MIN_SIZE.width,
      minHeight: MIN_SIZE.height,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      resizable: true,
      movable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      show: false,
      alwaysOnTop: true,
      // Keep it out of the classroom window's own stacking order.
      hasShadow: false,
      // On macOS this is what lets the overlay follow across Spaces and full-screen apps.
      ...(process.platform === 'darwin' ? {type: 'panel'} : {}),
      webPreferences: {
        preload: preloadPath,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        backgroundThrottling: false
      }
    });

    win.setAlwaysOnTop(true, 'screen-saver');
    if (process.platform === 'darwin') {
      win.setVisibleOnAllWorkspaces(true, {visibleOnFullScreen: true});
    }
    // The overlay has no application chrome of its own.
    win.setMenuBarVisibility(false);

    // Replay the newest text whenever the document finishes (re)loading.
    win.webContents.on('did-finish-load', () => sendLatest());

    // The overlay never navigates away from its own local document.
    win.webContents.setWindowOpenHandler(() => ({action: 'deny'}));
    win.webContents.on('will-navigate', event => event.preventDefault());

    // Closing the overlay only hides it; the lesson keeps running.
    win.on('close', event => {
      if (destroyed) return;
      event.preventDefault();
      win.hide();
    });
    win.on('closed', () => { win = null; });

    placeBottomCentre(targetDisplay());
    win.loadFile(htmlPath);
    return win;
  }

  function show() {
    const target = ensureWindow();
    placeBottomCentre(targetDisplay());
    // showInactive keeps the classroom window focused while the overlay appears.
    target.showInactive();
    // Keep subtitles above full-screen video as well as ordinary application windows.
    target.setAlwaysOnTop(true, 'screen-saver');
    return {shown: true};
  }

  function update(payload) {
    const next = payload && typeof payload === 'object' ? payload : {};
    latest = {
      original: cleanText(next.original),
      translation: cleanText(next.translation),
      status: normaliseStatus(next.status),
      language: normaliseLanguage(next.language)
    };
    sendLatest();
    return {applied: true};
  }

  function hide() {
    if (win && !win.isDestroyed()) win.hide();
    return {hidden: true};
  }

  function destroy() {
    if (destroyed) return {destroyed: true};
    destroyed = true;
    unmount();
    if (win && !win.isDestroyed()) {
      const target = win;
      win = null;
      target.destroy();
    }
    win = null;
    return {destroyed: true};
  }

  // --- renderer -> main channels -------------------------------------------
  const onHide = event => {
    if (!isOverlaySender(event)) return;
    hide();
  };
  const onOwner = event => {
    if (!isOverlaySender(event)) return;
    if (ownerAlive() && typeof owner.show === 'function') {
      owner.show();
      owner.focus();
    }
  };
  ipcMain.on('subtitle:hide', onHide);
  ipcMain.on('subtitle:owner', onOwner);

  function unmount() {
    ipcMain.removeListener('subtitle:hide', onHide);
    ipcMain.removeListener('subtitle:owner', onOwner);
    // Detach regardless of the owner's liveness — a dead owner still holds the
    // listener registration until we drop it.
    if (typeof owner.removeListener === 'function') owner.removeListener('closed', onOwnerClosed);
  }

  // Owner lifetime: when the classroom window really goes away, so does the overlay.
  function onOwnerClosed() {
    ownerDestroyed = true;
    destroy();
  }
  if (typeof owner.once === 'function') owner.once('closed', onOwnerClosed);

  return {show, update, hide, destroy};
}

module.exports = {createSubtitleWindow, MAX_CHARS};
