'use strict';
/*
 * Tests for the bilingual subtitle overlay module.
 *
 * These run on plain Node (no Electron binary) by injecting hand-rolled fakes for
 * BrowserWindow / screen / ipcMain, which is exactly the surface the module
 * declares in its contract. Everything asserted here is therefore about the
 * module's own behaviour, not about Electron internals.
 *
 * Run: node --test tests/subtitle-window.test.cjs
 */

const {test} = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {createSubtitleWindow, MAX_CHARS} = require('../desktop/subtitle-window.cjs');

// --- fakes ----------------------------------------------------------------

function makeEventEmitter() {
  const handlers = new Map();
  // Node/Electron wrap once() listeners so that removeListener(original) still
  // works; mirror that here or the module's cleanup cannot be exercised.
  const originals = new Map();
  return {
    on(channel, fn) {
      if (!handlers.has(channel)) handlers.set(channel, []);
      handlers.get(channel).push(fn);
      originals.set(fn, fn);
    },
    once(channel, fn) {
      const wrapped = (...args) => {
        this.removeListener(channel, wrapped);
        fn(...args);
      };
      if (!handlers.has(channel)) handlers.set(channel, []);
      handlers.get(channel).push(wrapped);
      originals.set(wrapped, fn);
    },
    removeListener(channel, fn) {
      const list = handlers.get(channel);
      if (!list) return;
      for (let i = list.length - 1; i >= 0; i--) {
        if (list[i] === fn || originals.get(list[i]) === fn) list.splice(i, 1);
      }
    },
    emit(channel, ...args) {
      for (const fn of [...(handlers.get(channel) || [])]) fn(...args);
    },
    count(channel) {
      return (handlers.get(channel) || []).length;
    }
  };
}

const created = [];

function makeBrowserWindow(options) {
  const emitter = makeEventEmitter();
  const sent = [];
  const calls = {
    showInactive: 0, show: 0, focus: 0, hide: 0, destroy: 0,
    alwaysOnTop: [], visibleOnAllWorkspaces: [], setBounds: [], loads: [],
    windowOpenHandlers: 0, willNavigate: 0, closePrevented: 0
  };
  let destroyed = false;
  let visible = false;
  let bounds = {x: options.x || 0, y: options.y || 0, width: options.width, height: options.height};

  const win = {
    options,
    webContents: Object.assign(makeEventEmitter(), {
      send(channel, payload) { sent.push({channel, payload}); },
      setWindowOpenHandler(handler) { calls.windowOpenHandlers++; win._openHandler = handler; }
    }),
    _sent: sent,
    _calls: calls,
    _emit: emitter.emit.bind(emitter),
    _handlerCount: emitter.count.bind(emitter),
    isDestroyed() { return destroyed; },
    getBounds() { return bounds; },
    setBounds(next) { calls.setBounds.push(next); bounds = {...bounds, ...next}; },
    setAlwaysOnTop(flag, level) { calls.alwaysOnTop.push({flag, level}); },
    setVisibleOnAllWorkspaces(flag, opts) { calls.visibleOnAllWorkspaces.push({flag, opts}); },
    setMenuBarVisibility() {},
    showInactive() { calls.showInactive++; visible = true; },
    show() { calls.show++; visible = true; },
    focus() { calls.focus++; },
    hide() { calls.hide++; visible = false; },
    destroy() { calls.destroy++; destroyed = true; emitter.emit('closed'); },
    isVisible() { return visible; },
    loadFile(file) { calls.loads.push(file); return Promise.resolve(); },
    on: emitter.on.bind(emitter),
    once: emitter.once.bind(emitter),
    removeListener: emitter.removeListener.bind(emitter)
  };
  created.push(win);
  return win;
}

function makeScreen(workArea = {x: 0, y: 0, width: 1920, height: 1080}) {
  return {
    _workArea: workArea,
    getPrimaryDisplay() { return {workArea: this._workArea}; },
    getDisplayMatching() { return {workArea: this._workArea}; }
  };
}

function makeIpcMain() {
  const emitter = makeEventEmitter();
  return {
    _emit: emitter.emit.bind(emitter),
    _count: emitter.count.bind(emitter),
    on: emitter.on.bind(emitter),
    once: emitter.once.bind(emitter),
    removeListener: emitter.removeListener.bind(emitter),
    handle() {}
  };
}

