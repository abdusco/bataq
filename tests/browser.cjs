// Optional end-to-end verification. Runtime files have no npm dependencies.
// PLAYWRIGHT_MODULE=/path/to/playwright node tests/browser.cjs
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");

async function verify() {
  const browser = await chromium.launch({ headless: true });
  try {
    const desktop = await browser.newContext({
      viewport: { width: 1440, height: 1050 },
      colorScheme: "light",
    });
    const page = await desktop.newPage();
    await page.addInitScript(() => {
      window.turnAlerts = { vibrations: [], notes: 0 };
      Object.defineProperty(navigator, "vibrate", {
        value: (duration) => {
          window.turnAlerts.vibrations.push(duration);
          return true;
        },
      });
      const Audio = window.AudioContext;
      window.AudioContext = class extends Audio {
        constructor(...args) {
          super(...args);
          if (!window.turnAlertContext) window.turnAlertContext = this;
          else window.musicContext = this;
        }
        createOscillator() {
          if (this === window.turnAlertContext) window.turnAlerts.notes++;
          return super.createOscillator();
        }
      };
    });
    page.setDefaultTimeout(15000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const origin = process.env.BATAQ_URL || "http://localhost:8080";

    await page.goto(origin);
    assert.equal(await page.locator("html").getAttribute("data-theme"), "system");
    assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), "rgb(245, 243, 235)");
    await page.getByRole("button", { name: "Open menu" }).click();
    await page.waitForFunction(() => window.musicContext?.state === "running");
    assert.equal(await page.getByRole("radio", { name: "Music on", exact: true }).isChecked(), true);
    await page.getByRole("slider", { name: "Music volume" }).fill("40");
    assert.equal(await page.evaluate(() => localStorage.getItem("bataq.musicVolume")), "40");
    await page.getByRole("radio", { name: "Music off", exact: true }).check();
    await page.waitForFunction(() => window.musicContext?.state === "suspended");
    assert.equal(await page.evaluate(() => localStorage.getItem("bataq.music")), "off");
    await page.getByRole("radio", { name: "Dark", exact: true }).check();
    assert.equal(await page.evaluate(() => localStorage.getItem("bataq.theme")), "dark");
    assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), "rgb(16, 29, 26)");
    assert.equal(await page.locator('meta[name="theme-color"]').getAttribute("content"), "#101d1a");
    await page.reload();
    await page.getByPlaceholder("Your name", { exact: true }).waitFor();
    assert.equal(await page.locator("html").getAttribute("data-theme"), "dark");
    await page.getByRole("button", { name: "Open menu" }).click();
    assert.equal(await page.getByRole("radio", { name: "Music off", exact: true }).isChecked(), true);
    assert.equal(await page.getByRole("slider", { name: "Music volume" }).inputValue(), "40");
    await page.getByRole("radio", { name: "Music on", exact: true }).check();
    await page.waitForFunction(() => window.musicContext?.state === "running");
    // Simulate mobile background/foreground while retaining the page.
    await page.evaluate(() => {
      Object.defineProperty(document, "hidden", { configurable: true, value: true });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await page.waitForFunction(() => window.musicContext.state === "suspended");
    await page.evaluate(() => {
      delete document.hidden;
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await page.waitForFunction(() => window.musicContext.state === "running");
    // Render the actual synth offline: it must produce finite, audible samples
    // with headroom, rather than only creating successfully connected nodes.
    const renderedMusic = await page.evaluate(async () => {
      const { GenerativeMusic, MUSIC_TEMPO } = await import("/music.js");
      const context = new OfflineAudioContext(2, 44100 * 12, 44100);
      const Audio = window.AudioContext;
      const music = new GenerativeMusic();
      try {
        window.AudioContext = function () {
          return context;
        };
        music.setup();
      } finally {
        window.AudioContext = Audio;
      }
      music.playing = true;
      music.setVolume(0.25);
      for (let beat = 0; beat < 16; beat++) music.scheduleBeat(0.06 + (beat * 60) / MUSIC_TEMPO);
      const buffer = await context.startRendering();
      let peak = 0;
      let energy = 0;
      let finite = true;
      for (const sample of buffer.getChannelData(0)) {
        finite &&= Number.isFinite(sample);
        peak = Math.max(peak, Math.abs(sample));
        energy += sample * sample;
      }
      return { peak, rms: Math.sqrt(energy / buffer.length), finite, voices: music.voices.size };
    });
    assert.equal(renderedMusic.finite, true);
    assert.ok(renderedMusic.rms > 0.0005, `silent music: ${JSON.stringify(renderedMusic)}`);
    assert.ok(renderedMusic.peak < 0.9, `music lacks headroom: ${JSON.stringify(renderedMusic)}`);
    assert.equal(renderedMusic.voices, 0);
    await page.getByRole("radio", { name: "Light", exact: true }).check();
    await page.emulateMedia({ colorScheme: "dark" });
    assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), "rgb(245, 243, 235)");
    await page.getByRole("radio", { name: /System/ }).check();
    assert.equal(await page.evaluate(() => localStorage.getItem("bataq.theme")), null);
    await page.waitForFunction(() => getComputedStyle(document.body).backgroundColor === "rgb(16, 29, 26)");
    await page.emulateMedia({ colorScheme: "light" });
    await page.waitForFunction(() => getComputedStyle(document.body).backgroundColor === "rgb(245, 243, 235)");
    await page.getByRole("button", { name: "Close menu" }).click();
    await page.getByRole("button", { name: "Open menu" }).click();
    await page.getByRole("radio", { name: "Türkçe" }).check();
    await page.waitForFunction(() => document.documentElement.lang === "tr");
    await page.getByRole("button", { name: "Menüyü kapat" }).click();
    await page.reload();
    await page.getByPlaceholder("Adın", { exact: true }).waitFor();
    assert.equal(await page.locator("html").getAttribute("lang"), "tr");
    await page.getByRole("button", { name: "Menüyü aç" }).click();
    await page.getByRole("radio", { name: "English", exact: true }).check();
    await page.waitForFunction(() => document.documentElement.lang === "en");
    await page.getByRole("radio", { name: /Browser default/ }).check();
    assert.equal(await page.evaluate(() => localStorage.getItem("bataq.language")), null);
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !Alpine.$data(document.body).settingsOpen);
    await page.locator("#name").fill("Abdus");
    await page.getByRole("button", { name: "Create a table" }).click();
    await page.waitForFunction(() => Alpine.$data(document.body).ready);
    const room = await page.evaluate(() => Alpine.$data(document.body).room.id);
    const token = await page.evaluate(() => Alpine.$data(document.body).token);
    assert.equal(await page.evaluate(() => Alpine.$data(document.body).source instanceof WebSocket), true);
    assert.equal(await page.evaluate(() => new URL(Alpine.$data(document.body).source.url).protocol), origin.startsWith("https:") ? "wss:" : "ws:");
    await page.waitForSelector(".qr-box svg");

    // A socket closure must restore the same seat without a page reload.
    await page.evaluate(() => Alpine.$data(document.body).source.close());
    await page.waitForFunction(() => !Alpine.$data(document.body).ready);
    await page.waitForFunction(() => Alpine.$data(document.body).ready);
    assert.equal(await page.evaluate(() => Alpine.$data(document.body).token), token);

    await page.reload();
    await page.waitForFunction(() => Alpine.$data(document.body).ready);
    assert.equal(await page.evaluate(() => Alpine.$data(document.body).token), token);

    // Logo navigation must leave a saved game and allow a fresh table,
    // including when the browser reports an installed PWA display mode.
    const home = await desktop.newPage();
    await home.addInitScript(() => {
      const matchMedia = window.matchMedia.bind(window);
      window.matchMedia = (query) => {
        const result = matchMedia(query);
        if (query === "(display-mode: standalone)") Object.defineProperty(result, "matches", { value: true });
        return result;
      };
    });
    await home.goto(`${origin}/?resume=1`);
    await home.waitForFunction(() => Alpine.$data(document.body).ready);
    assert.equal(await home.evaluate(() => Alpine.$data(document.body).token), token);
    await home.locator(".brand").click();
    await home.getByRole("button", { name: "Create a table" }).waitFor();
    assert.equal(await home.evaluate(() => Alpine.$data(document.body).token), "");
    assert.equal(await home.evaluate(() => JSON.parse(localStorage.getItem("bataq.session")).token), token);
    await home.reload();
    await home.getByRole("button", { name: "Create a table" }).click();
    await home.waitForFunction(() => Alpine.$data(document.body).ready);
    assert.notEqual(await home.evaluate(() => Alpine.$data(document.body).room.id), room);
    await home.close();

    const mobile = await browser.newContext({
      viewport: { width: 390, height: 844 },
    });
    const friend = await mobile.newPage();
    friend.setDefaultTimeout(15000);
    friend.on("pageerror", (error) => errors.push(error.message));
    await friend.goto(`${origin}/?room=${room}`);
    await friend.locator("#name").fill("Deniz");
    await friend.getByRole("button", { name: "Join the table" }).click();
    await friend.waitForFunction(() => Alpine.$data(document.body).ready);
    await page.waitForFunction(() => Alpine.$data(document.body).room.players.length === 2);

    await page.getByRole("button", { name: "Fill empty seats with bots" }).click();
    await page.waitForFunction(() => Alpine.$data(document.body).room.players.length === 4);
    await page.getByRole("button", { name: "Deal the cards" }).click();
    await friend.waitForFunction(() => Alpine.$data(document.body).myTurn);
    await friend.locator(".scores").waitFor({ state: "visible" });
    await friend.locator(".bid-range").fill("13");
    await friend.getByRole("button", { name: /^Bid 13 tricks/ }).click();
    await friend.waitForFunction(() => Alpine.$data(document.body).room.phase === "trump");
    await friend.getByRole("button", { name: "Choose hearts as trump" }).click();
    await friend.waitForFunction(() => Alpine.$data(document.body).room.phase === "playing");
    assert.equal(await friend.evaluate(() => Alpine.$data(document.body).room.trump), 1);
    await friend.locator(".trump-chip").waitFor({ state: "visible" });
    await friend.locator(".scores").waitFor({ state: "visible" });

    await mobile.setOffline(true);
    await friend.waitForFunction(() => !Alpine.$data(document.body).ready);
    assert.equal(await friend.locator(".hand-card:enabled").count(), 0);
    await mobile.setOffline(false);
    await friend.waitForFunction(() => Alpine.$data(document.body).ready);
    await friend.reload();
    await friend.waitForFunction(() => Alpine.$data(document.body).ready && Alpine.$data(document.body).hand.length === 13);

    await friend.locator(".hand-card.playable").first().click();
    await friend.waitForFunction(() => Alpine.$data(document.body).hand.length === 12);
    await page.waitForFunction(() => Alpine.$data(document.body).myTurn);
    await page.waitForFunction(() => window.turnAlerts.notes >= 2 && window.turnAlerts.vibrations.length >= 1);
    const alerts = await page.evaluate(() => ({ ...window.turnAlerts }));
    assert.ok(alerts.vibrations.every((duration) => duration === 45));
    assert.equal(alerts.notes, alerts.vibrations.length * 2);
    await page.evaluate(() => Alpine.$data(document.body).connect());
    await page.waitForFunction(() => Alpine.$data(document.body).ready);
    assert.deepEqual(await page.evaluate(() => ({ ...window.turnAlerts })), alerts);
    await page.locator(".hand-card.playable").first().click();
    await page.waitForFunction(() => Alpine.$data(document.body).room.phase === "trick");
    await friend.waitForFunction(() => Alpine.$data(document.body).room.phase === "playing");
    assert.equal(await friend.evaluate(() => Alpine.$data(document.body).room.lastTrick.length), 4);
    for (const width of [320, 390, 720, 1000]) {
      await friend.setViewportSize({ width, height: 844 });
      await friend.locator(".trump-chip").waitFor({ state: "visible" });
      await friend.locator(".scores").waitFor({ state: "visible" });
      await friend.locator(".last-trick").waitFor({ state: "visible" });
      assert.equal(await friend.locator(".score-row").count(), 4);
      assert.equal(await friend.locator(".mini-trick > div").count(), 4);
      assert.equal(await friend.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `overflow at ${width}px`);
    }
    await friend.setViewportSize({ width: 390, height: 844 });

    await page.getByRole("button", { name: "Invite friends" }).click();
    await page.waitForSelector('[aria-labelledby="share-title"] .qr-box svg');
    await page.getByRole("button", { name: "Close invitation" }).click();

    await page.waitForFunction(() => !!navigator.serviceWorker.controller);
    await desktop.setOffline(true);
    const shell = await desktop.newPage();
    await shell.goto(origin);
    await shell.waitForSelector(".brand");
    assert.equal(await shell.locator(".brand").count(), 1);
    await desktop.setOffline(false);

    // Expiry uses the same client path as a server restart with a new signing key.
    await friend.evaluate(() => {
      const saved = JSON.parse(localStorage.getItem("bataq.session"));
      saved.token = "expired";
      localStorage.setItem("bataq.session", JSON.stringify(saved));
    });
    await friend.reload();
    await friend.waitForFunction(() => !Alpine.$data(document.body).token && !!Alpine.$data(document.body).error);
    const turkish = await browser.newContext({ locale: "tr-TR", viewport: { width: 390, height: 844 } });
    const turkishPage = await turkish.newPage();
    turkishPage.setDefaultTimeout(15000);
    turkishPage.on("pageerror", (error) => errors.push(error.message));
    await turkishPage.goto(`${origin}/?room=DOESNOTEXIST`);
    assert.equal(await turkishPage.locator("html").getAttribute("lang"), "tr");
    assert.equal(await turkishPage.title(), "Bataq — Yerini al.");
    await turkishPage.getByPlaceholder("Adın", { exact: true }).fill("İpek");
    await turkishPage.getByRole("button", { name: "Masaya katıl" }).click();
    await turkishPage.waitForFunction(() => !!Alpine.$data(document.body).error);
    assert.match(await turkishPage.locator(".toast").innerText(), /Bu oda bulunamadı/);
    await turkishPage.locator("#room-code").fill("");
    await turkishPage.getByRole("button", { name: "Masa oluştur" }).click();
    await turkishPage.waitForFunction(() => Alpine.$data(document.body).ready);
    await turkishPage.getByRole("button", { name: "Menüyü aç" }).click();
    await turkishPage.getByRole("radio", { name: "Koyu", exact: true }).check();
    assert.equal(await turkishPage.locator("html").getAttribute("data-theme"), "dark");
    await turkishPage.getByRole("radio", { name: /Sistem/ }).check();
    await turkishPage.getByRole("button", { name: "Nasıl oynanır" }).click();
    await turkishPage.getByRole("heading", { name: "İhale. Koz. Oyun." }).waitFor();
    await turkishPage.getByRole("button", { name: "Kuralları kapat" }).click();
    await turkishPage.getByRole("button", { name: "Boş yerlere bot ekle" }).click();
    await turkishPage.waitForFunction(() => Alpine.$data(document.body).room.players.length === 4);
    await turkishPage.getByRole("button", { name: "Kartları dağıt" }).click();
    await turkishPage.waitForFunction(() => Alpine.$data(document.body).myTurn);
    await turkishPage.locator(".bid-range").fill("13");
    await turkishPage.getByRole("button", { name: /^13 el de/ }).click();
    await turkishPage.waitForFunction(() => Alpine.$data(document.body).room.phase === "trump");
    await turkishPage.getByRole("button", { name: "kupa rengini koz seç" }).click();
    await turkishPage.waitForFunction(() => Alpine.$data(document.body).room.phase === "playing");
    await turkishPage.locator(".hand-card.playable").first().click();
    await turkishPage.waitForFunction(() => Alpine.$data(document.body).hand.length === 12);
    await turkishPage.reload();
    await turkishPage.waitForFunction(() => Alpine.$data(document.body).ready && Alpine.$data(document.body).hand.length === 12);
    assert.equal(await turkishPage.locator("html").getAttribute("lang"), "tr");
    assert.equal(await turkishPage.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);

    // Verify all four suit colors in the real Alpine template, independent of the deal.
    await page.evaluate(() => {
      const app = Alpine.$data(document.body);
      ++app.generation;
      app.source?.close();
      app.room.phase = app.phases.PLAYING;
      app.room.trick = [0, 1, 2, 3].map((suit) => ({ seat: suit, card: { suit, rank: 14 } }));
    });
    await page.waitForFunction(() => document.querySelectorAll(".table-card").length === 4);
    for (const suit of [0, 1, 2, 3]) {
      const color = await page.locator(`.table-card.played-${suit}`).evaluate((card) => ({
        red: card.classList.contains("red-card"),
        card: getComputedStyle(card).color,
        rank: getComputedStyle(card.querySelector(".corner b")).color,
        symbol: getComputedStyle(card.querySelector(".card-symbol")).color,
      }));
      assert.equal(color.red, suit === 1 || suit === 2);
      assert.equal(color.card, color.rank);
      assert.equal(color.card, color.symbol);
      assert.equal(color.card, suit === 1 || suit === 2 ? "rgb(188, 89, 72)" : "rgb(23, 62, 53)");
    }
    assert.deepEqual(errors, []);
    console.log(
      "Browser checks passed: gameplay, refresh, reconnect, mobile layout, preferences, generative music output and controls, background audio pause, offline shell, expired sessions, and all suit colors.",
    );
  } finally {
    await browser.close();
  }
}

verify().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
