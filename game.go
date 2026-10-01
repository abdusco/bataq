package main

import (
	"crypto/rand"
	"encoding/base64"
	"errors"
	"math/big"
	"sort"
	"strings"
	"time"
	"unicode/utf8"
)

type Phase string

const (
	PhaseLobby    Phase = "lobby"
	PhaseBidding  Phase = "bidding"
	PhaseTrump    Phase = "trump"
	PhasePlaying  Phase = "playing"
	PhaseTrick    Phase = "trick"
	PhaseRound    Phase = "round"
	PhaseFinished Phase = "finished"
)

type Suit int

const NoTrump Suit = -1

const (
	Spades Suit = iota
	Hearts
	Diamonds
	Clubs
)

func (s Suit) Valid() bool { return s >= Spades && s <= Clubs }

type ActionKind string

const (
	ActionAddBots ActionKind = "bots"
	ActionStart   ActionKind = "start"
	ActionBid     ActionKind = "bid"
	ActionTrump   ActionKind = "trump"
	ActionPlay    ActionKind = "play"
	ActionNext    ActionKind = "next"
	ActionRematch ActionKind = "rematch"
)

const (
	PlayerCount = 4
	RoundCount  = 5
	MinimumBid  = 5
	MaxTricks   = 13
	Jack        = 11
	Queen       = 12
	King        = 13
	Ace         = 14
)

type Move struct {
	Kind ActionKind
	Bid  int
	Suit Suit
	Card Card
}

type Card struct {
	Suit Suit `json:"suit"`
	Rank int  `json:"rank"`
}
type Play struct {
	Seat int  `json:"seat"`
	Card Card `json:"card"`
}

type Trick []Play
type Player struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Bot    bool   `json:"bot"`
	Online bool   `json:"online"`
	Bid    int    `json:"bid"`
	Passed bool   `json:"passed"`
	Tricks int    `json:"tricks"`
	Score  int    `json:"score"`
	Hand   []Card `json:"-"`
}
type RoundResult struct {
	Round  int    `json:"round"`
	Bids   [4]int `json:"bids"`
	Tricks [4]int `json:"tricks"`
	Points [4]int `json:"points"`
}
type Room struct {
	ID        string        `json:"id"`
	Players   []*Player     `json:"players"`
	Phase     Phase         `json:"phase"`
	Round     int           `json:"round"`
	Turn      int           `json:"turn"`
	Dealer    int           `json:"dealer"`
	Host      int           `json:"host"`
	Trump     Suit          `json:"trump"`
	Bidder    int           `json:"bidder"`
	HighBid   int           `json:"highBid"`
	Trick     Trick         `json:"trick"`
	LastTrick Trick         `json:"lastTrick"`
	Winner    int           `json:"winner"`
	Broken    bool          `json:"broken"`
	History   []RoundResult `json:"history"`
	Revision  int           `json:"revision"`
	Sequence  int           `json:"sequence"`
	Updated   time.Time     `json:"-"`
}

// Room methods own game invariants. The caller serializes concurrent access;
// HTTP handlers, sessions, subscribers, and timers belong to the API layer.
func NewRoom(id string) *Room {
	return &Room{ID: id, Phase: PhaseLobby, Winner: -1, Trump: NoTrump, Bidder: -1, Updated: time.Now()}
}

func NewPlayer(id, name string) (*Player, error) {
	name = strings.TrimSpace(name)
	if utf8.RuneCountInString(name) < 1 || utf8.RuneCountInString(name) > 24 {
		return nil, errors.New("Use a name between 1 and 24 characters")
	}
	return &Player{ID: id, Name: name, Hand: []Card{}}, nil
}

func (r *Room) AddPlayer(p *Player) error {
	if r.Phase != PhaseLobby || len(r.Players) >= PlayerCount {
		return errors.New("This table is full or already playing")
	}
	for _, seated := range r.Players {
		if seated.ID == p.ID {
			return errors.New("Player already seated")
		}
	}
	r.Players = append(r.Players, p)
	r.Revision++
	return nil
}

