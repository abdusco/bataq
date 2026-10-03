package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
)

func TestSignedSessions(t *testing.T) {
	s := newServer()
	claims := Claims{"ROOM", "PLAYER"}
	token := s.sign(claims)
	for _, tt := range []struct {
		name, token string
		server      *Server
		valid       bool
	}{
		{"valid", token, s, true},
		{"tampered payload", "e30." + strings.Split(token, ".")[1], s, false},
		{"tampered signature", strings.Split(token, ".")[0] + ".eA", s, false},
		{"malformed", "not-a-token", s, false},
		{"restart", token, newServer(), false},
	} {
		t.Run(tt.name, func(t *testing.T) {
			got, err := tt.server.verify(tt.token)
			if (err == nil) != tt.valid {
				t.Fatalf("unexpected verification: %v", err)
			}
			if tt.valid && got != claims {
				t.Fatal("claims changed")
			}
		})
	}
}

func TestHTTPGameAndPrivacy(t *testing.T) {
	s := newServer()
	h := s.handler()
	tokens := []string{}
	roomID := ""
	for i := 0; i < 4; i++ {
		b, _ := json.Marshal(Request{Name: "Player", Room: roomID})
		req := httptest.NewRequest("POST", "/api/join", bytes.NewReader(b))
		w := httptest.NewRecorder()
		h.ServeHTTP(w, req)
		if w.Code != 200 {
			t.Fatal(w.Body.String())
		}
		var data struct{ Token, Room string }
		json.Unmarshal(w.Body.Bytes(), &data)
		tokens = append(tokens, data.Token)
		roomID = data.Room
	}
	room := s.rooms[roomID]
	for _, tt := range []struct {
		name     string
		seat     int
		action   ActionKind
		revision int
		want     int
	}{
		{"nonhost", 1, "start", room.Revision, 400},
		{"stale", 0, "start", room.Revision - 1, 409},
		{"start", 0, "start", room.Revision, 200},
	} {
		t.Run(tt.name, func(t *testing.T) {
			b, _ := json.Marshal(Request{Token: tokens[tt.seat], Action: tt.action, Revision: tt.revision})
			w := httptest.NewRecorder()
			h.ServeHTTP(w, httptest.NewRequest("POST", "/api/action", bytes.NewReader(b)))
			if w.Code != tt.want {
				t.Fatalf("got %d: %s", w.Code, w.Body)
			}
		})
	}
	for i, token := range tokens {
		req := httptest.NewRequest("GET", "/api/session", nil)
		req.Header.Set("Authorization", token)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, req)
		var data struct {
			You  int
			Hand []Card
			Room struct{ Players []map[string]any }
		}
		json.Unmarshal(w.Body.Bytes(), &data)
		if data.You != i || len(data.Hand) != 13 {
			t.Fatal("wrong private snapshot")
		}
		for _, p := range data.Room.Players {
			if _, ok := p["hand"]; ok {
				t.Fatal("opponent hand leaked")
			}
		}
	}
	w := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/api/session", nil)
	req.Header.Set("Authorization", tokens[0])
	newServer().handler().ServeHTTP(w, req)
	if w.Code != 401 {
		t.Fatal("restart did not expire session")
	}
	w = httptest.NewRecorder()
	b, _ := json.Marshal(Request{Name: "Fifth", Room: roomID})
	h.ServeHTTP(w, httptest.NewRequest("POST", "/api/join", bytes.NewReader(b)))
	if w.Code != 409 {
		t.Fatal("fifth player admitted")
	}
	w = httptest.NewRecorder()
	req = httptest.NewRequest("POST", "/api/join", strings.NewReader(`{"name":"X"}`))
	req.Header.Set("Origin", "https://bataq.ngrok.app")
	h.ServeHTTP(w, req)
	if w.Code != 200 || w.Header().Get("Access-Control-Allow-Origin") != "https://bataq.ngrok.app" {
		t.Fatal("cross-origin join rejected")
	}
}

func TestCreatedRoomIDs(t *testing.T) {
	s := newServer()
	defer s.cancel()
	h := s.handler()
	var data struct{ Token, Room string }
	for i := 0; i < 100; i++ {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest("POST", "/api/join", strings.NewReader(`{"name":"Host"}`)))
		if w.Code != http.StatusOK {
			t.Fatal(w.Body.String())
		}
		if err := json.Unmarshal(w.Body.Bytes(), &data); err != nil {
			t.Fatal(err)
		}
		if len(data.Room) != 8 {
			t.Fatalf("room ID must contain eight characters: %q", data.Room)
		}
		for _, character := range data.Room {
			if !strings.ContainsRune("ABCDEFGHIJKLMNOPQRSTUVWXYZ234567", character) {
				t.Fatalf("room ID contains a non-base32 character: %q", data.Room)
			}
		}
	}
	if len(s.rooms) != 100 {
		t.Fatalf("created %d rooms, want 100", len(s.rooms))
	}
	for _, tt := range []struct {
		name, code string
	}{
		{"uppercase", data.Room},
		{"lowercase", strings.ToLower(data.Room)},
	} {
		t.Run(tt.name, func(t *testing.T) {
			b, _ := json.Marshal(Request{Name: "Friend", Room: tt.code})
			w := httptest.NewRecorder()
			h.ServeHTTP(w, httptest.NewRequest("POST", "/api/join", bytes.NewReader(b)))
			if w.Code != http.StatusOK {
				t.Fatal(w.Body.String())
			}
			var joined struct{ Room string }
			if err := json.Unmarshal(w.Body.Bytes(), &joined); err != nil {
				t.Fatal(err)
			}
			if joined.Room != data.Room {
				t.Fatalf("joined %q, want %q", joined.Room, data.Room)
			}
		})
	}
}

