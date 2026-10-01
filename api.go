package main

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"embed"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io/fs"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
)

//go:embed assets
var assets embed.FS

type Server struct {
	ctx     context.Context
	cancel  context.CancelFunc
	mu      sync.Mutex
	rooms   map[string]*Room
	key     []byte
	streams map[string]map[chan []byte]bool
}

type LiveMessageKind string

const (
	LiveMessageState     LiveMessageKind = "state"
	LiveMessageHeartbeat LiveMessageKind = "heartbeat"
)

type LiveMessage struct {
	Kind     LiveMessageKind `json:"kind"`
	Snapshot json.RawMessage `json:"snapshot,omitempty"`
}
type Claims struct {
	Room   string `json:"room"`
	Player string `json:"player"`
}
type Request struct {
	Name     string     `json:"name"`
	Room     string     `json:"room"`
	Token    string     `json:"token"`
	Action   ActionKind `json:"action"`
	Bid      int        `json:"bid"`
	Suit     Suit       `json:"suit"`
	Card     Card       `json:"card"`
	Revision int        `json:"revision"`
}

func newServer() *Server {
	ctx, cancel := context.WithCancel(context.Background())
	return &Server{ctx: ctx, cancel: cancel, rooms: map[string]*Room{}, key: []byte(randomID(32)), streams: map[string]map[chan []byte]bool{}}
}
func (s *Server) sign(c Claims) string {
	b, _ := json.Marshal(c)
	p := base64.RawURLEncoding.EncodeToString(b)
	mac := hmac.New(sha256.New, s.key)
	mac.Write([]byte(p))
	return p + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}
