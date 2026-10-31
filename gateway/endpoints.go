package main

import (
	"context"
	"log"
	"strings"
	"sync"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

const (
	cacheRefreshEvery = 30 * time.Second
	// Mongo may be down or start later: fail fast (5xx) instead of waiting for the driver's 30s defaults.
	mongoServerSelectionTimeout = 3 * time.Second
	mongoOpTimeout              = 10 * time.Second
)

// Endpoint is one downstream route the gateway knows about. Path is the OpenAPI template (/users/{id}).
type Endpoint struct {
	Kind      Kind   `json:"kind" bson:"kind"`
	Method    string `json:"method" bson:"method"`
	Path      string `json:"path" bson:"path"`
	MaxPerMin int    `json:"maxPerMin" bson:"maxPerMin"`
}

// Store persists endpoints. Mongo in production, an in-memory fake in tests.
type Store interface {
	EnsureIndex(ctx context.Context) error
	// List returns the endpoints of a kind, or of every kind when kind is "".
	List(ctx context.Context, kind Kind) ([]Endpoint, error)
	// InsertIfAbsent adds the endpoint unless (kind, method, path) exists; it never overwrites. Reports whether it inserted.
	InsertIfAbsent(ctx context.Context, e Endpoint) (bool, error)
	// SetMax updates maxPerMin of an existing endpoint. ok is false when it is not registered.
	SetMax(ctx context.Context, e Endpoint) (updated Endpoint, ok bool, err error)
	Delete(ctx context.Context, es []Endpoint) error
}

type mongoStore struct{ coll *mongo.Collection }

func newMongoStore(uri string) (*mongoStore, error) {
	c, err := mongo.Connect(options.Client().ApplyURI(uri).
		SetServerSelectionTimeout(mongoServerSelectionTimeout).
		SetTimeout(mongoOpTimeout)) // connects lazily; never blocks nor fails while Mongo is down
	if err != nil {
		return nil, err
	}
	return &mongoStore{coll: c.Database("gateway").Collection("endpoints")}, nil
}

func (s *mongoStore) EnsureIndex(ctx context.Context) error {
	_, err := s.coll.Indexes().CreateOne(ctx, mongo.IndexModel{
		Keys:    bson.D{{Key: "kind", Value: 1}, {Key: "method", Value: 1}, {Key: "path", Value: 1}},
		Options: options.Index().SetUnique(true),
	})
	return err
}

func (s *mongoStore) List(ctx context.Context, kind Kind) ([]Endpoint, error) {
	filter := bson.D{}
	if kind != "" {
		filter = bson.D{{Key: "kind", Value: kind}}
	}
	cur, err := s.coll.Find(ctx, filter)
	if err != nil {
		return nil, err
	}
	var out []Endpoint
	if err := cur.All(ctx, &out); err != nil {
		return nil, err
	}
	return out, nil
}

func (s *mongoStore) InsertIfAbsent(ctx context.Context, e Endpoint) (bool, error) {
	res, err := s.coll.UpdateOne(ctx,
		bson.D{{Key: "kind", Value: e.Kind}, {Key: "method", Value: e.Method}, {Key: "path", Value: e.Path}},
		bson.D{{Key: "$setOnInsert", Value: bson.D{{Key: "maxPerMin", Value: e.MaxPerMin}}}},
		options.UpdateOne().SetUpsert(true))
	if err != nil {
		return false, err
	}
	return res.UpsertedCount > 0, nil
}

func (s *mongoStore) SetMax(ctx context.Context, e Endpoint) (Endpoint, bool, error) {
	var out Endpoint
	err := s.coll.FindOneAndUpdate(ctx,
		bson.D{{Key: "kind", Value: e.Kind}, {Key: "method", Value: e.Method}, {Key: "path", Value: e.Path}},
		bson.D{{Key: "$set", Value: bson.D{{Key: "maxPerMin", Value: e.MaxPerMin}}}},
		options.FindOneAndUpdate().SetReturnDocument(options.After)).Decode(&out)
	if err == mongo.ErrNoDocuments {
		return Endpoint{}, false, nil
	}
	return out, err == nil, err
}

func (s *mongoStore) Delete(ctx context.Context, es []Endpoint) error {
	if len(es) == 0 {
		return nil
	}
	or := make(bson.A, 0, len(es))
	for _, e := range es {
		or = append(or, bson.D{{Key: "kind", Value: e.Kind}, {Key: "method", Value: e.Method}, {Key: "path", Value: e.Path}})
	}
	_, err := s.coll.DeleteMany(ctx, bson.D{{Key: "$or", Value: or}})
	return err
}

// Endpoints is the in-memory copy of the store used on the hot path.
type Endpoints struct {
	store  Store
	mu     sync.RWMutex
	byKind map[Kind][]Endpoint
}

func NewEndpoints(store Store) *Endpoints {
	return &Endpoints{store: store, byKind: map[Kind][]Endpoint{}}
}

func (e *Endpoints) Refresh(ctx context.Context) error {
	all, err := e.store.List(ctx, "")
	if err != nil {
		return err
	}
	m := make(map[Kind][]Endpoint)
	for _, ep := range all {
		m[ep.Kind] = append(m[ep.Kind], ep)
	}
	e.mu.Lock()
	e.byKind = m
	e.mu.Unlock()
	return nil
}

// Run refreshes the cache periodically as a fallback to the refreshes after PUTs and syncs.
func (e *Endpoints) Run(ctx context.Context) {
	t := time.NewTicker(cacheRefreshEvery)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			if err := e.Refresh(ctx); err != nil {
				log.Printf("endpoint cache refresh failed: %v", err)
			}
		}
	}
}

// Match finds the endpoint of the kind whose template matches method and path.
// A {param} segment matches exactly one segment; literal segments win over params, earliest segment first.
func (e *Endpoints) Match(kind Kind, method, path string) (Endpoint, bool) {
	e.mu.RLock()
	defer e.mu.RUnlock()
	return matchPath(e.byKind[kind], method, path)
}

func matchPath(eps []Endpoint, method, path string) (Endpoint, bool) {
	segs := strings.Split(strings.TrimPrefix(path, "/"), "/")
	var best Endpoint
	bestScore, found := -1, false
	for _, ep := range eps {
		if ep.Method != method {
			continue
		}
		if score, ok := matchScore(strings.Split(strings.TrimPrefix(ep.Path, "/"), "/"), segs); ok && score > bestScore {
			best, bestScore, found = ep, score, true
		}
	}
	return best, found
}

// matchScore returns a bitmask with a 1 for every literal segment (earlier segments weigh more).
func matchScore(tmpl, segs []string) (int, bool) {
	if len(tmpl) != len(segs) || len(tmpl) > 62 {
		return 0, false
	}
	score := 0
	for i, t := range tmpl {
		score <<= 1
		switch {
		case strings.HasPrefix(t, "{") && strings.HasSuffix(t, "}"):
			if segs[i] == "" {
				return 0, false
			}
		case t == segs[i]:
			score |= 1
		default:
			return 0, false
		}
	}
	return score, true
}
