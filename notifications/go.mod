module notifications

go 1.24.0

require (
	github.com/twmb/franz-go v1.20.4
	github.com/twmb/franz-go/pkg/kadm v1.17.0
	go.mongodb.org/mongo-driver/v2 v2.0.1
	microservices/discovery v0.0.0
)

require (
	github.com/golang/snappy v0.0.4 // indirect
	github.com/klauspost/compress v1.18.0 // indirect
	github.com/pierrec/lz4/v4 v4.1.33 // indirect
	github.com/twmb/franz-go/pkg/kmsg v1.13.1 // indirect
	github.com/xdg-go/pbkdf2 v1.0.0 // indirect
	github.com/xdg-go/scram v1.1.2 // indirect
	github.com/xdg-go/stringprep v1.0.4 // indirect
	github.com/youmark/pkcs8 v0.0.0-20240726163527-a2c0da244d78 // indirect
	golang.org/x/crypto v0.48.0 // indirect
	golang.org/x/sync v0.19.0 // indirect
	golang.org/x/text v0.34.0 // indirect
)

replace microservices/discovery => ../service-discoverer/Libs/go
