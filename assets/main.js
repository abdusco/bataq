import { browserLanguage, translate } from "./translations.js";
// Alpine starts in a microtask, after the listener below is registered.
import "./vendor/alpine.min.js";

/**
 * The server owns game decisions. This client renders personalized snapshots.
 * @typedef {import('./translations.js').Language} Language
 * @typedef {Language|'auto'} LanguagePreference
 * @typedef {'light'|'dark'|'system'} ThemePreference
 * @typedef {'lobby'|'bidding'|'trump'|'playing'|'trick'|'round'|'finished'} Phase
 * @typedef {'idle'|'connecting'|'online'|'offline'} Connection
 * @typedef {'bots'|'start'|'bid'|'trump'|'play'|'next'|'rematch'} ActionKind
 * @typedef {0|1|2|3} Suit
 * @typedef {{suit: Suit, rank: number}} Card
 * @typedef {{seat: number, card: Card}} Play
 * @typedef {{id: string, name: string, bot: boolean, online: boolean, bid: number,
 *   passed: boolean, tricks: number, score: number}} Player
 * @typedef {{round: number, bids: number[], tricks: number[], points: number[]}} RoundResult
 * @typedef {{id: string, players: Player[], phase: Phase, round: number, turn: number,
 *   dealer: number, host: number, trump: Suit|-1, bidder: number, highBid: number,
 *   trick: Play[], lastTrick: Play[], winner: number, broken: boolean,
 *   history: RoundResult[]|null, revision: number, sequence: number}} Room
 * @typedef {{room: Room, you: number, hand: Card[], legal: Card[]}} Snapshot
 * @typedef {{kind: 'state', snapshot: Snapshot}|{kind: 'heartbeat'}} LiveMessage
 * @typedef {{token: string, room: string}} Session
 * @typedef {{bid?: number, suit?: Suit, card?: Card}} MovePayload
 * @typedef {Event & {prompt: () => Promise<void>}} InstallPrompt
 */

const PHASE = Object.freeze({
  LOBBY: "lobby",
  BIDDING: "bidding",
  TRUMP: "trump",
  PLAYING: "playing",
  TRICK: "trick",
  ROUND: "round",
  FINISHED: "finished",
});
const ACTION = Object.freeze({
  ADD_BOTS: "bots",
  START: "start",
  BID: "bid",
  TRUMP: "trump",
  PLAY: "play",
  NEXT: "next",
  REMATCH: "rematch",
});
const SUIT = Object.freeze({ SPADES: 0, HEARTS: 1, DIAMONDS: 2, CLUBS: 3 });
const CONNECTION = Object.freeze({
  IDLE: "idle",
  CONNECTING: "connecting",
  ONLINE: "online",
  OFFLINE: "offline",
});
const LIVE_MESSAGE = Object.freeze({ STATE: "state", HEARTBEAT: "heartbeat" });
const THEME = Object.freeze({ LIGHT: "light", DARK: "dark", SYSTEM: "system" });
// Keep browser audio objects outside Alpine's reactive state.
/** @type {AudioContext|null} */
let turnAudio = null;