func TestCORS(t *testing.T) {
	for _, tt := range []struct {
		name, method, path, origin, body string
		status                           int
	}{
		{"preflight", "OPTIONS", "/api/action", "https://bataq.ngrok.app", "", 204},
		{"cloudflare", "OPTIONS", "/api/session", "https://bataq.trycloudflare.com", "", 204},
		{"session requires token", "GET", "/api/session", "https://bataq.ngrok.app", "", 401},
		{"socket requires token", "GET", "/api/live", "https://bataq.trycloudflare.com", "", 401},
		{"action requires token", "POST", "/api/action", "https://bataq.ngrok.app", `{"action":"start"}`, 401},
	} {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest(tt.method, tt.path, strings.NewReader(tt.body))
			req.Header.Set("Origin", tt.origin)
			req.Header.Set("Access-Control-Request-Headers", "Content-Type, Authorization")
			w := httptest.NewRecorder()
			newServer().handler().ServeHTTP(w, req)
			if w.Code != tt.status {
				t.Fatalf("got %d: %s", w.Code, w.Body)
			}
			if w.Header().Get("Access-Control-Allow-Origin") != tt.origin {
				t.Fatal("missing origin response")
			}
			if w.Header().Get("Access-Control-Allow-Headers") != "Content-Type, Authorization" {
				t.Fatal("missing allowed headers")
			}
			if w.Header().Get("Vary") != "Origin" {
				t.Fatal("missing origin cache variation")
			}
		})
	}
}

func TestWebSocketAndRefresh(t *testing.T) {
	s := newServer()
	defer s.cancel()
	ts := httptest.NewServer(s.handler())
	defer ts.Close()
	response, err := http.Post(ts.URL+"/api/join", "application/json", strings.NewReader(`{"name":"Ada"}`))
	if err != nil {
		t.Fatal(err)
	}
	var data struct{ Token, Room string }
	json.NewDecoder(response.Body).Decode(&data)
	response.Body.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	sockets := []*websocket.Conn{}
	for i := 0; i < 2; i++ {
		conn, _, err := websocket.Dial(ctx, ts.URL+"/api/live?token="+data.Token, &websocket.DialOptions{
			HTTPHeader: http.Header{"Origin": []string{"https://bataq.trycloudflare.com"}},
		})
		if err != nil {
			t.Fatal(err)
		}
		defer conn.CloseNow()
		sockets = append(sockets, conn)
		var message LiveMessage
		if err := wsjson.Read(ctx, conn, &message); err != nil || message.Kind != LiveMessageState {
			t.Fatalf("no initial snapshot: %v %v", message.Kind, err)
		}
		if !strings.Contains(string(message.Snapshot), `"online":true`) {
			t.Fatal("player not online")
		}
	}
	sockets[0].Close(websocket.StatusNormalClosure, "Refresh")
	req, _ := http.NewRequest("GET", ts.URL+"/api/session", nil)
	req.Header.Set("Authorization", data.Token)
	response, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	var snapshot struct{ Room Room }
	json.NewDecoder(response.Body).Decode(&snapshot)
	response.Body.Close()
	if !snapshot.Room.Players[0].Online {
		t.Fatal("old tab closed the new tab's seat")
	}
	// A live tab must receive presence updates and keep responding to pings.
	for {
		var message LiveMessage
		if err := wsjson.Read(ctx, sockets[1], &message); err != nil {
			t.Fatal(err)
		}
		if message.Kind == LiveMessageHeartbeat {
			break
		}
	}
	s.cancel()
	if _, _, err := sockets[1].Read(ctx); err == nil {
		t.Fatal("shutdown left WebSocket open")
	}
	deadline := time.Now().Add(time.Second)
	for {
		s.mu.Lock()
		online := s.rooms[data.Room].Players[0].Online
		s.mu.Unlock()
		if !online {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("last socket disconnect did not release presence")
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func TestWebSocketAuthentication(t *testing.T) {
	s := newServer()
	defer s.cancel()
	ts := httptest.NewServer(s.handler())
	defer ts.Close()
	for _, tt := range []struct {
		name, token string
	}{
		{"missing", ""},
		{"invalid", "invalid"},
		{"expired room", s.sign(Claims{"MISSING", "PLAYER"})},
		{"server restarted", newServer().sign(Claims{"ROOM", "PLAYER"})},
	} {
		t.Run(tt.name, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			conn, response, err := websocket.Dial(ctx, ts.URL+"/api/live?token="+tt.token, nil)
			if conn != nil {
				conn.CloseNow()
			}
			if err == nil || response == nil || response.StatusCode != http.StatusUnauthorized {
				t.Fatalf("unauthenticated upgrade: %v %v", response, err)
			}
		})
	}
}
