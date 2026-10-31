package main

import (
	"fmt"
	"net"
	"net/http"
	"strings"
)

// TrustedProxies are the networks whose X-Forwarded-For we believe. Empty means none: the connection address is used.
type TrustedProxies []*net.IPNet

// ParseTrustedProxies parses a comma-separated list of IPs and CIDRs. Empty input gives no proxies.
func ParseTrustedProxies(s string) (TrustedProxies, error) {
	var out TrustedProxies
	for _, part := range strings.Split(s, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		if !strings.Contains(part, "/") {
			ip := net.ParseIP(part)
			if ip == nil {
				return nil, fmt.Errorf("invalid trusted proxy %q: not an IP or CIDR", part)
			}
			bits := 8 * len(ip)
			if v4 := ip.To4(); v4 != nil {
				ip, bits = v4, 32
			}
			out = append(out, &net.IPNet{IP: ip, Mask: net.CIDRMask(bits, bits)})
			continue
		}
		_, n, err := net.ParseCIDR(part)
		if err != nil {
			return nil, fmt.Errorf("invalid trusted proxy %q: %v", part, err)
		}
		out = append(out, n)
	}
	return out, nil
}

func (tp TrustedProxies) contains(ip net.IP) bool {
	for _, n := range tp {
		if n.Contains(ip) {
			return true
		}
	}
	return false
}

// ClientIP returns the address of the caller. It starts from the connection (r.RemoteAddr); only when that
// is a trusted proxy does it read X-Forwarded-For, walking from the right and returning the first address
// that is not itself a trusted proxy. Anything unusable falls back to the connection address, so a client
// that is not behind a trusted proxy cannot forge its IP.
func ClientIP(r *http.Request, tp TrustedProxies) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	remote := net.ParseIP(host)
	if remote == nil || !tp.contains(remote) {
		return host
	}
	parts := strings.Split(strings.Join(r.Header.Values("X-Forwarded-For"), ","), ",")
	for i := len(parts) - 1; i >= 0; i-- {
		ip := net.ParseIP(strings.TrimSpace(parts[i]))
		if ip == nil {
			return host
		}
		if !tp.contains(ip) {
			return ip.String()
		}
	}
	return host
}
