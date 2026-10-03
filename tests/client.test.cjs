const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { test } = require("node:test");
const vm = require("node:vm");

const translations = import("../assets/translations.js");

function connectionClient(fetch) {
  let factory;
  const sockets = [];
  const timers = new Map();
  const events = {};
  let clock = 10000;
  let timerID = 0;
  class Socket {
    static OPEN = 1;
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      sockets.push(this);
    }
    addEventListener(name, callback) {
      this[name] = (event) => {
        if (name === "message") this.readyState = Socket.OPEN;
        callback(event);
      };
    }
    close() {
      this.closed = true;
    }
  }
  const context = vm.createContext({
    URL,
    AbortController,
    WebSocket: Socket,
    Date: { now: () => clock },
    location: { href: "https://example.com/?room=ROOM" },
    navigator: { onLine: true },
    document: {
      hidden: false,
      addEventListener(name, callback) {
        if (name === "alpine:init") callback();
        else events[name] = callback;
      },
    },
    window: {
      matchMedia: () => ({ matches: false, addEventListener() {} }),
      addEventListener: (name, callback) => {
        events[name] = callback;
      },
    },
    localStorage: { getItem: () => null, removeItem() {} },
    history: { replaceState() {} },
    setInterval() {},
    setTimeout: (callback, delay) => {
      timers.set(++timerID, { callback, delay });
      return timerID;
    },
    clearTimeout: (id) => timers.delete(id),
    fetch,
    Alpine: {
      data: (_name, value) => {
        factory = value;
      },
    },
  });
  vm.runInContext(readFileSync("assets/main.js", "utf8").replace(/^import .*;$/gm, ""), context);
  const app = factory();
  app.updateDocumentTheme = () => {};
  app.updateDocumentLanguage = () => {};
  app.apply = (snapshot) => {
    app.room = snapshot.room;
  };
  app.t = (message) => message;
  app.init();
  app.token = "saved-token";
  return {
    app,
    sockets,
    timers,
    events,
    context,
    advance: (ms) => {
      clock += ms;
    },
  };
}

test("socket starts without an HTTP preflight and waits for a live snapshot", () => {
  const { app, sockets, timers } = connectionClient(() => assert.fail("unexpected HTTP preflight"));
  app.connect();
  assert.equal(sockets.length, 1);
  assert.equal(String(sockets[0].url), "wss://example.com/api/live?token=saved-token");
  assert.equal(app.ready, false);
  sockets[0].message({ data: JSON.stringify({ kind: "heartbeat" }) });
  assert.equal(app.ready, false);
  assert.equal(timers.size, 1);
  sockets[0].message({ data: JSON.stringify({ kind: "state", snapshot: { room: { id: "ROOM" } } }) });
  assert.equal(app.ready, true);
  assert.equal(app.connection, "online");
  assert.equal(timers.size, 0);
});

test("stalled startup retries once without waiting for a slow session diagnostic", () => {
  const { app, sockets, timers } = connectionClient(() => new Promise(() => {}));
  app.connect();
  timers.get(app.connectTimer).callback();
  assert.equal(sockets[0].closed, true);
  assert.equal(app.connection, "offline");
  const retryID = app.retryTimer;
  sockets[0].onerror();
  sockets[0].onclose();
  assert.equal(app.retryTimer, retryID);
  assert.ok(timers.get(retryID).delay < 500);
  timers.get(retryID).callback();
  assert.equal(sockets.length, 2);
  sockets[0].message({ data: JSON.stringify({ kind: "state", snapshot: { room: { id: "OLD" } } }) });
  assert.equal(app.ready, false);
});

