package main

import (
	"context"
	"errors"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

const (
	mongoServerSelectionTimeout = 3 * time.Second
	mongoOpTimeout              = 10 * time.Second
	mongoDuplicateKey           = 11000
	ttlIndexName                = "created_at_ttl"
	userIndexName               = "user_id_1_created_at_-1__id_-1"
	oldUserIndexName            = "user_id_1_created_at_-1"
)

// ErrBaseNotFound means the base notification of a List cursor does not exist for that user (or has expired).
var ErrBaseNotFound = errors.New("base notification not found")

// Notification is the stored document.
type Notification struct {
	ID          string         `bson:"_id"`
	UserID      string         `bson:"user_id"`
	Message     string         `bson:"message"`
	RedirectURL *string        `bson:"redirect_url"`
	Payload     map[string]any `bson:"payload"`
	PayloadType *string        `bson:"payload_type"`
	Status      Status         `bson:"status"`
	CreatedAt   time.Time      `bson:"created_at"`
}

// Store persists notifications in MongoDB.
type Store struct{ db *mongo.Database }

func newStore(uri, database string) (*Store, error) {
	c, err := mongo.Connect(options.Client().ApplyURI(uri).
		SetServerSelectionTimeout(mongoServerSelectionTimeout).
		SetTimeout(mongoOpTimeout)) // connects lazily; never blocks nor fails while Mongo is down
	if err != nil {
		return nil, err
	}
	return &Store{db: c.Database(database)}, nil
}

func (s *Store) coll() *mongo.Collection { return s.db.Collection("notifications") }

// Ping reports whether Mongo is reachable.
func (s *Store) Ping(ctx context.Context) error {
	return s.db.Client().Ping(ctx, nil)
}

// validator is the $jsonSchema every document must satisfy.
func validator() bson.M {
	statuses := make(bson.A, len(Statuses))
	for i, st := range Statuses {
		statuses[i] = string(st)
	}
	return bson.M{"$jsonSchema": bson.M{
		"bsonType": "object",
		"required": bson.A{"user_id", "message", "status", "created_at"},
		"properties": bson.M{
			"user_id":      bson.M{"bsonType": "string"},
			"message":      bson.M{"bsonType": "string"},
			"redirect_url": bson.M{"bsonType": bson.A{"string", "null"}},
			"payload":      bson.M{"bsonType": bson.A{"object", "null"}},
			"payload_type": bson.M{"bsonType": bson.A{"string", "null"}},
			"status":       bson.M{"enum": statuses},
			"created_at":   bson.M{"bsonType": "date"},
		},
	}}
}

// EnsureSchema idempotently creates the collection with its validator (or updates it) and its indexes.
//
// Retention is a TTL index on created_at: MongoDB's background TTL monitor (it wakes up about every 60s) deletes the
// documents older than the retention, whatever their status. So expiry is not exact, and it is not a daily batch:
// a notification disappears up to about a minute after it passes the age. No job runs in this service, and it is
// safe with several replicas since the deletion is done by Mongo itself.
func (s *Store) EnsureSchema(ctx context.Context, retention time.Duration) error {
	names, err := s.db.ListCollectionNames(ctx, bson.M{"name": "notifications"})
	if err != nil {
		return err
	}
	if len(names) == 0 {
		err = s.db.CreateCollection(ctx, "notifications", options.CreateCollection().SetValidator(validator()))
		// Another replica may have created it in the meantime (NamespaceExists, code 48).
		if err != nil && !mongo.IsDuplicateKeyError(err) && !hasCode(err, 48) {
			return err
		}
	}
	if err := s.db.RunCommand(ctx, bson.D{
		{Key: "collMod", Value: "notifications"},
		{Key: "validator", Value: validator()},
	}).Err(); err != nil {
		return err
	}
	// The listing index also holds _id, the tiebreak of the order. It is created before the previous
	// {user_id, created_at} one is dropped, so listings are always index-served during a rollout.
	_, err = s.coll().Indexes().CreateOne(ctx, mongo.IndexModel{
		Keys: bson.D{{Key: "user_id", Value: 1}, {Key: "created_at", Value: -1}, {Key: "_id", Value: -1}},
	})
	if err != nil {
		return err
	}
	if err := s.coll().Indexes().DropOne(ctx, oldUserIndexName); err != nil && !hasCode(err, 27) { // 27: another replica dropped it first
		return err
	}
	return s.ensureTTLIndex(ctx, int64(retention/time.Second))
}

type indexInfo struct {
	Name   string `bson:"name"`
	Key    bson.D `bson:"key"`
	Expire *int64 `bson:"expireAfterSeconds"`
}

func (i indexInfo) onlyCreatedAt() bool {
	return len(i.Key) == 1 && i.Key[0].Key == "created_at"
}

// ensureTTLIndex makes created_at_ttl the only index on created_at alone, expiring after the given seconds.
// createIndexes fails with IndexOptionsConflict/IndexKeySpecsConflict when an index on the same key (e.g. the old
// plain created_at_1) or with the same name but other options exists, so it lists first and decides: a stale index
// is dropped, a TTL with another expireAfterSeconds is updated in place with collMod. If a concurrent replica
// changes things between the listing and the command, the conflict error is handled by listing again.
func (s *Store) ensureTTLIndex(ctx context.Context, seconds int64) error {
	var err error
	for attempt := 0; attempt < 3; attempt++ {
		if err = s.reconcileTTLIndex(ctx, seconds); err == nil || !(hasCode(err, 85) || hasCode(err, 86)) {
			return err
		}
	}
	return err
}

func (s *Store) reconcileTTLIndex(ctx context.Context, seconds int64) error {
	cur, err := s.coll().Indexes().List(ctx)
	if err != nil {
		return err
	}
	var idx []indexInfo
	if err := cur.All(ctx, &idx); err != nil {
		return err
	}
	found := false
	for _, i := range idx {
		switch {
		case i.Name == ttlIndexName && i.onlyCreatedAt() && i.Expire != nil:
			found = true
			if *i.Expire == seconds {
				continue
			}
			err = s.db.RunCommand(ctx, bson.D{
				{Key: "collMod", Value: "notifications"},
				{Key: "index", Value: bson.D{{Key: "name", Value: ttlIndexName}, {Key: "expireAfterSeconds", Value: seconds}}},
			}).Err()
		case i.Name == ttlIndexName || i.onlyCreatedAt():
			// The previous iteration's plain created_at_1 (or anything else squatting the key or the name).
			err = s.coll().Indexes().DropOne(ctx, i.Name)
			if hasCode(err, 27) { // IndexNotFound: another replica dropped it first
				err = nil
			}
		}
		if err != nil {
			return err
		}
	}
	if found {
		return nil
	}
	_, err = s.coll().Indexes().CreateOne(ctx, mongo.IndexModel{
		Keys:    bson.D{{Key: "created_at", Value: 1}},
		Options: options.Index().SetName(ttlIndexName).SetExpireAfterSeconds(int32(seconds)),
	})
	return err
}

func hasCode(err error, code int) bool {
	var ce mongo.CommandError
	return errors.As(err, &ce) && int(ce.Code) == code
}

// Insert stores the message under the given id with status DEFAULT and returns the document it wrote. A duplicate id
// counts as success: inserted is false and the returned Notification is empty (the stored one is not read here, see Get).
func (s *Store) Insert(ctx context.Context, id string, m Message) (n Notification, inserted bool, err error) {
	n = Notification{
		ID:          id,
		UserID:      m.UserID,
		Message:     m.Message,
		RedirectURL: m.RedirectURL,
		Payload:     m.Payload,
		PayloadType: m.PayloadType,
		Status:      StatusDefault,
		CreatedAt:   time.Now().UTC(),
	}
	if _, err := s.coll().InsertOne(ctx, n); err != nil {
		if isDuplicate(err) {
			return Notification{}, false, nil
		}
		return Notification{}, false, err
	}
	return n, true, nil
}

// Get returns the stored notification with that id (mongo.ErrNoDocuments if it is gone).
func (s *Store) Get(ctx context.Context, id string) (Notification, error) {
	var n Notification
	err := s.coll().FindOne(ctx, bson.M{"_id": id}).Decode(&n)
	return n, err
}

func isDuplicate(err error) bool {
	if mongo.IsDuplicateKeyError(err) {
		return true
	}
	var we mongo.WriteException
	if errors.As(err, &we) {
		for _, x := range we.WriteErrors {
			if x.Code == mongoDuplicateKey {
				return true
			}
		}
	}
	return false
}

// List returns the user's notifications newest first, in the order (created_at desc, _id desc), optionally filtered
// by status. With a base id it returns the ones older than the base in that order (ErrBaseNotFound if the base is not
// the user's); hasMore tells whether there are more after the returned page.
//
// The _id is a UUIDv5, not time-ordered, so the cursor is the position of the base in that order, not its id.
func (s *Store) List(ctx context.Context, userID string, base string, statuses []Status, limit int) ([]Notification, bool, error) {
	ctx, cancel := context.WithTimeout(ctx, mongoOpTimeout)
	defer cancel()
	filter := bson.M{"user_id": userID}
	if base != "" {
		var b Notification
		err := s.coll().FindOne(ctx, bson.M{"_id": base, "user_id": userID}).Decode(&b)
		if errors.Is(err, mongo.ErrNoDocuments) {
			return nil, false, ErrBaseNotFound
		}
		if err != nil {
			return nil, false, err
		}
		filter["$or"] = bson.A{
			bson.M{"created_at": bson.M{"$lt": b.CreatedAt}},
			bson.M{"created_at": b.CreatedAt, "_id": bson.M{"$lt": b.ID}},
		}
	}
	if len(statuses) > 0 {
		filter["status"] = bson.M{"$in": statuses}
	}
	cur, err := s.coll().Find(ctx, filter, options.Find().
		SetSort(bson.D{{Key: "created_at", Value: -1}, {Key: "_id", Value: -1}}).
		SetLimit(int64(limit+1))) // one extra row tells whether there are more
	if err != nil {
		return nil, false, err
	}
	items := []Notification{}
	if err := cur.All(ctx, &items); err != nil {
		return nil, false, err
	}
	hasMore := len(items) > limit
	if hasMore {
		items = items[:limit]
	}
	return items, hasMore, nil
}

// StatusUpdate is one requested status change.
type StatusUpdate struct {
	ID     string
	Status Status
}

// UpdateStatuses sets the status of the user's notifications that exist, applying only those: it returns how many
// the write matched and, in request order, the ids that are not the user's (they do not exist, belong to someone else
// or have expired), which are skipped. The ids must be distinct. Only status is changed, and the write filters on
// user_id again so it can never touch another user's document. Setting the status a notification already has counts
// as matched.
//
// Mongo here is standalone (no transactions), so the check and the write are separate operations: a document could
// expire through the TTL index in between, in which case its update matches nothing, so updated is lower than the
// number of owned ids and that id is not reported in notFound.
func (s *Store) UpdateStatuses(ctx context.Context, userID string, updates []StatusUpdate) (updated int, notFound []string, err error) {
	if len(updates) == 0 {
		return 0, nil, nil
	}
	ctx, cancel := context.WithTimeout(ctx, mongoOpTimeout)
	defer cancel()
	ids := make([]string, len(updates))
	for i, u := range updates {
		ids[i] = u.ID
	}
	cur, err := s.coll().Find(ctx, bson.M{"_id": bson.M{"$in": ids}, "user_id": userID},
		options.Find().SetProjection(bson.M{"_id": 1}))
	if err != nil {
		return 0, nil, err
	}
	var found []struct {
		ID string `bson:"_id"`
	}
	if err := cur.All(ctx, &found); err != nil {
		return 0, nil, err
	}
	have := make(map[string]bool, len(found))
	for _, f := range found {
		have[f.ID] = true
	}
	var models []mongo.WriteModel
	for _, u := range updates {
		if !have[u.ID] {
			notFound = append(notFound, u.ID)
			continue
		}
		models = append(models, mongo.NewUpdateOneModel().
			SetFilter(bson.M{"_id": u.ID, "user_id": userID}).
			SetUpdate(bson.M{"$set": bson.M{"status": u.Status}}))
	}
	if len(models) == 0 {
		return 0, notFound, nil
	}
	res, err := s.coll().BulkWrite(ctx, models, options.BulkWrite().SetOrdered(false))
	if err != nil {
		return 0, nil, err
	}
	return int(res.MatchedCount), notFound, nil
}