function makeOwner(overrides = {}) {
  const emitter = makeEventEmitter();
  let destroyed = false;
  return Object.assign({
    _emit: emitter.emit.bind(emitter),
    _count: emitter.count.bind(emitter),
    on: emitter.on.bind(emitter),
    once: emitter.once.bind(emitter),
    removeListener: emitter.removeListener.bind(emitter),
    isDestroyed() { return destroyed; },
    getBounds() { return {x: 100, y: 100, width: 1400, height: 900}; },
    show() { this._shown = (this._shown || 0) + 1; },
    focus() { this._focused = (this._focused || 0) + 1; },
    _kill() { destroyed = true; emitter.emit('closed'); }
  }, overrides);
}

function setup(env = {}) {
  created.length = 0;
  const ipcMain = makeIpcMain();
  const owner = env.owner || makeOwner();
  const screen = env.screen || makeScreen();
  const api = createSubtitleWindow({BrowserWindow: makeBrowserWindow, screen, ipcMain, owner, origin: 'http://127.0.0.1:8766'});
  return {api, ipcMain, owner, screen, overlay: () => created[created.length - 1]};
}

// --- contract / options ---------------------------------------------------

test('show builds a frameless always-on-top overlay that never steals focus', () => {
  const {api, overlay} = setup();
  api.show();
  const win = overlay();
  assert.equal(win.options.frame, false, 'must be frameless');
  assert.equal(win.options.resizable, true, 'must be user resizable');
  assert.equal(win.options.movable, true, 'must be user draggable');
  assert.equal(win.options.skipTaskbar, true);
  assert.equal(win._calls.alwaysOnTop[0].flag, true, 'must be always-on-top');
  assert.equal(win._calls.showInactive, 1, 'must use showInactive so focus stays in class');
  assert.equal(win._calls.show, 0, 'must not call show()');
  assert.ok(win._calls.loads[0].endsWith('subtitle.html'), 'loads its own document');
});

test('webPreferences keep the overlay isolated and powerless', () => {
  const {api, overlay} = setup();
  api.show();
  const prefs = overlay().options.webPreferences;
  assert.equal(prefs.contextIsolation, true);
  assert.equal(prefs.sandbox, true);
  assert.equal(prefs.nodeIntegration, false);
  assert.ok(prefs.preload.endsWith(path.join('desktop', 'subtitle-preload.cjs')));
});

test('the overlay is placed bottom-centre of the owner display work area', () => {
  const screen = makeScreen({x: 0, y: 0, width: 1920, height: 1080});
  const {api, overlay} = setup({screen});
  api.show();
  const placed = overlay()._calls.setBounds[0];
  assert.equal(placed.x + placed.width / 2, 1920 / 2, 'horizontally centred');
  assert.ok(placed.y + placed.height < 1080, 'sits inside the work area');
  assert.ok(placed.y > 1080 / 2, 'sits in the lower half');
});

test('repeated show() reuses the same window instead of stacking new ones', () => {
  const {api, overlay} = setup();
  api.show();
  const first = overlay();
  api.show();
  assert.equal(overlay(), first, 'same instance');
  assert.equal(first._calls.showInactive, 2, 're-shown');
});

test('the overlay follows the display that hosts the classroom window', () => {
  const screen = makeScreen({x: 0, y: 0, width: 1920, height: 1080});
  let asked = null;
  screen.getDisplayMatching = bounds => { asked = bounds; return {workArea: {x: 1920, y: 0, width: 1280, height: 800}}; };
  const owner = makeOwner({getBounds: () => ({x: 2000, y: 50, width: 1200, height: 800})});
  const {api, overlay} = setup({screen, owner});
  api.show();
  assert.deepEqual(asked, {x: 2000, y: 50, width: 1200, height: 800});
  const placed = overlay()._calls.setBounds[0];
  assert.ok(placed.x >= 1920, 'lands on the secondary display');
  assert.ok(placed.x + placed.width / 2 > 1920 && placed.x + placed.width / 2 < 1920 + 1280 + 1);
});

// --- text updates ---------------------------------------------------------

