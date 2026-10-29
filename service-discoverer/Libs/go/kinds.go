// Package discovery registers this instance with the service-discoverer and
// calls other services by kind, caching the discovered host per kind.
package discovery

// Kind is the type of a service. Gateway and service-discoverer are not part of it.
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
