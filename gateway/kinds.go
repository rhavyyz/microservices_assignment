package main

import "strings"

// Kind is the type of a downstream service (same list as service-discoverer/kinds.go).
// Gateway and service-discoverer are not kinds.
type Kind string

const (
	Certificates  Kind = "certificates"
	Events        Kind = "events"
	Subscription  Kind = "subscription"
	Payments      Kind = "payments"
	User          Kind = "user"
	Notifications Kind = "notifications"
	Reports       Kind = "reports"
)

var allKinds = []Kind{Certificates, Events, Subscription, Payments, User, Notifications, Reports}

func (k Kind) valid() bool {
	for _, v := range allKinds {
		if k == v {
			return true
		}
	}
	return false
}

// splitKind splits "/{kind}/rest" into the kind and "/rest" ("/" when there is no rest).
func splitKind(path string) (Kind, string) {
	p := strings.TrimPrefix(path, "/")
	kind, rest, found := strings.Cut(p, "/")
	if !found {
		return Kind(kind), "/"
	}
	return Kind(kind), "/" + rest
}
