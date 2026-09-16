module github.com/openlore/studio

go 1.25.0

require (
	github.com/fsnotify/fsnotify v1.9.0
	github.com/go-chi/chi/v5 v5.2.1
	github.com/openlore/shared/pack v0.0.0-local
	github.com/spf13/cobra v1.10.2
	golang.org/x/image v0.23.0
	google.golang.org/protobuf v1.36.11
)

replace github.com/openlore/shared/pack => ../../shared/pack/go

require (
	github.com/inconshreveable/mousetrap v1.1.0 // indirect
	github.com/spf13/pflag v1.0.9 // indirect
	golang.org/x/sys v0.22.0 // indirect
)