func (r *Room) Player(id string) (*Player, int, error) {
	for seat, p := range r.Players {
		if p.ID == id {
			return p, seat, nil
		}
	}
	return nil, 0, errors.New("Player not found")
}

func (r *Room) SetOnline(seat int, online bool) {
	r.Players[seat].Online = online
	if !r.Players[r.Host].Online {
		for i, p := range r.Players {
			if !p.Bot && p.Online {
				r.Host = i
				break
			}
		}
	}
}

func (c Card) Valid() bool { return c.Suit.Valid() && c.Rank >= 2 && c.Rank <= Ace }

func (p *Player) RemoveCard(card Card) bool {
	for i, c := range p.Hand {
		if c == card {
			p.Hand = append(p.Hand[:i], p.Hand[i+1:]...)
			return true
		}
	}
	return false
}

func (p *Player) RoundPoints(contract int, bidder bool) int {
	if (bidder && p.Tricks < contract) || (!bidder && p.Tricks == 0) {
		return -contract
	}
	return p.Tricks
}

func (r *Room) Apply(seat int, move Move) error {
	if seat < 0 || seat >= len(r.Players) {
		return errors.New("Player not found")
	}
	var err error
	switch move.Kind {
	case ActionAddBots:
		if seat != r.Host || r.Phase != PhaseLobby {
			return errors.New("Only the host can add bots in the lobby")
		}
		names := []string{"Ada", "Deniz", "Efe"}
		for len(r.Players) < PlayerCount {
			p, _ := NewPlayer(randomID(16), names[len(r.Players)-1]+" · bot")
			p.Bot, p.Online = true, true
			r.Players = append(r.Players, p)
		}
	case ActionStart:
		if seat != r.Host || r.Phase != PhaseLobby || len(r.Players) != PlayerCount {
			return errors.New("The host can start with four players")
		}
		r.deal()
	case ActionBid:
		err = r.Bid(seat, move.Bid)
	case ActionTrump:
		err = r.ChooseTrump(seat, move.Suit)
	case ActionPlay:
		err = r.Play(seat, move.Card)
	case ActionNext:
		if seat != r.Host || r.Phase != PhaseRound {
			return errors.New("Only the host can deal the next round")
		}
		r.Dealer = (r.Dealer + 1) % PlayerCount
		r.deal()
	case ActionRematch:
		if seat != r.Host || r.Phase != PhaseFinished {
			return errors.New("Only the host can start a rematch")
		}
		r.Round = 0
		r.History = nil
		for _, p := range r.Players {
			p.Score = 0
		}
		r.Dealer = (r.Dealer + 1) % PlayerCount
		r.deal()
	default:
		return errors.New("Unknown action")
	}
	if err == nil {
		r.Revision++
	}
	return err
}

func (r *Room) HasAutomaticTurn() bool {
	return r.Phase == PhaseTrick || ((r.Phase == PhaseBidding || r.Phase == PhaseTrump || r.Phase == PhasePlaying) && r.Players[r.Turn].Bot)
}

// Advance resolves a completed trick or makes one bot decision. Timing is external.
func (r *Room) Advance() error {
	if !r.HasAutomaticTurn() {
		return errors.New("No automatic turn available")
	}
	if r.Phase == PhaseTrick {
		r.finishTrick()
		r.Revision++
		return nil
	}
	p := r.Players[r.Turn]
	switch r.Phase {
	case PhaseBidding:
		n := p.EstimatedBid()
		if n <= r.HighBid {
			n = 0
		}
		return r.Apply(r.Turn, Move{Kind: ActionBid, Bid: n})
	case PhaseTrump:
		return r.Apply(r.Turn, Move{Kind: ActionTrump, Suit: p.PreferredTrump()})
	case PhasePlaying:
		cards := r.LegalCards(p)
		chosen := cards[len(cards)-1]
		for _, c := range cards {
			if c.Suit != r.Trump && c.Rank < chosen.Rank {
				chosen = c
			}
		}
		return r.Apply(r.Turn, Move{Kind: ActionPlay, Card: chosen})
	}
	return errors.New("No automatic turn available")
}

