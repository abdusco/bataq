package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"
)

func TestListenAddress(t *testing.T) {
	for _, tt := range []struct {
		name, port, addr, want string
		invalid                bool
	}{
		{"default", "", "", ":8080", false},
		{"port", "3000", "", ":3000", false},
		{"port wins", "4000", ":3000", ":4000", false},
		{"address fallback", "", "127.0.0.1:3000", "127.0.0.1:3000", false},
		{"invalid text", "abc", "", "", true},
		{"invalid low", "0", "", "", true},
		{"invalid high", "65536", "", "", true},
	} {
		t.Run(tt.name, func(t *testing.T) {
			t.Setenv("PORT", tt.port)
			t.Setenv("ADDR", tt.addr)
			got, err := listenAddress()
			if (err != nil) != tt.invalid || got != tt.want {
				t.Fatalf("got %q %v", got, err)
			}
		})
	}
}

func TestAssetServing(t *testing.T) {
	for _, tt := range []struct{ name, debug string }{{"embedded", ""}, {"disk", "1"}} {
		t.Run(tt.name, func(t *testing.T) {
			t.Setenv("DEBUG", tt.debug)
			h := newServer().handler()
			for _, path := range []string{"/", "/main.js", "/translations.js", "/style.css", "/sw.js", "/icon-192.png", "/manifest.webmanifest", "/vendor/alpine.min.js"} {
				w := httptest.NewRecorder()
				h.ServeHTTP(w, httptest.NewRequest(http.MethodGet, path, nil))
				if w.Code != http.StatusOK || w.Body.Len() == 0 {
					t.Fatalf("%s: %d", path, w.Code)
				}
				if tt.debug == "1" && w.Header().Get("Cache-Control") != "no-cache" {
					t.Fatal("disk assets cached")
				}
			}
		})
	}
}

func TestDiskAssetsReadLive(t *testing.T) {
	t.Setenv("DEBUG", "1")
	directory := t.TempDir()
	if err := os.Mkdir(directory+"/assets", 0700); err != nil {
		t.Fatal(err)
	}
	t.Chdir(directory)
	h := newServer().handler()
	for _, content := range []string{"first", "updated"} {
		if err := os.WriteFile("assets/index.html", []byte(content), 0600); err != nil {
			t.Fatal(err)
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest("GET", "/", nil))
		if strings.TrimSpace(w.Body.String()) != content {
			t.Fatal("disk change requires rebuild")
		}
	}
}

func TestExpireRooms(t *testing.T) {
	s := newServer()
	now := time.Now()
	room := NewRoom("ROOM")
	room.Updated = now.Add(-25 * time.Hour)
	p, _ := NewPlayer("PLAYER", "Ada")
	room.Players = []*Player{p}
	s.rooms[room.ID] = room
	ch := make(chan []byte, 1)
	s.streams[p.ID] = map[chan []byte]bool{ch: true}
	s.expireRooms(now)
	if s.rooms[room.ID] == nil {
		t.Fatal("connected room expired")
	}
	delete(s.streams, p.ID)
	s.expireRooms(now)
	if s.rooms[room.ID] != nil {
		t.Fatal("abandoned room retained")
	}
}
