package main

import (
	"context"
	"errors"
	"time"

	"github.com/twmb/franz-go/pkg/kadm"
	"github.com/twmb/franz-go/pkg/kerr"
	"github.com/twmb/franz-go/pkg/kgo"
)

const topicAttemptTimeout = 15 * time.Second

// topicCreator is the part of kadm.Client that EnsureTopic needs.
type topicCreator interface {
	CreateTopics(ctx context.Context, partitions int32, replicationFactor int16, configs map[string]*string, topics ...string) (kadm.CreateTopicResponses, error)
}

// EnsureTopic creates the topic (replication 1) with the given number of partitions if it does not exist yet. An
// existing topic is success and is never altered, not even its partition count.
func EnsureTopic(ctx context.Context, cl *kgo.Client, topic string, partitions int) error {
	return ensureTopic(ctx, kadm.NewClient(cl), topic, partitions)
}

func ensureTopic(ctx context.Context, adm topicCreator, topic string, partitions int) error {
	rctx, cancel := context.WithTimeout(ctx, topicAttemptTimeout)
	defer cancel()
	res, err := adm.CreateTopics(rctx, int32(partitions), 1, nil, topic)
	if err != nil {
		return err
	}
	for _, r := range res {
		if r.Err != nil && !errors.Is(r.Err, kerr.TopicAlreadyExists) {
			return r.Err
		}
	}
	return nil
}
