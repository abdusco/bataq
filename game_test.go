package main

import (
	"reflect"
	"strings"
	"testing"
)

func TestAddBots(t *testing.T) {
	for _, tt := range []struct {
		name   string
		humans int
	}{
		{"one human", 1},
		{"two humans", 2},
		{"three humans", 3},
		{"full table", 4},
	} {
		t.Run(tt.name, func(t *testing.T) {
			r := &Room{Phase: PhaseLobby}
			for i := 0; i < tt.humans; i++ {
				r.Players = append(r.Players, &Player{Name: "Human"})
			}
			if err := r.Apply(0, Move{Kind: ActionAddBots}); err != nil {
				t.Fatal(err)
			}
			if len(r.Players) != PlayerCount {
				t.Fatalf("got %d players, want %d", len(r.Players), PlayerCount)
			}
			seen := map[string]bool{}
			for i, p := range r.Players {
				if i < tt.humans {
					if p.Bot || p.Name != "Human" {
						t.Fatal("human player changed")
					}
					continue
				}
				if !p.Bot || !p.Online || p.ID == "" || !strings.HasSuffix(p.Name, " · bot") {
					t.Fatalf("invalid bot: %+v", p)
				}
				if seen[p.Name] {
					t.Fatalf("duplicate bot name: %s", p.Name)
				}
				seen[p.Name] = true
			}
			if err := r.Apply(0, Move{Kind: ActionAddBots}); err != nil {
				t.Fatal(err)
			}
			if len(r.Players) != PlayerCount {
				t.Fatal("adding bots twice changed a full table")
			}
		})
	}
}

func TestLegalCards(t *testing.T) {
	for _, tt := range []struct {
		name       string
		broken     bool
		trick      []Play
		hand, want []Card
	}{
		{"unbroken lead", false, nil, []Card{{0, 14}, {1, 2}}, []Card{{1, 2}}},
		{"only spades lead", false, nil, []Card{{0, 14}, {0, 2}}, []Card{{0, 14}, {0, 2}}},
		{"broken lead", true, nil, []Card{{0, 14}, {1, 2}}, []Card{{0, 14}, {1, 2}}},
		{"follow and beat", false, []Play{{0, Card{1, 10}}}, []Card{{1, 14}, {1, 2}, {0, 14}}, []Card{{1, 14}}},
		{"follow even when trumped", true, []Play{{0, Card{1, 10}}, {1, Card{0, 3}}}, []Card{{1, 14}, {1, 2}, {0, 14}}, []Card{{1, 14}, {1, 2}}},
		{"trump when void", false, []Play{{0, Card{1, 10}}}, []Card{{0, 2}, {2, 14}}, []Card{{0, 2}}},
		{"overtrump", true, []Play{{0, Card{1, 10}}, {1, Card{0, 10}}}, []Card{{0, 2}, {0, 14}, {2, 14}}, []Card{{0, 14}}},
		{"undertrump required", true, []Play{{0, Card{1, 10}}, {1, Card{0, 14}}}, []Card{{0, 2}, {2, 14}}, []Card{{0, 2}}},
		{"discard when void", true, []Play{{0, Card{1, 10}}}, []Card{{2, 2}, {3, 14}}, []Card{{2, 2}, {3, 14}}},
	} {
		t.Run(tt.name, func(t *testing.T) {
			r := &Room{Broken: tt.broken, Trick: tt.trick}
			if got := r.LegalCards(&Player{Hand: tt.hand}); !reflect.DeepEqual(got, tt.want) {
				t.Fatalf("got %v, want %v", got, tt.want)
			}
		})
	}
}