test("foreground events reconnect stale sockets and coalesce; offline cancels pending work", () => {
  const { app, sockets, events, context, advance, timers } = connectionClient(() => new Promise(() => {}));
  app.connect();
  sockets[0].message({ data: JSON.stringify({ kind: "state", snapshot: { room: { id: "ROOM" } } }) });
  advance(21000);
  events.visibilitychange();
  events.resume();
  events.pageshow({ persisted: true });
  events.focus();
  assert.equal(sockets.length, 2);
  assert.equal(sockets[0].closed, true);
  assert.equal(app.ready, false);
  context.navigator.onLine = false;
  events.offline();
  assert.equal(sockets[1].closed, true);
  assert.equal(timers.size, 0);
  app.connect();
  assert.equal(sockets.length, 2);
  context.navigator.onLine = true;
  events.online();
  assert.equal(sockets.length, 3);
});

test("short tab switches preserve a healthy connection", () => {
  const { app, sockets, events, advance } = connectionClient(() => assert.fail("unexpected diagnostic"));
  app.connect();
  sockets[0].message({ data: JSON.stringify({ kind: "state", snapshot: { room: { id: "ROOM" } } }) });
  advance(2000);
  events.visibilitychange();
  events.resume();
  events.pageshow({ persisted: true });
  events.focus();
  assert.equal(sockets.length, 1);
  assert.equal(sockets[0].closed, undefined);
  assert.equal(app.ready, true);
});

test("delayed foreground events and connect calls preserve a pending handshake until its deadline", () => {
  const { app, sockets, events, advance, timers } = connectionClient(() => assert.fail("unexpected diagnostic"));
  app.connect();
  const deadline = app.connectTimer;
  for (const elapsed of [1500, 2000, 4000]) {
    advance(elapsed);
    events.visibilitychange();
    events.resume();
    events.pageshow({ persisted: true });
    events.focus();
    app.connect();
    assert.equal(sockets.length, 1);
    assert.equal(sockets[0].closed, undefined);
    assert.equal(app.connectTimer, deadline);
    assert.ok(timers.has(deadline));
  }
  sockets[0].message({ data: JSON.stringify({ kind: "state", snapshot: { room: { id: "ROOM" } } }) });
  assert.equal(app.ready, true);
  assert.equal(timers.size, 0);
});

test("foreground recovery replaces an overdue attempt even if its timer was suspended", () => {
  const { app, sockets, events, advance } = connectionClient(() => assert.fail("unexpected diagnostic"));
  app.connect();
  advance(9000);
  events.visibilitychange();
  assert.equal(sockets.length, 2);
  assert.equal(sockets[0].closed, true);
  sockets[0].onclose();
  sockets[1].message({ data: JSON.stringify({ kind: "state", snapshot: { room: { id: "ROOM" } } }) });
  assert.equal(app.ready, true);
});

