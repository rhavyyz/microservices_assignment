package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"strings"
	"sync"
	"time"

	"github.com/twmb/franz-go/pkg/kgo"
)

const (
	pushMetadataMaxAge = 30 * time.Second // how soon partitions added to the topic (or the topic itself) are noticed
	pushLogEvery       = 30 * time.Second // minimum gap between two identical log lines of the consumer
	pushEnsureMinWait  = time.Second      // first delay before retrying to ensure the topic
	pushEnsureMaxWait  = 30 * time.Second // cap of the exponential backoff between attempts
)

// pushIn is the JSON value of a record of the notifications push topic (see the notifications service).
type pushIn struct {
	ID          string          `json:"id"`
	UserID      string          `json:"user_id"`
	Message     string          `json:"message"`
	RedirectURL *string         `json:"redirect_url"`
	Payload     json.RawMessage `json:"payload"`
	PayloadType *string         `json:"payload_type"`
	Status      string          `json:"status"`
	CreatedAt   string          `json:"created_at"`
}

// pushNotification is the notification as the frontend gets it: an item of /notifications/list.
type pushNotification struct {
	ID          string          `json:"id"`
	Message     string          `json:"message"`
	RedirectURL *string         `json:"redirect_url"`
	Payload     json.RawMessage `json:"payload"`
	PayloadType *string         `json:"payload_type"`
	Status      string          `json:"status"`
	CreatedAt   string          `json:"created_at"`
}

type pushFrame struct {
	Type         string           `json:"type"`
	Notification pushNotification `json:"notification"`
}

// pushFrameFor validates a push record value and builds the websocket frame for its user (user_id is not in it).
func pushFrameFor(value []byte) (userID string, frame []byte, err error) {
	var in pushIn
	if err = json.Unmarshal(value, &in); err != nil {
		return "", nil, err
	}
	if in.UserID = strings.TrimSpace(in.UserID); in.UserID == "" {
		return "", nil, errors.New("missing user_id")
	}
	if in.ID == "" {
		return "", nil, errors.New("missing id")
	}
	frame, err = json.Marshal(pushFrame{Type: "notification", Notification: pushNotification{
		ID: in.ID, Message: in.Message, RedirectURL: in.RedirectURL, Payload: in.Payload,
		PayloadType: in.PayloadType, Status: in.Status, CreatedAt: in.CreatedAt,
	}})
	return in.UserID, frame, err
}

// logEvery logs, but a line identical to the previous one only once per interval (with the number swallowed), so a
// broker outage or a stream of bad records cannot flood the log.
type logEvery struct {
	mu         sync.Mutex
	every      time.Duration
	now        func() time.Time
	last       string
	at         time.Time
	suppressed int
}

func (l *logEvery) Printf(format string, args ...any) {
	msg := fmt.Sprintf(format, args...)
	l.mu.Lock()
	now := l.now()
	if msg == l.last && now.Sub(l.at) < l.every {
		l.suppressed++
		l.mu.Unlock()
		return
	}
	n := l.suppressed
	l.last, l.at, l.suppressed = msg, now, 0
	l.mu.Unlock()
	if n > 0 {
		msg += fmt.Sprintf(" (%d identical lines suppressed)", n)
	}
	log.Print(msg)
}

// PushConsumer forwards the records of the push topic to the hub.
type PushConsumer struct {
	brokers []string
	topic   string
	parts   int
	hub     *Hub
	errLog  *logEvery
	badLog  *logEvery

	ensure     func(ctx context.Context, cl *kgo.Client, topic string, partitions int) error // EnsureTopic; replaced in tests
	ensureWait time.Duration                                                                 // first retry delay; doubles up to pushEnsureMaxWait
}

func NewPushConsumer(brokers, topic string, partitions int, hub *Hub) *PushConsumer {
	var bs []string
	for _, b := range strings.Split(brokers, ",") {
		if b = strings.TrimSpace(b); b != "" {
			bs = append(bs, b)
		}
	}
	return &PushConsumer{
		brokers: bs, topic: topic, parts: partitions, hub: hub,
		ensure: EnsureTopic, ensureWait: pushEnsureMinWait,
		errLog: &logEvery{every: pushLogEvery, now: time.Now},
		badLog: &logEvery{every: pushLogEvery, now: time.Now},
	}
}

// Handle forwards one record value to the hub. Invalid records are logged (rate-limited) and skipped.
func (c *PushConsumer) Handle(value []byte) {
	userID, frame, err := pushFrameFor(value)
	if err != nil {
		c.badLog.Printf("skipping invalid push message: %v", err)
		return
	}
	c.hub.Send(userID, frame)
}

// Run blocks until ctx ends. It is meant for a goroutine: it never fails the gateway, and the client reconnects to
// the brokers by itself, so Kafka being down or late only means no pushes until it is back.
//
// Every gateway instance must see every push (a user may be connected to any of them), so there is no consumer
// group: the partitions are consumed directly (no group pile-up in Kafka, nothing to commit) starting where the log
// is when the process starts, so pushes from before are not replayed (clients recover through /list). Found in
// franz-go v1.20.4 (consumer_direct.go): a direct consumer starts every partition it sees for the first time at the
// same configured offset, whether at startup or after a metadata refresh, so AtEnd would skip what is produced to a
// new partition before it is noticed. AfterMilli(start time) is the documented answer: partitions that already have
// data start at their end (nothing older than now is replayed), partitions added later start at their beginning.
// Before polling, the topic is created if absent (never altered if it exists), retrying with exponential backoff
// while Kafka is unreachable; the wait happens here, in the goroutine, so the gateway start is never held back.
func (c *PushConsumer) Run(ctx context.Context) {
	cl, err := kgo.NewClient(
		kgo.SeedBrokers(c.brokers...),
		kgo.ConsumeTopics(c.topic),
		kgo.ConsumeResetOffset(kgo.NewOffset().AfterMilli(time.Now().UnixMilli())),
		kgo.MetadataMaxAge(pushMetadataMaxAge),
	)
	if err != nil {
		log.Printf("push consumer disabled: %v", err)
		return
	}
	defer cl.Close()

	wait := c.ensureWait
	for {
		err := c.ensure(ctx, cl, c.topic, c.parts)
		if err == nil {
			break
		}
		if ctx.Err() != nil {
			return
		}
		c.errLog.Printf("ensuring push topic %s: %v", c.topic, err)
		select {
		case <-ctx.Done():
			return
		case <-time.After(wait):
		}
		wait = min(wait*2, pushEnsureMaxWait)
	}
	log.Printf("push topic %s ready", c.topic)
	log.Printf("consuming push topic %s", c.topic)

	for ctx.Err() == nil {
		fetches := cl.PollFetches(ctx)
		if fetches.IsClientClosed() {
			return
		}
		fetches.EachError(func(t string, p int32, err error) {
			if ctx.Err() == nil {
				c.errLog.Printf("push fetch %s/%d: %v", t, p, err)
			}
		})
		fetches.EachRecord(func(r *kgo.Record) { c.Handle(r.Value) })
	}
}