func TestCompleteGame(t *testing.T) {
	for game := 0; game < 20; game++ {
		r := &Room{Phase: PhaseLobby}
		for i := 0; i < 4; i++ {
			r.Players = append(r.Players, &Player{})
		}
		totals := [4]int{}
		for round := 1; round <= 5; round++ {
			r.deal()
			seen := map[Card]bool{}
			for _, p := range r.Players {
				if len(p.Hand) != 13 {
					t.Fatal("wrong hand size")
				}
				for _, c := range p.Hand {
					if seen[c] {
						t.Fatal("duplicate card")
					}
					seen[c] = true
				}
			}
			if r.Turn != (r.Dealer+1)%4 {
				t.Fatal("wrong first bidder")
			}
			if err := r.Bid((r.Turn+1)%4, 3); err == nil {
				t.Fatal("out-of-turn bid accepted")
			}
			if err := r.Bid(r.Turn, 4); err == nil {
				t.Fatal("opening bid below five accepted")
			}
			for r.Phase == PhaseBidding {
				n := r.Players[r.Turn].EstimatedBid()
				if n <= r.HighBid {
					n = 0
				}
				if err := r.Bid(r.Turn, n); err != nil {
					t.Fatal(err)
				}
			}
			if err := r.ChooseTrump((r.Bidder+1)%4, 0); err == nil {
				t.Fatal("nonbidder chose trump")
			}
			if err := r.ChooseTrump(r.Bidder, Suit(game%4)); err != nil {
				t.Fatal(err)
			}
			if r.Turn != r.Bidder {
				t.Fatal("bidder did not lead")
			}
			for r.Phase == PhasePlaying || r.Phase == PhaseTrick {
				if r.Phase == PhaseTrick {
					r.finishTrick()
					continue
				}
				seat := r.Turn
				legal := r.LegalCards(r.Players[seat])
				if len(legal) == 0 {
					t.Fatal("no legal moves")
				}
				if err := r.Play((seat+1)%4, legal[0]); err == nil {
					t.Fatal("out-of-turn play accepted")
				}
				if err := r.Play(seat, Card{9, 99}); err == nil {
					t.Fatal("nonexistent card accepted")
				}
				if err := r.Play(seat, legal[0]); err != nil {
					t.Fatal(err)
				}
			}
			tricks := 0
			for i, p := range r.Players {
				tricks += p.Tricks
				points := p.Tricks
				if (i == r.Bidder && p.Tricks < r.HighBid) || (i != r.Bidder && p.Tricks == 0) {
					points = -r.HighBid
				}
				totals[i] += points
				if p.Score != totals[i] {
					t.Fatal("wrong score")
				}
			}
			if tricks != 13 {
				t.Fatalf("got %d tricks", tricks)
			}
			if len(r.History) != round {
				t.Fatal("missing round result")
			}
			if round < 5 && r.Phase != PhaseRound {
				t.Fatal("round not ended")
			}
			r.Dealer = (r.Dealer + 1) % 4
		}
		if r.Phase != PhaseFinished {
			t.Fatal("game did not end")
		}
	}
}

func TestAuction(t *testing.T) {
	for _, tt := range []struct {
		name         string
		bids         []int
		bidder, high int
	}{
		{"all pass", []int{0, 0, 0, 0}, 1, 4},
		{"first bidder wins", []int{5, 0, 0, 0}, 1, 5},
		{"raise skips passed players", []int{5, 0, 6, 0, 7, 0}, 1, 7},
		{"last player opens", []int{0, 0, 0, 5}, 0, 5},
		{"thirteen ends auction", []int{13}, 1, 13},
	} {
		t.Run(tt.name, func(t *testing.T) {
			r := &Room{Phase: PhaseLobby}
			for i := 0; i < 4; i++ {
				r.Players = append(r.Players, &Player{})
			}
			r.deal()
			for _, n := range tt.bids {
				if err := r.Bid(r.Turn, n); err != nil {
					t.Fatal(err)
				}
			}
			if r.Phase != PhaseTrump || r.Bidder != tt.bidder || r.HighBid != tt.high {
				t.Fatalf("wrong auction result: phase=%s bidder=%d high=%d", r.Phase, r.Bidder, r.HighBid)
			}
			if err := r.ChooseTrump(r.Bidder, 4); err == nil {
				t.Fatal("invalid trump accepted")
			}
			if err := r.ChooseTrump(r.Bidder, 2); err != nil {
				t.Fatal(err)
			}
			for i, p := range r.Players {
				want := 1
				if i == r.Bidder {
					want = r.HighBid
				}
				if p.Bid != want {
					t.Fatal("wrong trick target")
				}
			}
		})
	}
}

func TestEachTrumpSuit(t *testing.T) {
	for trump := Spades; trump <= Clubs; trump++ {
		r := &Room{Trump: trump, Broken: true, Trick: []Play{{0, Card{(trump + 1) % 4, 14}}, {1, Card{trump, 8}}}}
		p := &Player{Hand: []Card{{trump, 2}, {trump, 10}, {(trump + 2) % 4, 14}}}
		if got := r.LegalCards(p); !reflect.DeepEqual(got, []Card{{trump, 10}}) {
			t.Fatalf("trump %d: got %v", trump, got)
		}
		if r.Trick.Winner(trump) != 1 {
			t.Fatal("trump did not win")
		}
	}
}
