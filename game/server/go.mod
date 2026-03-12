module github.com/offisims/game

go 1.24

toolchain go1.24.3

require (
	github.com/go-chi/chi/v5 v5.2.1
	github.com/offisims/shared/pack v0.0.0-00010101000000-000000000000
	google.golang.org/protobuf v1.36.11
	nhooyr.io/websocket v1.8.11
)

require github.com/google/uuid v1.6.0 // indirect

replace github.com/offisims/shared/pack => ../../shared/pack/go