func (s *Server) verify(token string) (Claims, error) {
	var c Claims
	parts := strings.Split(token, ".")
	if len(parts) != 2 {
		return c, errors.New("Invalid session key")
	}
	mac := hmac.New(sha256.New, s.key)
	mac.Write([]byte(parts[0]))
	sig, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil || !hmac.Equal(sig, mac.Sum(nil)) {
		return c, errors.New("This session has expired. The server may have restarted.")
	}
	b, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return c, err
	}
	err = json.Unmarshal(b, &c)
	return c, err
}
func (s *Server) player(token string) (*Room, *Player, int, error) {
	c, err := s.verify(token)
	if err != nil {
		return nil, nil, 0, err
	}
	room := s.rooms[c.Room]
	if room == nil {
		return nil, nil, 0, errors.New("This room has expired")
	}
	p, seat, err := room.Player(c.Player)
	return room, p, seat, err
}
func respond(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(v)
}
func fail(w http.ResponseWriter, code int, err error) {
	respond(w, code, map[string]string{"error": err.Error()})
}
func decode(w http.ResponseWriter, r *http.Request, v any) error {
	return json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(v)
}
func (s *Server) join(w http.ResponseWriter, r *http.Request) {
	var q Request
	if err := decode(w, r, &q); err != nil {
		fail(w, http.StatusBadRequest, err)
		return
	}
	p, err := NewPlayer(randomID(16), q.Name)
	if err != nil {
		fail(w, http.StatusBadRequest, err)
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	var room *Room
	if q.Room == "" {
		if len(s.rooms) >= 1000 {
			fail(w, http.StatusServiceUnavailable, errors.New("All tables are occupied. Try again later."))
			return
		}
		id := strings.ToUpper(randomID(5))
		for s.rooms[id] != nil {
			id = strings.ToUpper(randomID(5))
		}
		room = NewRoom(id)
		s.rooms[id] = room
	} else {
		room = s.rooms[strings.ToUpper(q.Room)]
		if room == nil {
			fail(w, http.StatusNotFound, errors.New("This room does not exist. It may have expired or the server restarted."))
			return
		}
	}
	if err := room.AddPlayer(p); err != nil {
		fail(w, http.StatusConflict, err)
		return
	}
	s.publish(room)
	respond(w, http.StatusOK, map[string]any{"token": s.sign(Claims{room.ID, p.ID}), "room": room.ID})
}
func (s *Server) snapshot(r *Room, seat int) []byte {
	b, _ := json.Marshal(r.ViewFor(seat))
	return b
}
func (s *Server) publish(r *Room) {
	r.Sequence++
	r.Updated = time.Now()
	for i, p := range r.Players {
		b := s.snapshot(r, i)
		for ch := range s.streams[p.ID] {
			select {
			case ch <- b:
			default:
				select {
				case <-ch:
				default:
				}
				select {
				case ch <- b:
				default:
				}
			}
		}
	}
}
func (s *Server) action(w http.ResponseWriter, r *http.Request) {
	var q Request
	if err := decode(w, r, &q); err != nil {
		fail(w, http.StatusBadRequest, err)
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	room, _, seat, err := s.player(q.Token)
	if err != nil {
		fail(w, http.StatusUnauthorized, err)
		return
	}
	if q.Revision != room.Revision {
		fail(w, http.StatusConflict, errors.New("The table changed. Your view is updating; try again."))
		return
	}
	if err := room.Apply(seat, Move{Kind: q.Action, Bid: q.Bid, Suit: q.Suit, Card: q.Card}); err != nil {
		fail(w, http.StatusBadRequest, err)
		return
	}
	s.publish(room)
	s.schedule(room)
	respond(w, http.StatusOK, map[string]bool{"ok": true})
}
func (s *Server) schedule(r *Room) {
	if !r.HasAutomaticTurn() {
		return
	}
	id, revision := r.ID, r.Revision
	delay := 750 * time.Millisecond
	if r.Phase == PhaseTrick {
		delay = 1700 * time.Millisecond
	}
	time.AfterFunc(delay, func() {
		s.mu.Lock()
		defer s.mu.Unlock()
		room := s.rooms[id]
		if room == nil {
			return
		}
		if room.Revision != revision {
			s.schedule(room)
			return
		}
		if err := room.Advance(); err != nil {
			return
		}
		s.publish(room)
		s.schedule(room)
	})
}
func (s *Server) live(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	_, _, _, err := s.player(r.URL.Query().Get("token"))
	s.mu.Unlock()
	if err != nil {
		fail(w, http.StatusUnauthorized, err)
		return
	}
	// Any origin may connect with a signed bearer key, just as with our HTTP API.
	// We never authenticate WebSockets through ambient cookies.
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
	if err != nil {
		return
	}
	defer conn.CloseNow()
	ctx := conn.CloseRead(s.ctx)
	s.mu.Lock()
	room, p, seat, err := s.player(r.URL.Query().Get("token"))
	if err != nil {
		s.mu.Unlock()
		conn.Close(websocket.StatusPolicyViolation, "Session expired")
		return
	}
	ch := make(chan []byte, 1)
	if s.streams[p.ID] == nil {
		s.streams[p.ID] = map[chan []byte]bool{}
	}
	s.streams[p.ID][ch] = true
	room.SetOnline(seat, true)
	s.publish(room)
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		defer s.mu.Unlock()
		delete(s.streams[p.ID], ch)
		room.SetOnline(seat, len(s.streams[p.ID]) > 0)
		if len(s.streams[p.ID]) == 0 {
			delete(s.streams, p.ID)
		}
		s.publish(room)
	}()
	ticker := time.NewTicker(10 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case b := <-ch:
			message, _ := json.Marshal(LiveMessage{Kind: LiveMessageState, Snapshot: b})
			writeCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
			err := conn.Write(writeCtx, websocket.MessageText, message)
			cancel()
			if err != nil {
				return
			}
		case <-ticker.C:
			heartbeatCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
			// The browser answers control pings automatically. A JSON heartbeat
			// also lets the client detect a stalled connection after phone sleep.
			err := conn.Ping(heartbeatCtx)
			if err == nil {
				message, _ := json.Marshal(LiveMessage{Kind: LiveMessageHeartbeat})
				err = conn.Write(heartbeatCtx, websocket.MessageText, message)
			}
			cancel()
			if err != nil {
				return
			}
		}
	}
}
func (s *Server) session(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	room, _, seat, err := s.player(r.Header.Get("Authorization"))
	if err != nil {
		fail(w, 401, err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.Write(s.snapshot(room, seat))
}
func (s *Server) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/join", s.join)
	mux.HandleFunc("POST /api/action", s.action)
	mux.HandleFunc("GET /api/live", s.live)
	mux.HandleFunc("GET /api/session", s.session)
	var assetFiles fs.FS
	if os.Getenv("DEBUG") == "1" {
		assetFiles = os.DirFS("assets")
	} else {
		assetFiles, _ = fs.Sub(assets, "assets")
	}
	files := http.FileServer(http.FS(assetFiles))
	mux.HandleFunc("GET /", func(w http.ResponseWriter, r *http.Request) {
		if os.Getenv("DEBUG") == "1" || r.URL.Path == "/sw.js" || r.URL.Path == "/index.html" || r.URL.Path == "/" {
			w.Header().Set("Cache-Control", "no-cache")
		}
		files.ServeHTTP(w, r)
	})
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/") {
			if origin := r.Header.Get("Origin"); origin != "" {
				w.Header().Set("Access-Control-Allow-Origin", origin)
				w.Header().Add("Vary", "Origin")
				w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
				w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
				w.Header().Set("Access-Control-Max-Age", "600")
			}
			if r.Method == http.MethodOptions {
				w.WriteHeader(http.StatusNoContent)
				return
			}
		}
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		mux.ServeHTTP(w, r)
	})
}

func (s *Server) expireRooms(now time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for id, room := range s.rooms {
		connected := false
		for _, p := range room.Players {
			if len(s.streams[p.ID]) > 0 {
				connected = true
				break
			}
		}
		if !connected && now.Sub(room.Updated) > 24*time.Hour {
			delete(s.rooms, id)
			for _, p := range room.Players {
				delete(s.streams, p.ID)
			}
		}
	}
}
