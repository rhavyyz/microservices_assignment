package main

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

const jwtLeeway = 30 * time.Second

// Identity is what a verified token says about the caller.
type Identity struct {
	Sub   string
	Roles []string
}

// Verifier checks the RS256 tokens issued by the Users service against the keys of its JWKS.
type Verifier struct {
	keys   *KeyCache
	issuer string
}

func NewVerifier(keys *KeyCache, issuer string) *Verifier {
	return &Verifier{keys: keys, issuer: issuer}
}

type claims struct {
	Roles []string `json:"roles"`
	jwt.RegisteredClaims
}

// Verify accepts only RS256, a kid known to the trusted JWKS, the configured issuer, a non-expired exp and a sub.
// ErrKeysUnavailable is returned (wrapped) when no key could be obtained; any other error means an invalid token.
func (v *Verifier) Verify(ctx context.Context, token string) (Identity, error) {
	var c claims
	var keyErr error
	_, err := jwt.ParseWithClaims(token, &c, func(t *jwt.Token) (any, error) {
		kid, _ := t.Header["kid"].(string)
		if kid == "" {
			return nil, ErrUnknownKid
		}
		k, err := v.keys.Key(ctx, kid) // never a key, jku or jwk taken from the token itself
		if errors.Is(err, ErrKeysUnavailable) {
			keyErr = err
		}
		return k, err
	}, jwt.WithValidMethods([]string{"RS256"}), jwt.WithExpirationRequired(),
		jwt.WithIssuer(v.issuer), jwt.WithLeeway(jwtLeeway))
	if keyErr != nil {
		return Identity{}, keyErr
	}
	if err != nil {
		return Identity{}, err
	}
	if c.Subject == "" {
		return Identity{}, errors.New("missing sub")
	}
	return Identity{Sub: c.Subject, Roles: c.Roles}, nil
}

func bearer(r *http.Request) (string, bool) {
	h := r.Header.Get("Authorization")
	if len(h) < 7 || !strings.EqualFold(h[:7], "Bearer ") {
		return "", false
	}
	tok := strings.TrimSpace(h[7:])
	return tok, tok != ""
}

// Auth verifies the bearer JWT and sets X-User-Id / X-User-Roles from it. Those headers are trusted downstream,
// so any client-sent value is dropped first, on every route. Authorization is forwarded untouched (Users validates
// it again). Endpoints with requireAuth answer 401 for a missing or invalid token and 503 when no signing key is
// available; the others continue anonymously and the downstream decides.
// It runs before the rate limiter so unauthenticated calls do not consume budget, and so that the limiter keys
// by the verified identity.
func Auth(v *Verifier) Middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			r.Header.Del("X-User-Id")
			r.Header.Del("X-User-Roles")
			rt, _ := routeFrom(r.Context())
			tok, ok := bearer(r)
			if !ok {
				if rt.Endpoint.RequireAuth {
					unauthorized(w)
					return
				}
				next.ServeHTTP(w, r)
				return
			}
			id, err := v.Verify(r.Context(), tok)
			if err != nil {
				if rt.Endpoint.RequireAuth {
					authFailed(w, err)
					return
				}
				next.ServeHTTP(w, r)
				return
			}
			r.Header.Set("X-User-Id", id.Sub)
			if len(id.Roles) > 0 {
				r.Header.Set("X-User-Roles", strings.Join(id.Roles, ","))
			}
			next.ServeHTTP(w, r)
		})
	}
}

// authFailed answers a failed Verify: 503 when no signing key is available, 401 for any invalid token.
func authFailed(w http.ResponseWriter, err error) {
	if errors.Is(err, ErrKeysUnavailable) {
		http.Error(w, "authentication unavailable", http.StatusServiceUnavailable)
		return
	}
	unauthorized(w)
}

func unauthorized(w http.ResponseWriter) {
	w.Header().Set("WWW-Authenticate", "Bearer")
	http.Error(w, "unauthorized", http.StatusUnauthorized)
}