test('update pushes text to the overlay on subtitle:update', () => {
  const {api, overlay} = setup();
  api.show();
  api.update({original: 'Opportunity cost is the next best alternative.', translation: '机会成本是次佳选择的价值。', status: 'translating', language: '英语 → 简体中文'});
  const push = overlay()._sent.filter(x => x.channel === 'subtitle:update').pop();
  assert.equal(push.payload.original, 'Opportunity cost is the next best alternative.');
  assert.equal(push.payload.translation, '机会成本是次佳选择的价值。');
  assert.equal(push.payload.status, 'translating');
  assert.equal(push.payload.language, '英语 → 简体中文');
});

test('update before show does not create a window and still caches payload', () => {
  const {api, overlay, ipcMain} = setup();
  api.update({original: 'held', translation: '暂存', status: 'listening'});
  assert.equal(created.length, 0, 'no window created by update()');

  api.show();
  const win = overlay();
  // Nothing can be painted before the document exists; the cached payload is
  // delivered as soon as the overlay finishes loading.
  assert.equal(win._sent.filter(x => x.channel === 'subtitle:update').length, 0);
  win.webContents.emit('did-finish-load');
  const push = win._sent.filter(x => x.channel === 'subtitle:update').pop();
  assert.equal(push.payload.original, 'held');
  assert.equal(push.payload.translation, '暂存');
  assert.equal(push.payload.status, 'listening');
  assert.equal(ipcMain._count('subtitle:hide'), 1, 'channels registered exactly once');
});

test('the newest payload is replayed after did-finish-load', () => {
  const {api, overlay} = setup();
  api.show();
  const win = overlay();
  api.update({original: 'first', translation: '第一', status: 'listening'});
  api.update({original: 'second', translation: '第二', status: 'recognising'});
  const before = win._sent.length;
  win.webContents.emit('did-finish-load');
  const replayed = win._sent.slice(before).filter(x => x.channel === 'subtitle:update');
  assert.equal(replayed.length, 1, 'replays exactly one payload');
  assert.equal(replayed[0].payload.original, 'second', 'replays the latest, not the first');
});

test('text is whitespace-collapsed and capped so it cannot overflow', () => {
  const {api, overlay} = setup();
  api.show();
  const long = 'x'.repeat(MAX_CHARS + 500);
  api.update({original: '  spaced   out\n\ntext  ', translation: long});
  const push = overlay()._sent.filter(x => x.channel === 'subtitle:update').pop();
  assert.equal(push.payload.original, 'spaced out text');
  assert.equal(push.payload.translation.length, MAX_CHARS);
});

test('custom bounded status text survives and non-strings are coerced safely', () => {
  const {api, overlay} = setup();
  api.show();
  api.update({original: 42, translation: null, status: 'bogus', language: {}});
  const push = overlay()._sent.filter(x => x.channel === 'subtitle:update').pop();
  assert.equal(push.payload.original, '');
  assert.equal(push.payload.translation, '');
  assert.equal(push.payload.status, 'bogus');
  assert.equal(push.payload.language, '');
});

test('update with no argument does not throw', () => {
  const {api} = setup();
  api.show();
  assert.doesNotThrow(() => api.update());
  assert.doesNotThrow(() => api.update(null));
});

// --- IPC sender validation ------------------------------------------------

test('subtitle:hide from the overlay hides but does not destroy the window', () => {
  const {api, ipcMain, overlay} = setup();
  api.show();
  const win = overlay();
  ipcMain._emit('subtitle:hide', {sender: win.webContents});
  assert.equal(win._calls.hide, 1);
  assert.equal(win._calls.destroy, 0, 'the lesson must keep running');
  assert.equal(win.isDestroyed(), false);
});

test('forged IPC from any other sender is rejected', () => {
  const {api, ipcMain, overlay, owner} = setup();
  api.show();
  const win = overlay();
  const foreign = makeEventEmitter();
  ipcMain._emit('subtitle:hide', {sender: foreign});
  ipcMain._emit('subtitle:owner', {sender: foreign});
  ipcMain._emit('subtitle:hide', {sender: null});
  ipcMain._emit('subtitle:hide', {});
  assert.equal(win._calls.hide, 0, 'foreign hide ignored');
  assert.equal(owner._shown || 0, 0, 'foreign focus ignored');
});

