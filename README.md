# Bataq

Real-time, four-player İhaleli Batak.

## Run

```sh
go run .
```

Open http://localhost:8080, enter your name, and share the room link or QR code. Fill empty seats with bots if needed. Rules are available in the app.

- `PORT=3000` changes the port. `ADDR` sets the bind address when `PORT` is unset.
- `DEBUG=1` reads `assets/` from disk; otherwise assets are embedded in the binary.
- The side menu saves language (English/Türkçe) and appearance (Light/Dark/System) preferences.

Refresh or reconnect to return to your seat with a signed session key. **Restarting the server clears all rooms and sessions.** Offline mode only caches the app shell.

## Test on your phone

```sh
PORT=3000 DEBUG=1 go run .
# In another terminal:
cloudflared tunnel --url http://127.0.0.1:3000
```

Open the tunnel URL on both devices and share the room link. HTTPS enables PWA installation; reverse proxies must support WebSocket upgrades on `/api/live`.

## Docker

```sh
docker compose up -d
```

Uses `ghcr.io/abdusco/bataq:v1.0.0`. Set `PORT` to change the host port or `BATAQ_VERSION` to choose another release. Use `docker compose up -d --build` to build locally. Pushing a `v*` tag runs tests, publishes images for amd64 and arm64 to GHCR, and creates a GitHub release.

## Development

`main.go` bootstraps the server, `api.go` handles HTTP and live connections, `game.go` owns the game rules, and `assets/` contains the frontend and vendor licenses.

```sh
go test -race ./...
go vet ./...
node --test tests/client.test.cjs
gofmt -w *.go
bunx prettier --write .
```

Optional browser tests, with the server running and Playwright installed:

```sh
PLAYWRIGHT_MODULE=/path/to/playwright node tests/browser.cjs
```