test("a delayed unauthorized diagnostic expires the session even after a socket retry", async () => {
  let resolve;
  const { app, sockets, timers } = connectionClient(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  app.connect();
  sockets[0].onerror();
  timers.get(app.retryTimer).callback();
  resolve({ status: 401, json: async () => ({ error: "Session expired" }) });
  await new Promise((done) => setImmediate(done));
  assert.equal(app.token, "");
  assert.equal(app.error, "Session expired");
  assert.equal(sockets[1].closed, true);
  assert.equal(timers.size, 0);
});

test("installed shell and scripts load from cache without waiting for the network", async () => {
  const events = {};
  const context = vm.createContext({
    URL,
    self: {
      location: { origin: "https://example.com" },
      addEventListener: (name, callback) => {
        events[name] = callback;
      },
    },
    caches: { match: async (request) => ({ cached: typeof request === "string" ? request : request.url }) },
    fetch: () => assert.fail("cached launch should not wait for fetch"),
  });
  vm.runInContext(readFileSync("assets/sw.js", "utf8"), context);
  for (const { path, mode, cached } of [
    { path: "/?room=ROOM", mode: "navigate", cached: "/" },
    { path: "/main.js", mode: "cors", cached: "https://example.com/main.js" },
  ]) {
    let response;
    events.fetch({
      request: { url: `https://example.com${path}`, method: "GET", mode },
      respondWith: (value) => {
        response = value;
      },
    });
    assert.equal((await response).cached, cached);
  }
  events.fetch({ request: { url: "https://example.com/api/session", method: "GET" }, respondWith: () => assert.fail("API must bypass shell cache") });
});

test("saved sessions restore for their room link or installed launch, leaving the browser homepage free", async () => {
  for (const { search, installed = false, restores } of [
    { search: "", restores: false },
    { search: "?room=", restores: false },
    { search: "?room=ROOM", restores: true },
    { search: "?room=room", restores: true },
    { search: "?room=OTHER", restores: false },
    { search: "", installed: true, restores: false },
    { search: "?resume=1", installed: true, restores: true },
    { search: "?resume=1&room=OTHER", installed: true, restores: false },
    { search: "?room=OTHER", installed: true, restores: false },
  ]) {
    let factory;
    let connections = 0;
    let joinBody;
    let replacedURL;
    const storage = new Map([
      ["bataq.name", "Deniz"],
      ["bataq.session", JSON.stringify({ token: "saved-token", room: "ROOM" })],
    ]);
    const context = vm.createContext({
      location: { href: `http://localhost/${search}` },
      URL,
      document: {
        addEventListener: (name, callback) => {
          if (name === "alpine:init") callback();
        },
      },
      window: {
        matchMedia: (query) => ({ matches: installed && query === "(display-mode: standalone)", addEventListener() {} }),
        addEventListener() {},
      },
      navigator: {},
      localStorage: {
        getItem: (key) => storage.get(key) ?? null,
        setItem: (key, value) => storage.set(key, value),
      },
      setInterval() {},
      history: {
        replaceState: (_state, _title, url) => {
          replacedURL = url;
        },
      },
      fetch: async (url, options) => {
        assert.equal(url, "/api/join");
        joinBody = JSON.parse(options.body);
        return { ok: true, json: async () => ({ token: "new-token", room: "NEW" }) };
      },
      Alpine: {
        data: (_name, value) => {
          factory = value;
        },
      },
    });
    vm.runInContext(readFileSync("assets/main.js", "utf8").replace(/^import .*;$/gm, ""), context);
    const app = factory();
    app.updateDocumentTheme = () => {};
    app.updateDocumentLanguage = () => {};
    app.connect = () => {
      connections++;
    };
    app.init();
    assert.equal(app.name, "Deniz", search);
    assert.equal(app.restoring, restores, search);
    assert.equal(app.token, restores ? "saved-token" : "", search);
    assert.equal(connections, restores ? 1 : 0, search);
    assert.equal(JSON.parse(storage.get("bataq.session")).token, "saved-token", search);
    if (!search) {
      await app.join();
      assert.deepEqual(joinBody, { name: "Deniz", room: "" });
      assert.equal(app.token, "new-token");
      assert.equal(connections, 1);
      assert.equal(replacedURL, "/?room=NEW");
      assert.deepEqual(JSON.parse(storage.get("bataq.session")), { token: "new-token", room: "NEW" });
      assert.equal(app.error, "");
    }
  }
});

test("turn alerts fire for new turns and ignore reconnects and presence updates", () => {
  let factory;
  const vibrations = [];
  const context = vm.createContext({
    navigator: { vibrate: (duration) => vibrations.push(duration) },
    location: { href: "http://localhost/" },
    URL,
    document: { addEventListener: (_name, callback) => callback() },
    Alpine: {
      data: (_name, value) => {
        factory = value;
      },
    },
  });
  vm.runInContext(readFileSync("assets/main.js", "utf8").replace(/^import .*;$/gm, ""), context);
  const app = factory();
  app.you = 0;
  for (const entry of [
    { ready: false, turn: 0, phase: "bidding", revision: 1, count: 0 },
    { ready: true, turn: 0, phase: "bidding", revision: 1, count: 1 },
    { ready: true, turn: 0, phase: "bidding", revision: 1, count: 1 },
    { ready: false, turn: 0, phase: "bidding", revision: 1, count: 1 },
    { ready: true, turn: 0, phase: "bidding", revision: 1, count: 1 },
    { ready: true, turn: 1, phase: "bidding", revision: 2, count: 1 },
    { ready: true, turn: 0, phase: "trump", revision: 3, count: 2 },
    { ready: true, turn: 0, phase: "playing", revision: 4, count: 3 },
    { ready: true, turn: 0, phase: "trick", revision: 5, count: 3 },
    { ready: true, turn: 0, phase: "playing", revision: 6, count: 4 },
  ]) {
    app.ready = entry.ready;
    app.room = { id: "ROOM", round: 1, turn: entry.turn, phase: entry.phase, revision: entry.revision };
    app.notifyTurn();
    assert.equal(vibrations.length, entry.count, JSON.stringify(entry));
  }
  assert.ok(vibrations.every((duration) => duration === 45));
  delete context.navigator.vibrate;
  app.room.revision++;
  assert.doesNotThrow(() => app.notifyTurn());
});

test("browser language selects the first supported preference", async () => {
  const { browserLanguage } = await translations;
  for (const { languages, expected } of [
    { languages: ["tr-TR", "en-US"], expected: "tr" },
    { languages: ["TR"], expected: "tr" },
    { languages: ["en-GB", "tr-TR"], expected: "en" },
    { languages: ["de-DE", "tr-TR", "en-US"], expected: "tr" },
    { languages: ["fr-FR"], expected: "en" },
    { languages: [], expected: "en" },
  ]) {
    assert.equal(browserLanguage(languages), expected, languages.join(","));
  }
});

test("translations interpolate player data as text", async () => {
  const { translate } = await translations;
  assert.equal(translate("tr", "{name} won at {bid} tricks.", { name: "İpek", bid: 7 }), "İpek, 7 ile ihaleyi aldı.");
  assert.equal(translate("en", "{name} won at {bid} tricks.", { name: "Deniz", bid: 7 }), "Deniz won at 7 tricks.");
  assert.equal(translate("tr", "Unknown key"), "Unknown key");
  assert.equal(translate("tr", "{name} wins!", { name: "<script>" }), "<script> kazandı!");
});

test("every literal UI translation has a Turkish entry", async () => {
  const { TURKISH } = await translations;
  const sources = [readFileSync("assets/index.html", "utf8"), readFileSync("assets/main.js", "utf8")];
  for (const source of sources) {
    for (const [, key] of source.matchAll(/\bt\(['"]([^'"\n]+)['"]/g)) {
      assert.ok(Object.hasOwn(TURKISH, key), `Missing Turkish translation: ${key}`);
    }
  }
});

test("Turkish game state renders localized status, suits, and card labels", async () => {
  const { browserLanguage, translate } = await translations;
  let factory;
  const context = vm.createContext({
    browserLanguage,
    translate,
    navigator: { languages: ["tr-TR"] },
    location: { href: "http://localhost/", origin: "http://localhost" },
    URL,
    document: { addEventListener: (_name, callback) => callback() },
    Alpine: {
      data: (_name, value) => {
        factory = value;
      },
    },
  });
  const source = readFileSync("assets/main.js", "utf8").replace(/^import .*;$/gm, "");
  vm.runInContext(source, context);
  const app = factory();
  assert.equal(app.language, "tr");
  assert.equal(app.connectionLabel, "Oynamaya hazır");
  app.ready = true;
  app.you = 0;
  app.room = {
    phase: "trump",
    turn: 0,
    bidder: 0,
    highBid: 7,
    trump: -1,
    players: [{ name: "İpek", online: true, bot: false, bid: 7, tricks: 0 }],
  };
  assert.equal(app.statusTitle, "İhale senin. Kozu seç.");
  app.room.phase = "playing";
  app.room.trump = 1;
  assert.equal(app.trumpLabel, "♥ Kupa");
  assert.equal(app.statusTitle, "Sıra sende. Kartını oyna.");
  assert.equal(app.cardLabel({ suit: 1, rank: 14 }), "kupa As");
  assert.equal(app.playerDetail(app.room.players[0]), "0 / 7 el");
});