type Snapshot struct {
	Room  *Room  `json:"room"`
	You   int    `json:"you"`
	Hand  []Card `json:"hand"`
	Legal []Card `json:"legal"`
}

func (r *Room) ViewFor(seat int) Snapshot {
	legal := []Card{}
	if r.Phase == PhasePlaying && r.Turn == seat {
		legal = r.LegalCards(r.Players[seat])
	}
	return Snapshot{Room: r, You: seat, Hand: r.Players[seat].Hand, Legal: legal}
}

func randomID(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return base64.RawURLEncoding.EncodeToString(b)
}

func (r *Room) LegalCards(p *Player) []Card {
	h := p.Hand
	if len(r.Trick) == 0 {
		if r.Broken {
			return h
		}
		a := []Card{}
		for _, c := range h {
			if c.Suit != r.Trump {
				a = append(a, c)
			}
		}
		if len(a) > 0 {
			return a
		}
		return h
	}
	lead := r.Trick[0].Card.Suit
	follow := []Card{}
	trumps := []Card{}
	for _, c := range h {
		if c.Suit == lead {
			follow = append(follow, c)
		}
		if c.Suit == r.Trump {
			trumps = append(trumps, c)
		}
	}
	pool := h
	if len(follow) > 0 {
		pool = follow
	} else if len(trumps) > 0 {
		pool = trumps
	} else {
		return pool
	}
	winning := r.Trick[r.Trick.Winner(r.Trump)].Card
	higher := []Card{}
	for _, c := range pool {
		if c.Beats(winning, lead, r.Trump) {
			higher = append(higher, c)
		}
	}
	if len(higher) > 0 {
		return higher
	}
	return pool
}
func (a Card) Beats(b Card, lead, trump Suit) bool {
	if a.Suit == b.Suit {
		return a.Rank > b.Rank
	}
	return a.Suit == trump || (b.Suit != trump && a.Suit == lead)
}
func (t Trick) Winner(trump Suit) int {
	best := 0
	for i := 1; i < len(t); i++ {
		if t[i].Card.Beats(t[best].Card, t[0].Card.Suit, trump) {
			best = i
		}
	}
	return best
}
func (r *Room) deal() {
	r.Round++
	r.Phase = PhaseBidding
	r.Turn = (r.Dealer + 1) % PlayerCount
	r.Trick = []Play{}
	r.LastTrick = []Play{}
	r.Broken = false
	r.Winner = -1
	r.Trump = NoTrump
	r.Bidder = -1
	r.HighBid = 0
	deck := []Card{}
	for suit := Spades; suit <= Clubs; suit++ {
		for rank := 2; rank <= Ace; rank++ {
			deck = append(deck, Card{suit, rank})
		}
	}
	for i := len(deck) - 1; i > 0; i-- {
		j, err := rand.Int(rand.Reader, big.NewInt(int64(i+1)))
		if err != nil {
			panic(err)
		}
		deck[i], deck[j.Int64()] = deck[j.Int64()], deck[i]
	}
	for i, p := range r.Players {
		p.Bid = 0
		p.Passed = false
		p.Tricks = 0
		p.Hand = append([]Card{}, deck[i*MaxTricks:(i+1)*MaxTricks]...)
		sort.Slice(p.Hand, func(i, j int) bool {
			a, b := p.Hand[i], p.Hand[j]
			if a.Suit == b.Suit {
				return a.Rank > b.Rank
			}
			return a.Suit < b.Suit
		})
	}
}
func (r *Room) Bid(seat, n int) error {
	if r.Phase != PhaseBidding || r.Turn != seat {
		return errors.New("Wait for your bidding turn")
	}
	if n == 0 {
		r.Players[seat].Passed = true
	} else {
		if n < MinimumBid || n > MaxTricks || n <= r.HighBid {
			return errors.New("Bid 5–13, higher than the current bid, or pass")
		}
		r.Players[seat].Bid = n
		r.HighBid = n
		r.Bidder = seat
	}
	active := 0
	for _, p := range r.Players {
		if !p.Passed {
			active++
		}
	}
	if active == 0 {
		r.Bidder = (r.Dealer + 1) % PlayerCount
		r.HighBid = 4
		r.Players[r.Bidder].Bid = 4
	}
	if active == 0 || (active == 1 && r.Bidder >= 0) || r.HighBid == MaxTricks {
		r.Phase = PhaseTrump
		r.Turn = r.Bidder
		return nil
	}
	for step := 1; step <= PlayerCount; step++ {
		next := (seat + step) % PlayerCount
		if !r.Players[next].Passed && next != r.Bidder {
			r.Turn = next
			break
		}
	}
	return nil
}
func (r *Room) ChooseTrump(seat int, suit Suit) error {
	if r.Phase != PhaseTrump || seat != r.Bidder {
		return errors.New("Only the auction winner chooses trump")
	}
	if !suit.Valid() {
		return errors.New("Choose a valid trump suit")
	}
	r.Trump = suit
	for i, p := range r.Players {
		if i == r.Bidder {
			p.Bid = r.HighBid
		} else {
			p.Bid = 1
		}
	}
	r.Phase = PhasePlaying
	r.Turn = r.Bidder
	return nil
}
func (r *Room) Play(seat int, c Card) error {
	if r.Phase != PhasePlaying || r.Turn != seat {
		return errors.New("Wait for your turn")
	}
	p := r.Players[seat]
	valid := false
	for _, a := range r.LegalCards(p) {
		if a == c {
			valid = true
		}
	}
	if !valid {
		return errors.New("Follow suit, beat the leading card if possible, otherwise trump")
	}
	p.RemoveCard(c)
	if c.Suit == r.Trump {
		r.Broken = true
	}
	r.Trick = append(r.Trick, Play{seat, c})
	r.Turn = (seat + 1) % PlayerCount
	if len(r.Trick) == PlayerCount {
		r.Winner = r.Trick[r.Trick.Winner(r.Trump)].Seat
		r.Players[r.Winner].Tricks++
		r.Turn = r.Winner
		r.Phase = PhaseTrick
	}
	return nil
}
func (r *Room) finishTrick() {
	r.LastTrick = append([]Play{}, r.Trick...)
	r.Trick = []Play{}
	if len(r.Players[0].Hand) > 0 {
		r.Phase = PhasePlaying
		return
	}
	result := RoundResult{Round: r.Round}
	for i, p := range r.Players {
		points := p.RoundPoints(r.HighBid, i == r.Bidder)
		p.Score += points
		result.Bids[i] = p.Bid
		result.Tricks[i] = p.Tricks
		result.Points[i] = points
	}
	r.History = append(r.History, result)
	r.Phase = PhaseRound
	if r.Round >= RoundCount {
		r.Phase = PhaseFinished
	}
}

func (p *Player) PreferredTrump() Suit {
	weights := [4]int{}
	for _, c := range p.Hand {
		weights[c.Suit] += 3
		if c.Rank >= 11 {
			weights[c.Suit] += c.Rank - 10
		}
	}
	best := Spades
	for suit := Hearts; suit <= Clubs; suit++ {
		if weights[suit] > weights[best] {
			best = suit
		}
	}
	return best
}
func (p *Player) EstimatedBid() int {
	n := 0
	trump := p.PreferredTrump()
	for _, c := range p.Hand {
		if c.Rank == Ace || (c.Suit == trump && c.Rank >= 10) {
			n++
		}
	}
	if n < MinimumBid {
		return MinimumBid
	}
	return n
}