test('subtitle:owner surfaces the classroom window for its own overlay only', () => {
  const {api, ipcMain, overlay, owner} = setup();
  api.show();
  ipcMain._emit('subtitle:owner', {sender: overlay().webContents});
  assert.equal(owner._shown, 1);
  assert.equal(owner._focused, 1);
});

// --- close / hide / destroy ----------------------------------------------

test('closing the overlay only hides it', () => {
  const {api, overlay} = setup();
  api.show();
  const win = overlay();
  let prevented = false;
  win.on('close', () => {});
  // Simulate Electron's close flow: the module's own handler runs first and
  // calls preventDefault, so the window must remain alive.
  win._emit('close', {preventDefault() { prevented = true; }});
  assert.equal(prevented, true, 'close was prevented');
  assert.equal(win._calls.hide, 1, 'window hidden instead of closed');
  assert.equal(win.isDestroyed(), false);
});

test('hide is safe before show and after destroy', () => {
  const {api} = setup();
  assert.doesNotThrow(() => api.hide());
  api.show();
  api.hide();
  api.destroy();
  assert.doesNotThrow(() => api.hide());
});

test('destroy tears down the window, the channels and the owner listener', () => {
  const {api, ipcMain, overlay, owner} = setup();
  api.show();
  const win = overlay();
  assert.equal(ipcMain._count('subtitle:hide'), 1);
  assert.equal(owner._count('closed'), 1);

  api.destroy();
  assert.equal(win._calls.destroy, 1);
  assert.equal(ipcMain._count('subtitle:hide'), 0, 'hide listener removed');
  assert.equal(ipcMain._count('subtitle:owner'), 0, 'owner listener removed');
  assert.equal(owner._count('closed'), 0, 'owner listener removed');
});

test('destroy is idempotent and show after destroy throws', () => {
  const {api} = setup();
  api.show();
  api.destroy();
  assert.doesNotThrow(() => api.destroy());
  assert.throws(() => api.show(), /destroyed/i);
});

test('a destroyed window is rebuilt on the next show', () => {
  const {api, overlay} = setup();
  api.show();
  const first = overlay();
  first.destroy();               // e.g. renderer crashed
  api.show();
  const second = overlay();
  assert.notEqual(second, first, 'a fresh window is created');
  assert.equal(second.isDestroyed(), false);
});

// --- owner lifetime -------------------------------------------------------

test('destroying the owner destroys the overlay automatically', () => {
  const {api, owner, overlay} = setup();
  api.show();
  const win = overlay();
  owner._kill();
  assert.equal(win._calls.destroy, 1, 'overlay destroyed with its owner');
});

test('a destroyed owner can no longer be raised from the overlay', () => {
  const {api, ipcMain, overlay, owner} = setup();
  api.show();
  const win = overlay();
  owner._kill();
  ipcMain._emit('subtitle:owner', {sender: win.webContents});
  assert.equal(owner._shown || 0, 0, 'no focus attempt on a dead owner');
});

// --- navigation lockdown --------------------------------------------------

test('navigation and window-open are refused', () => {
  const {api, overlay} = setup();
  api.show();
  const win = overlay();
  assert.equal(win._calls.windowOpenHandlers, 1, 'a window-open handler is installed');
  assert.deepEqual(win._openHandler({url: 'https://evil.example'}), {action: 'deny'});

  let prevented = false;
  win.webContents.emit('will-navigate', {preventDefault() { prevented = true; }}, 'https://evil.example');
  assert.equal(prevented, true, 'navigation is blocked');
});

// --- argument validation --------------------------------------------------

test('missing collaborators are rejected with a clear error', () => {
  const ipcMain = makeIpcMain();
  const owner = makeOwner();
  const screen = makeScreen();
  assert.throws(() => createSubtitleWindow({screen, ipcMain, owner}), /BrowserWindow/);
  assert.throws(() => createSubtitleWindow({BrowserWindow: makeBrowserWindow, ipcMain, owner}), /screen/);
  assert.throws(() => createSubtitleWindow({BrowserWindow: makeBrowserWindow, screen, owner}), /ipcMain/);
  assert.throws(() => createSubtitleWindow({BrowserWindow: makeBrowserWindow, screen, ipcMain}), /owner/);
});
