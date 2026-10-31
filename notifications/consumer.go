package main

import (
	"context"
	"errors"
	"log"
	"strings"
	"time"

	"github.com/twmb/franz-go/pkg/kadm"
	"github.com/twmb/franz-go/pkg/kerr"
	"github.com/twmb/franz-go/pkg/kgo"
)

const (
	consumerGroup = "notifications-service"
	retryMinDelay = time.Second
	retryMaxDelay = 30 * time.Second
)

// backoff sleeps for *delay (doubling it up to retryMaxDelay); false means ctx ended.
func backoff(ctx context.Context, delay *time.Duration) bool {
	select {
	case <-ctx.Done():
		return false
	case <-time.After(*delay):
	}
	if *delay *= 2; *delay > retryMaxDelay {
		*delay = retryMaxDelay
	}
	return true
}

// retry runs fn until it succeeds, with backoff; false means ctx ended first.
func retry(ctx context.Context, what string, fn func(context.Context) error) bool {
	delay := retryMinDelay
	for {
		err := fn(ctx)
		if err == nil {
			return true
		}
		log.Printf("%s: %v (retrying in %s)", what, err, delay)
		if !backoff(ctx, &delay) {
			return false
		}
	}
}

// partitionCount returns the current number of partitions of the topic.
func partitionCount(ctx context.Context, adm *kadm.Client, topic string) (int, error) {
	ts, err := adm.ListTopics(ctx, topic)
	if err != nil {
		return 0, err
	}
	d, ok := ts[topic]
	if !ok {
		return 0, kerr.UnknownTopicOrPartition
	}
	if d.Err != nil {
		return 0, d.Err
	}
	return len(d.Partitions), nil
}

// EnsureTopic creates the topic (replication 1) with the given number of partitions if it does not exist yet. If it
// exists with fewer partitions they are increased to that number; with the same or more it is left alone (Kafka cannot
// reduce partitions, and that is not an error).
func EnsureTopic(ctx context.Context, cl *kgo.Client, topic string, partitions int) error {
	rctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	adm := kadm.NewClient(cl)
	res, err := adm.CreateTopics(rctx, int32(partitions), 1, nil, topic)
	if err != nil {
		return err
	}
	exists := false
	for _, r := range res {
		if errors.Is(r.Err, kerr.TopicAlreadyExists) {
			exists = true
		} else if r.Err != nil {
			return r.Err
		}
	}
	if !exists {
		return nil
	}
	current, err := partitionCount(rctx, adm, topic)
	if err != nil || current >= partitions {
		return err
	}
	ups, err := adm.UpdatePartitions(rctx, partitions, topic)
	if err != nil {
		return err
	}
	for _, r := range ups {
		if r.Err == nil {
			continue
		}
		// Another replica may have increased it in the meantime (InvalidPartitions): re-check before failing.
		if now, cerr := partitionCount(rctx, adm, topic); cerr == nil && now >= partitions {
			return nil
		}
		return r.Err
	}
	log.Printf("topic %s: increased partitions from %d to %d", topic, current, partitions)
	return nil
}

// notificationStore is the part of Store the consumer uses.
type notificationStore interface {
	Insert(ctx context.Context, id string, m Message) (Notification, bool, error)
	Get(ctx context.Context, id string) (Notification, error)
}

// Consumer reads the notifications topic, stores each record in Mongo and publishes it to the push topic.
type Consumer struct {
	brokers        []string
	topic          string
	partitions     int
	pushTopic      string
	pushPartitions int
	store          notificationStore
	pub            publisher
}

func NewConsumer(brokers, topic string, partitions int, pushTopic string, pushPartitions int, store notificationStore) *Consumer {
	var bs []string
	for _, b := range strings.Split(brokers, ",") {
		if b = strings.TrimSpace(b); b != "" {
			bs = append(bs, b)
		}
	}
	return &Consumer{brokers: bs, topic: topic, partitions: partitions, pushTopic: pushTopic, pushPartitions: pushPartitions, store: store}
}

// Run blocks until ctx ends. Offsets are committed only after the record was stored (or skipped as invalid).
func (c *Consumer) Run(ctx context.Context) error {
	cl, err := kgo.NewClient(
		kgo.SeedBrokers(c.brokers...),
		kgo.ConsumerGroup(consumerGroup),
		kgo.ConsumeTopics(c.topic),
		kgo.ConsumeResetOffset(kgo.NewOffset().AtStart()),
		kgo.DisableAutoCommit(),
	)
	if err != nil {
		return err
	}
	defer cl.Close()

	pub, err := newKafkaPublisher(c.brokers, c.pushTopic)
	if err != nil {
		return err
	}
	defer pub.Close()
	c.pub = pub

	if !retry(ctx, "ensure topic", func(ctx context.Context) error { return EnsureTopic(ctx, cl, c.topic, c.partitions) }) {
		return ctx.Err()
	}
	// The push topic is ensured in the background so that it can never hold up consuming: publishing is best-effort, so
	// until it exists the pushes are just logged as failed (a missed push is recovered through /list).
	go retry(ctx, "ensure push topic", func(ctx context.Context) error {
		return EnsureTopic(ctx, pub.cl, c.pushTopic, c.pushPartitions)
	})
	log.Printf("consuming topic %s as group %s", c.topic, consumerGroup)

	for ctx.Err() == nil {
		fetches := cl.PollFetches(ctx)
		if fetches.IsClientClosed() {
			return nil
		}
		fetches.EachError(func(t string, p int32, err error) {
			if ctx.Err() == nil {
				log.Printf("fetch %s/%d: %v", t, p, err)
			}
		})
		var processed []*kgo.Record
		fetches.EachRecord(func(r *kgo.Record) {
			if c.handle(ctx, r) {
				processed = append(processed, r)
			}
		})
		if len(processed) == 0 {
			continue
		}
		// Commit what was actually processed (a cancelled ctx stops handle early, leaving the rest uncommitted).
		retry(ctx, "commit offsets", func(ctx context.Context) error {
			return cl.CommitRecords(ctx, processed...)
		})
	}
	return ctx.Err()
}

// handle stores one record and publishes it to the push topic. It returns true when the record is done (stored or
// invalid) and can be committed; the push is best-effort and never affects that.
func (c *Consumer) handle(ctx context.Context, r *kgo.Record) bool {
	m, err := ParseMessage(r.Value)
	if err != nil {
		log.Printf("skipping invalid message %s/%d/%d: %v", r.Topic, r.Partition, r.Offset, err)
		return true
	}
	id := NotificationID(r.Topic, r.Partition, r.Offset)
	var n Notification
	var inserted bool
	if !retry(ctx, "store "+id, func(ctx context.Context) error {
		ictx, cancel := context.WithTimeout(ctx, mongoOpTimeout)
		defer cancel()
		var err error
		n, inserted, err = c.store.Insert(ictx, id, m)
		return err
	}) {
		return false
	}
	if !inserted {
		// A redelivery: publish the stored document, whose created_at and status may differ from the one just built.
		gctx, cancel := context.WithTimeout(ctx, mongoOpTimeout)
		defer cancel()
		if n, err = c.store.Get(gctx, id); err != nil {
			log.Printf("push %s: reading the stored notification: %v", id, err)
			return true
		}
	}
	c.pub.Publish(ctx, n)
	return true
}
