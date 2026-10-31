package main

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httputil"
	"strings"
)

// NewProxy is the terminal handler: it forwards to a healthy instance of the resolved kind,
// with the /{kind} prefix stripped (query, method, body and headers preserved).
func NewProxy(disc *Discovery) http.Handler {
	rp := &httputil.ReverseProxy{
		Rewrite: func(pr *httputil.ProxyRequest) {
			rt, _ := routeFrom(pr.In.Context())
			host, _ := pr.In.Context().Value(hostKey{}).(string)
			pr.Out.URL.Scheme = "http"
			pr.Out.URL.Host = host
			pr.Out.URL.Path = rt.Rest
			pr.Out.URL.RawPath = ""
			pr.Out.Host = ""
			// Rewrite strips these from Out; they were already set (or kept) by DefaultHeaders.
			for _, h := range []string{"X-Forwarded-For", "X-Forwarded-Host"} {
				if v := pr.In.Header.Values(h); len(v) > 0 {
					pr.Out.Header[h] = v
				}
			}
		},
		// The gateway owns CORS (see Cors); drop the downstream's so the headers are not duplicated.
		ModifyResponse: func(resp *http.Response) error {
			for k := range resp.Header {
				if strings.HasPrefix(http.CanonicalHeaderKey(k), "Access-Control-") {
					resp.Header.Del(k)
				}
			}
			return nil
		},
		Transport: &retryTransport{disc: disc, base: http.DefaultTransport},
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			if errors.Is(err, ErrNoInstance) {
				http.Error(w, err.Error(), http.StatusServiceUnavailable)
				return
			}
			http.Error(w, "bad gateway", http.StatusBadGateway)
		},
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rt, ok := routeFrom(r.Context())
		if !ok {
			http.NotFound(w, r)
			return
		}
		host, err := disc.Host(r.Context(), rt.Endpoint.Kind)
		if err != nil {
			if errors.Is(err, ErrNoInstance) {
				http.Error(w, err.Error(), http.StatusServiceUnavailable)
			} else {
				http.Error(w, "service discovery failed", http.StatusBadGateway)
			}
			return
		}
		rp.ServeHTTP(w, r.WithContext(withHost(r.Context(), host)))
	})
}

type hostKey struct{}

func withHost(ctx context.Context, host string) context.Context {
	return context.WithValue(ctx, hostKey{}, host)
}

// retryTransport re-consults the discoverer and retries once when dialing the cached host fails
// (the request never reached it, so retrying is safe).
type retryTransport struct {
	disc *Discovery
	base http.RoundTripper
}

func (t *retryTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	orig := req.Body
	first := req
	if orig != nil && orig != http.NoBody {
		// The transport closes the body even when dialing fails; shield it so the retry can still send it.
		first = req.Clone(req.Context())
		first.Body = io.NopCloser(orig)
	}
	resp, err := t.base.RoundTrip(first)
	if err == nil || !isDialError(err) {
		return resp, err
	}
	rt, _ := routeFrom(req.Context())
	t.disc.Forget(rt.Endpoint.Kind, req.URL.Host)
	host, herr := t.disc.Host(req.Context(), rt.Endpoint.Kind)
	if herr != nil {
		return nil, herr
	}
	retry := req.Clone(req.Context())
	retry.URL.Host = host
	retry.Body = orig
	return t.base.RoundTrip(retry)
}

func isDialError(err error) bool {
	var op *net.OpError
	return errors.As(err, &op) && op.Op == "dial"
}
