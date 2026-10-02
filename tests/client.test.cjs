const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { test } = require("node:test");
const vm = require("node:vm");

const translations = import("../assets/translations.js");

test("saved sessions restore only for their room link, leaving the homepage free to create a game", async () => {
  for (const { search, restores } of [
    { search: "", restores: false },
    { search: "?room=", restores: false },
    { search: "?room=ROOM", restores: true },
    { search: "?room=room", restores: true },
    { search: "?room=OTHER", restores: false },
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
        matchMedia: () => ({ matches: false, addEventListener() {} }),
        addEventListener() {},
      },
      navigator: {},
      localStorage: {
        getItem: (key) => storage.get(key) ?? null,
        setItem: (key, value) => storage.set(key, value),
      },
      setInterval() {},
      history: { replaceState: (_state, _title, url) => { replacedURL = url; } },
      fetch: async (url, options) => {
        assert.equal(url, "/api/join");
        joinBody = JSON.parse(options.body);
        return { ok: true, json: async () => ({ token: "new-token", room: "NEW" }) };
      },
      Alpine: { data: (_name, value) => { factory = value; } },
    });
    vm.runInContext(readFileSync("assets/main.js", "utf8").replace(/^import .*;$/gm, ""), context);
    const app = factory();
    app.updateDocumentTheme = () => {};
    app.updateDocumentLanguage = () => {};
    app.connect = () => { connections++; };
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
