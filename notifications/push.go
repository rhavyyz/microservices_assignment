package main

import (
	"context"
	"encoding/json"
	"log"
	"time"

	"github.com/twmb/franz-go/pkg/kgo"
)

const pushDeliveryTimeout = 10 * time.Second

// publisher announces a stored notification on the push topic. It is best-effort: it never blocks nor fails the caller.
type publisher interface {
	Publish(ctx context.Context, n Notification)
}

// pushValue is the JSON value of a push record: the stored notification, shaped like an item of /list plus user_id.
type pushValue struct {
	ID          string         `json:"id"`
	UserID      string         `json:"user_id"`
	Message     string         `json:"message"`
	RedirectURL *string        `json:"redirect_url"`
	Payload     map[string]any `json:"payload"`
	PayloadType *string        `json:"payload_type"`
	Status      Status         `json:"status"`
	CreatedAt   string         `json:"created_at"`
}

// pushRecord builds the push topic record of a stored notification: key = user_id (one user's pushes stay ordered
// within a partition), value = its JSON.
func pushRecord(n Notification) (key, value []byte, err error) {
	value, err = json.Marshal(pushValue{
		ID: n.ID, UserID: n.UserID, Message: n.Message, RedirectURL: n.RedirectURL, Payload: n.Payload,
		PayloadType: n.PayloadType, Status: n.Status, CreatedAt: n.CreatedAt.UTC().Format(createdAtFormat),
	})
	return []byte(n.UserID), value, err
}

// kafkaPublisher produces to the push topic with a dedicated client.
type kafkaPublisher struct {
	cl    *kgo.Client
	topic string
}

func newKafkaPublisher(brokers []string, topic string) (*kafkaPublisher, error) {
	// RecordDeliveryTimeout bounds the produce retries, so a record is dropped (and logged) rather than retried forever.
	cl, err := kgo.NewClient(
		kgo.SeedBrokers(brokers...),
		kgo.RecordDeliveryTimeout(pushDeliveryTimeout),
	)
	if err != nil {
		return nil, err
	}
	return &kafkaPublisher{cl: cl, topic: topic}, nil
}

// Publish queues the record asynchronously; a failure is only logged.
func (p *kafkaPublisher) Publish(ctx context.Context, n Notification) {
	key, value, err := pushRecord(n)
	if err != nil {
		log.Printf("push %s: %v", n.ID, err)
		return
	}
	p.cl.Produce(ctx, &kgo.Record{Topic: p.topic, Key: key, Value: value}, func(_ *kgo.Record, err error) {
		if err != nil {
			log.Printf("push %s: %v", n.ID, err)
		}
	})
}

// Close waits (bounded) for the queued records, then closes the client.
func (p *kafkaPublisher) Close() {
	ctx, cancel := context.WithTimeout(context.Background(), pushDeliveryTimeout)
	defer cancel()
	p.cl.Flush(ctx)
	p.cl.Close()
}