document.addEventListener("alpine:init", () => {
  Alpine.data("bataq", () => ({
    languagePreference: /** @type {LanguagePreference} */ ("auto"),
    themePreference: /** @type {ThemePreference} */ (THEME.SYSTEM),
    systemDark: false,
    phases: PHASE,
    actions: ACTION,
    suits: SUIT,
    name: "",
    roomCode: new URL(location.href).searchParams.get("room") || "",
    room: /** @type {Room|null} */ (null),
    you: 0,
    hand: /** @type {Card[]} */ ([]),
    legal: /** @type {Card[]} */ ([]),
    bid: 5,
    token: "",
    connection: CONNECTION.IDLE,
    ready: false,
    restoring: false,
    pending: false,
    error: "",
    copied: false,
    shareOpen: false,
    rulesOpen: false,
    settingsOpen: false,
    installPrompt: /** @type {InstallPrompt|null} */ (null),
    source: /** @type {WebSocket|null} */ (null),
    retryTimer: null,
    connectTimer: null,
    sessionController: null,
    attempts: 0,
    lastMessage: 0,
    connectStarted: 0,
    generation: 0,
    lastTurnNotice: "",
    /** @returns {void} */
    unlockTurnAudio() {
      try {
        const Audio = window.AudioContext || window.webkitAudioContext;
        if (!Audio) return;
        if (!turnAudio || turnAudio.state === "closed") turnAudio = new Audio();
        if (turnAudio.state === "suspended") turnAudio.resume().catch(() => {});
      } catch {}
    },
    /** @returns {void} */
    notifyTurn() {
      if (!this.myTurn) return;
      const notice = `${this.room.id}:${this.room.round}:${this.room.phase}:${this.room.revision}`;
      if (notice === this.lastTurnNotice) return;
      this.lastTurnNotice = notice;
      try {
        navigator.vibrate?.(45);
      } catch {}
      if (turnAudio?.state !== "running") return;
      try {
        // A soft rising two-note chime, generated locally without an audio asset.
        for (const [index, frequency] of [660, 880].entries()) {
          const start = turnAudio.currentTime + index * 0.11;
          const note = turnAudio.createOscillator();
          const volume = turnAudio.createGain();
          note.type = "sine";
          note.frequency.value = frequency;
          volume.gain.setValueAtTime(0, start);
          volume.gain.linearRampToValueAtTime(0.07, start + 0.012);
          volume.gain.exponentialRampToValueAtTime(0.001, start + 0.1);
          note.connect(volume);
          volume.connect(turnAudio.destination);
          note.start(start);
          note.stop(start + 0.11);
          note.onended = () => {
            note.disconnect();
            volume.disconnect();
          };
        }
      } catch {}
    },
    /** @returns {'light'|'dark'} */
    get resolvedTheme() {
      return this.themePreference === THEME.SYSTEM ? (this.systemDark ? THEME.DARK : THEME.LIGHT) : this.themePreference;
    },
    /** @param {ThemePreference} preference @returns {void} */
    setTheme(preference) {
      if (!Object.values(THEME).includes(preference)) return;
      this.themePreference = preference;
      try {
        if (preference === THEME.SYSTEM) localStorage.removeItem("bataq.theme");
        else localStorage.setItem("bataq.theme", preference);
      } catch {}
      this.updateDocumentTheme();
    },
    /** @returns {void} */
    updateDocumentTheme() {
      document.documentElement.dataset.theme = this.themePreference;
      document.querySelector('meta[name="theme-color"]').content = this.resolvedTheme === THEME.DARK ? "#101d1a" : "#f5f3eb";
    },
    /** @returns {Language} */
    get language() {
      return this.languagePreference === "auto" ? browserLanguage(navigator.languages || [navigator.language]) : this.languagePreference;
    },
    /** @returns {string} */
    get browserLanguageLabel() {
      return browserLanguage(navigator.languages || [navigator.language]) === "tr" ? "Türkçe" : "English";
    },
    /** @param {LanguagePreference} preference @returns {void} */
    setLanguage(preference) {
      if (!["auto", "en", "tr"].includes(preference)) return;
      this.languagePreference = preference;
      try {
        if (preference === "auto") localStorage.removeItem("bataq.language");
        else localStorage.setItem("bataq.language", preference);
      } catch {}
      this.updateDocumentLanguage();
    },
    /** @returns {void} */
    updateDocumentLanguage() {
      document.documentElement.lang = this.language;
      document.title = this.t("Bataq — Take your seat.");
      document.querySelector('meta[name="description"]').content = this.t("A little table for good company. Play real-time Batak with friends.");
    },
    /** @returns {void} */
    openSettings() {
      this.settingsOpen = true;
      this.$nextTick(() => this.$refs.menuClose.focus());
    },
    /** @returns {void} */
    closeSettings() {
      this.settingsOpen = false;
      this.$nextTick(() => this.$refs.menuTrigger.focus());
    },
    /** @param {KeyboardEvent} event @returns {void} */
    trapMenuFocus(event) {
      const controls = [...this.$refs.settingsPanel.querySelectorAll("button:not([disabled]), input:not([disabled]), a[href]")].filter(
        (el) => el.offsetParent !== null,
      );
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    },
    /** @param {string} message @param {Record<string, string|number>} [values] @returns {string} */
    t(message, values = {}) {
      return translate(this.language, message, values);
    },
    /** @returns {string} */
    get connectionLabel() {
      return this.t(
        {
          idle: "Ready to play",
          connecting: "Connecting…",
          online: "Connected",
          offline: "Reconnecting…",
        }[this.connection],
      );
    },
    /** @returns {string} */
    get shareURL() {
      return this.room ? `${location.origin}/?room=${encodeURIComponent(this.room.id)}` : "";
    },
    /** @returns {boolean} */
    get myTurn() {
      return this.ready && this.room?.turn === this.you && [PHASE.BIDDING, PHASE.TRUMP, PHASE.PLAYING].includes(this.room?.phase);
    },
    /** @returns {number} */
    get minBid() {
      return Math.max(5, (this.room?.highBid || 0) + 1);
    },
    /** @returns {string} */
    get trumpLabel() {
      if (this.room?.trump >= 0)
        return this.suit({ suit: this.room.trump, rank: 0 }) + " " + this.t(["Spades", "Hearts", "Diamonds", "Clubs"][this.room.trump]);
      return this.t("Trump to be chosen");
    },
    /** @returns {string} */
    get champion() {
      if (!this.room) return "";
      const high = Math.max(...this.room.players.map((p) => p.score));
      return this.room.players
        .filter((p) => p.score === high)
        .map((p) => p.name)
        .join(" & ");
    },
    /** @returns {string} */
    get statusTitle() {
      if (!this.room) return "";
      if (!this.ready) return this.t("Finding your way back to the table…");
      const phase = this.room.phase;
      if (phase === PHASE.LOBBY) return this.t(this.room.players.length === 4 ? "Everyone’s here. Let’s deal." : "A few friends away from a good game.");
      if (phase === PHASE.TRICK)
        return this.t("{name} takes the trick.", {
          name: this.room.players[this.room.winner].name,
        });
      if (phase === PHASE.ROUND) return this.t("Time for a fresh hand.");
      if (phase === PHASE.FINISHED) return this.t("{name} wins!", { name: this.champion });
      if (phase === PHASE.TRUMP)
        return this.myTurn
          ? this.t("The auction is yours. Choose trump.")
          : this.t("{name} is choosing trump.", {
              name: this.room.players[this.room.bidder].name,
            });
      if (this.myTurn) return this.t(phase === PHASE.BIDDING ? "Your bid. Call your shot." : "Your turn. Make it count.");
      return this.t(phase === PHASE.BIDDING ? "{name} is bidding." : "{name} is playing.", { name: this.room.players[this.room.turn].name });
    },
    /** @returns {string} */
    get statusDetail() {
      if (!this.ready) return this.t("Your seat and cards are safe while the server is running.");
      if (this.room?.phase === PHASE.LOBBY)
        return this.t(this.you === this.room.host ? "Share the link to fill your table." : "Settle in. Your host will start the game.");
      if (this.room?.phase === PHASE.PLAYING && !this.room.players[this.room.turn].online) return this.t("Their seat is saved. Waiting for them to reconnect.");
      if (this.room?.phase === PHASE.BIDDING)
        return this.room.highBid
          ? this.t("{name} leads at {bid}. Raise or pass.", {
              name: this.room.players[this.room.bidder].name,
              bid: this.room.highBid,
            })
          : this.t("Open at 5, or pass. The winner chooses trump.");
      return this.myTurn
        ? this.t(this.room.phase === PHASE.TRUMP ? "Pick your strongest suit. You’ll lead the first trick." : "Follow suit. Beat it if you can.")
        : this.t("{trump}. Aces are high.", { trump: this.trumpLabel });
    },
    /** @param {Player} player @returns {string} */
    playerDetail(player) {
      if (this.room?.phase === PHASE.LOBBY) return this.t(player.bot ? "Practice partner" : player.online ? "At the table" : "Reconnecting…");
      return this.t("{taken} / {bid} tricks", {
        taken: player.tricks,
        bid: player.bid || "—",
      });
    },
    /** @returns {void} */
    init() {
      // Autoplay policies require audio activation inside a real user gesture.
      for (const eventName of ["pointerdown", "keydown"]) {
        document.addEventListener(
          eventName,
          (event) => {
            if (event.isTrusted) this.unlockTurnAudio();
          },
          { capture: true },
        );
      }
      const appearance = window.matchMedia("(prefers-color-scheme: dark)");
      this.systemDark = appearance.matches;
      try {
        const preference = localStorage.getItem("bataq.theme");
        if (preference === THEME.LIGHT || preference === THEME.DARK) this.themePreference = preference;
      } catch {}
      this.updateDocumentTheme();
      appearance.addEventListener("change", (event) => {
        this.systemDark = event.matches;
        this.updateDocumentTheme();
      });
      try {
        const preference = localStorage.getItem("bataq.language");
        if (preference === "en" || preference === "tr") this.languagePreference = preference;
      } catch {}
      this.updateDocumentLanguage();

      try {
        this.name = localStorage.getItem("bataq.name") || "";
        const saved = /** @type {Session|null} */ (JSON.parse(localStorage.getItem("bataq.session") || "null"));
        const resume = new URL(location.href).searchParams.get("resume") === "1";
        if (saved && (this.roomCode.toUpperCase() === saved.room || (resume && !this.roomCode))) {
          this.token = saved.token;
          this.roomCode = saved.room;
          history.replaceState(null, "", `/?room=${encodeURIComponent(saved.room)}`);
          this.restoring = true;
          this.connect();
        }
      } catch {
        this.error = this.t("Browser storage is unavailable. Keep this tab open to retain your seat.");
      }
      window.addEventListener("online", () => {
        this.wake();
      });
      window.addEventListener("offline", () => {
        this.stopConnection();
        this.sessionController?.abort();
        this.ready = false;
        this.connection = CONNECTION.OFFLINE;
      });
      document.addEventListener("visibilitychange", () => {
        if (!document.hidden) this.wake();
      });
      document.addEventListener("resume", () => this.wake());
      window.addEventListener("pageshow", (event) => {
        if (event.persisted) this.wake();
      });
      window.addEventListener("focus", () => {
        if (!this.ready || Date.now() - this.lastMessage > 15000) this.wake();
      });
      window.addEventListener("beforeinstallprompt", (e) => {
        e.preventDefault();
        this.installPrompt = /** @type {InstallPrompt} */ (e);
      });
      setInterval(() => {
        if (!document.hidden && this.token && this.ready && Date.now() - this.lastMessage > 20000) this.connect();
      }, 5000);
      if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
    },
    /** @returns {Promise<void>} */
    async join() {
      if (this.pending || this.restoring) return;
      this.pending = true;
      this.error = "";
      try {
        const response = await fetch("/api/join", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: this.name.trim(),
            room: this.roomCode.trim(),
          }),
        });
        const data = /** @type {Session & {error?: string}} */ (await response.json());
        if (!response.ok) throw new Error(data.error);
        this.token = data.token;
        this.roomCode = data.room;
        try {
          localStorage.setItem("bataq.name", this.name.trim());
          localStorage.setItem("bataq.session", JSON.stringify(data));
        } catch {
          this.error = this.t("Could not save your session. Keep this tab open to retain your seat.");
        }
        history.replaceState(null, "", `/?room=${encodeURIComponent(data.room)}`);
        this.connect();
      } catch (e) {
        this.error = this.t(e.message || "Could not reach the table. Try again.");
      } finally {
        this.pending = false;
      }
    },
    /** @returns {void} */
    stopConnection() {
      ++this.generation;
      clearTimeout(this.retryTimer);
      clearTimeout(this.connectTimer);
      this.source?.close();
      this.source = null;
    },
    /** @returns {void} */
    wake() {
      if (!this.token || document.hidden || navigator.onLine === false) return;
      // A short tab switch doesn't invalidate a healthy live connection.
      if (this.ready && this.source?.readyState === WebSocket.OPEN && Date.now() - this.lastMessage <= 20000) return;
      this.attempts = 0;
      this.connect();
    },
    /** @returns {void} */
    connect() {
      // Foreground events and retries must let an existing attempt finish.
      // Use the attempt's start time: heartbeats must not extend its deadline.
      if (this.source && this.connection === CONNECTION.CONNECTING && Date.now() - this.connectStarted < 8000) return;
      this.stopConnection();
      if (!this.token) return;
      this.ready = false;
      if (navigator.onLine === false) {
        this.connection = CONNECTION.OFFLINE;
        return;
      }
      const generation = this.generation;
      this.connection = CONNECTION.CONNECTING;
      this.connectStarted = Date.now();
      this.lastMessage = this.connectStarted;
      let failed = false;
      const fail = () => {
        if (generation !== this.generation || failed) return;
        failed = true;
        clearTimeout(this.connectTimer);
        this.source?.close();
        this.source = null;
        this.ready = false;
        this.connection = CONNECTION.OFFLINE;
        // Browser sockets hide failed handshake HTTP statuses. Check expiry
        // only after failure, so successful connections need no HTTP preflight.
        this.checkSession();
      };
      this.connectTimer = setTimeout(fail, 8000);
      try {
        const url = new URL("/api/live", location.href);
        url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
        url.searchParams.set("token", this.token);
        const source = new WebSocket(url);
        this.source = source;
        source.addEventListener("message", (event) => {
          if (generation !== this.generation || failed) return;
          let message;
          try {
            message = /** @type {LiveMessage} */ (JSON.parse(event.data));
          } catch {
            fail();
            return;
          }
          if (message.kind === LIVE_MESSAGE.HEARTBEAT) {
            this.lastMessage = Date.now();
            return;
          }
          if (message.kind !== LIVE_MESSAGE.STATE) return;
          clearTimeout(this.connectTimer);
          this.lastMessage = Date.now();
          this.ready = true;
          this.apply(message.snapshot);
          this.restoring = false;
          this.connection = CONNECTION.ONLINE;
          this.attempts = 0;
        });
        source.onclose = fail;
        source.onerror = fail;
      } catch {
        fail();
      }
    },
    /** @returns {Promise<void>} */
    async checkSession() {
      // Retry independently: a slow HTTP diagnostic must not delay the socket.
      this.retry();
      if (this.sessionController) return;
      const token = this.token;
      const controller = new AbortController();
      this.sessionController = controller;
      const timer = setTimeout(() => controller.abort(), 3000);
      try {
        const response = await fetch("/api/session", {
          headers: { Authorization: token },
          cache: "no-store",
          signal: controller.signal,
        });
        if (response.status === 401) {
          const data = await response.json();
          if (token === this.token) this.expire(data.error);
        }
      } catch {
        // A network failure is handled by the scheduled socket retry.
      } finally {
        clearTimeout(timer);
        if (this.sessionController === controller) this.sessionController = null;
      }
    },
    /** @returns {void} */
    retry() {
      this.ready = false;
      this.connection = CONNECTION.OFFLINE;
      clearTimeout(this.retryTimer);
      if (!this.token || navigator.onLine === false) return;
      const wait = Math.min(10000, 250 * 2 ** Math.min(this.attempts++, 6)) + Math.random() * 250;
      this.retryTimer = setTimeout(() => this.connect(), wait);
    },
    /** @param {string} [message] @returns {void} */
    expire(message) {
      this.stopConnection();
      this.sessionController?.abort();
      this.token = "";
      this.room = null;
      this.lastTurnNotice = "";
      this.hand = [];
      this.ready = false;
      this.restoring = false;
      this.connection = CONNECTION.IDLE;
      this.roomCode = "";
      history.replaceState(null, "", "/");
      try {
        localStorage.removeItem("bataq.session");
      } catch {}
      this.error = this.t(message || "The table has expired. Create a fresh room to play again.");
    },
    /** @param {Snapshot} state @returns {void} */
    apply(state) {
      if (this.room && this.room.id === state.room.id && state.room.sequence < this.room.sequence) return;
      const screen = (phase) => ([PHASE.ROUND, PHASE.FINISHED].includes(phase) ? "results" : phase === PHASE.LOBBY ? "lobby" : "game");
      const changed = !this.room || screen(this.room.phase) !== screen(state.room.phase);
      const update = () => {
        if (this.room?.id === state.room.id && state.room.sequence < this.room.sequence) return;
        this.room = state.room;
        this.you = state.you;
        this.hand = state.hand || [];
        this.legal = state.legal || [];
        this.bid = Math.max(this.bid, this.minBid);
        this.notifyTurn();
        return this.$nextTick(() => this.renderQR());
      };
      // The first live snapshot must exist before ready enables the UI.
      if (this.room && changed && document.startViewTransition && !matchMedia("(prefers-reduced-motion: reduce)").matches) document.startViewTransition(update);
      else update();
    },
    /** @param {ActionKind} action @param {MovePayload} [extra={}] @returns {Promise<void>} */
    async act(action, extra = {}) {
      if (!this.ready || this.pending) return;
      this.pending = true;
      this.error = "";
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      try {
        const response = await fetch("/api/action", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            token: this.token,
            action,
            revision: this.room.revision,
            ...extra,
          }),
        });
        const data = await response.json();
        if (response.status === 401) {
          this.expire(data.error);
          return;
        }
        if (!response.ok) throw new Error(data.error);
      } catch (e) {
        this.error = this.t(
          e.name === "AbortError" ? "Connection interrupted. Checking the table before you try again." : e.message || "Connection interrupted.",
        );
        if (e.name === "AbortError" || e instanceof TypeError) this.connect();
      } finally {
        clearTimeout(timer);
        this.pending = false;
      }
    },
    /** @param {number} position @returns {number} */
    relativeSeat(position) {
      return (this.you + position) % 4;
    },
    /** @param {number} position @returns {Player|undefined} */
    relativePlayer(position) {
      return this.room?.players[this.relativeSeat(position)];
    },
    /** @param {number} seat @returns {number} */
    positionOf(seat) {
      return (seat - this.you + 4) % 4;
    },
    /** @param {number} seat @returns {boolean} */
    isTurn(seat) {
      return this.room?.turn === seat && [PHASE.BIDDING, PHASE.TRUMP, PHASE.PLAYING].includes(this.room?.phase);
    },
    /** @param {Card} card @returns {string} */
    suit(card) {
      return ["♠", "♥", "♦", "♣"][card.suit];
    },
    /** @param {Card} card @returns {boolean} */
    isRed(card) {
      return card.suit === SUIT.HEARTS || card.suit === SUIT.DIAMONDS;
    },
    /** @param {Card} card @returns {string|number} */
    rank(card) {
      return { 11: "J", 12: "Q", 13: "K", 14: "A" }[card.rank] || card.rank;
    },
    /** @param {Card} card @returns {string} */
    cardLabel(card) {
      const rank = this.t(String({ 11: "Jack", 12: "Queen", 13: "King", 14: "Ace" }[card.rank] || card.rank));
      const suit = this.t(["spades", "hearts", "diamonds", "clubs"][card.suit]);
      return this.t("{rank} of {suit}", { rank, suit });
    },
    /** @param {Card} card @returns {boolean} */
    canPlay(card) {
      return this.myTurn && this.room.phase === PHASE.PLAYING && this.legal.some((c) => c.suit === card.suit && c.rank === card.rank);
    },
    /** @returns {void} */
    renderQR() {
      if (!this.room || this.qrURL === this.shareURL) return;
      const code = qrcode(0, "M");
      code.addData(this.shareURL);
      code.make();
      for (const target of [this.$refs.lobbyQR, this.$refs.shareQR])
        if (target)
          target.innerHTML = code.createSvgTag({
            cellSize: 4,
            margin: 4,
            scalable: true,
          });
      this.qrURL = this.shareURL;
    },
    /** @returns {Promise<void>} */
    async copyLink() {
      try {
        await navigator.clipboard.writeText(this.shareURL);
        this.copied = true;
        setTimeout(() => (this.copied = false), 2000);
      } catch {
        this.error = this.t("Select and copy the table link to invite your friends.");
      }
    },
    /** @returns {Promise<void>} */
    async share() {
      if (navigator.share) {
        try {
          await navigator.share({
            title: this.t("Take your seat at Bataq"),
            text: this.t("Join me for a game of Batak."),
            url: this.shareURL,
          });
        } catch (e) {
          if (e.name !== "AbortError") this.copyLink();
        }
      } else this.copyLink();
    },
    /** @returns {Promise<void>} */
    async install() {
      await this.installPrompt?.prompt();
      this.installPrompt = null;
    },
  }));
});
