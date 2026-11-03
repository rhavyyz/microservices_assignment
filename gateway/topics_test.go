package main

import (
	"context"
	"errors"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/twmb/franz-go/pkg/kadm"
	"github.com/twmb/franz-go/pkg/kerr"
	"github.com/twmb/franz-go/pkg/kgo"
)

// fakeAdmin is an in-memory topicCreator that behaves like the broker: an existing topic answers TopicAlreadyExists
// and keeps its partitions.
type fakeAdmin struct {
	topics map[string]int32
	err    error // returned by CreateTopics itself
	topErr error // per-topic error
}

func (f *fakeAdmin) CreateTopics(_ context.Context, partitions int32, rf int16, _ map[string]*string, topics ...string) (kadm.CreateTopicResponses, error) {
	if f.err != nil {
		return nil, f.err
	}
	res := kadm.CreateTopicResponses{}
	for _, t := range topics {
		r := kadm.CreateTopicResponse{Topic: t}
		switch {
		case f.topErr != nil:
			r.Err = f.topErr
		case rf != 1:
			r.Err = errors.New("replication factor must be 1")
		default:
			if _, ok := f.topics[t]; ok {
				r.Err = kerr.TopicAlreadyExists
			} else {
				f.topics[t] = partitions
			}
		}
		res[t] = r
	}
	return res, nil
}

func TestEnsureTopicCreatesAndIsIdempotent(t *testing.T) {
	f := &fakeAdmin{topics: map[string]int32{}}
	for i := 0; i < 2; i++ {
		if err := ensureTopic(context.Background(), f, "t", 6); err != nil {
			t.Fatalf("call %d: %v", i, err)
		}
	}
	if f.topics["t"] != 6 {
		t.Errorf("partitions = %d, want 6", f.topics["t"])
	}
}

func TestEnsureTopicLeavesExistingUntouched(t *testing.T) {
	f := &fakeAdmin{topics: map[string]int32{"t": 3}}
	if err := ensureTopic(context.Background(), f, "t", 6); err != nil {
		t.Fatal(err)
	}
	if f.topics["t"] != 3 {
		t.Errorf("partitions = %d, want 3 (unchanged)", f.topics["t"])
	}
}

func TestEnsureTopicReturnsRealErrors(t *testing.T) {
	boom := errors.New("boom")
	if err := ensureTopic(context.Background(), &fakeAdmin{err: boom}, "t", 6); !errors.Is(err, boom) {
		t.Errorf("request error = %v", err)
	}
	if err := ensureTopic(context.Background(), &fakeAdmin{topErr: kerr.InvalidPartitions}, "t", 6); !errors.Is(err, kerr.InvalidPartitions) {
		t.Errorf("topic error = %v", err)
	}
}

func TestPushRunEnsuresTopicBeforePollingAndRetries(t *testing.T) {
	pc := NewPushConsumer("127.0.0.1:1", "t", 6, NewHub())
	pc.ensureWait = time.Millisecond
	var mu sync.Mutex
	calls := 0
	ready := make(chan struct{})
	pc.ensure = func(_ context.Context, _ *kgo.Client, topic string, partitions int) error {
		mu.Lock()
		defer mu.Unlock()
		if topic != "t" || partitions != 6 {
			t.Errorf("ensure(%q, %d)", topic, partitions)
		}
		calls++
		if calls < 3 {
			return errors.New("kafka down")
		}
		close(ready)
		return nil
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { pc.Run(ctx); close(done) }()
	select {
	case <-ready:
	case <-time.After(5 * time.Second):
		t.Fatal("topic never ensured")
	}
	cancel()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("Run did not exit after cancel")
	}
	if calls != 3 {
		t.Errorf("ensure calls = %d, want 3", calls)
	}
}

func TestPushRunExitsOnCancelWhileEnsureFails(t *testing.T) {
	pc := NewPushConsumer("127.0.0.1:1", "t", 6, NewHub())
	pc.ensureWait = time.Hour // would block forever if the wait ignored ctx
	called := make(chan struct{}, 1)
	pc.ensure = func(context.Context, *kgo.Client, string, int) error {
		select {
		case called <- struct{}{}:
		default:
		}
		return errors.New("kafka down")
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { pc.Run(ctx); close(done) }()
	<-called
	cancel()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("Run did not exit after cancel")
	}
}

// TestEnsureTopicRealBroker runs against a real broker: KAFKA_TEST_BROKERS=host:9092 (skipped when unset).
func TestEnsureTopicRealBroker(t *testing.T) {
	brokers := os.Getenv("KAFKA_TEST_BROKERS")
	if brokers == "" {
		t.Skip("KAFKA_TEST_BROKERS not set")
	}
	cl, err := kgo.NewClient(kgo.SeedBrokers(strings.Split(brokers, ",")...))
	if err != nil {
		t.Fatal(err)
	}
	defer cl.Close()
	adm := kadm.NewClient(cl)
	ctx := context.Background()
	sfx := time.Now().Format("150405")

	fresh, existing := "notifications-push", "xg-existing-"+sfx
	if res, err := adm.CreateTopics(ctx, 3, 1, nil, existing); err != nil || res[existing].Err != nil {
		t.Fatalf("pre-create: %v %v", err, res[existing].Err)
	}
	for _, topic := range []string{fresh, fresh, existing, existing} {
		if err := EnsureTopic(ctx, cl, topic, 6); err != nil {
			t.Fatalf("EnsureTopic(%s): %v", topic, err)
		}
	}
	for topic, want := range map[string]int{fresh: 6, existing: 3} {
		var details kadm.TopicDetails
		for i := 0; i < 50; i++ { // metadata of a just-created topic may lag behind the create
			if details, err = adm.ListTopics(ctx, topic); err != nil {
				t.Fatal(err)
			}
			if len(details[topic].Partitions) > 0 {
				break
			}
			time.Sleep(100 * time.Millisecond)
		}
		if got := len(details[topic].Partitions); got != want {
			t.Errorf("%s partitions = %d, want %d", topic, got, want)
		}
	}
}
