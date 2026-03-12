package main

import "embed"

// distFS embeds the Preact frontend build output.
// In dev mode this contains only .gitkeep (empty app).
// In production the Makefile copies studio/app/dist/ here before `go build`.
//
//go:embed dist/*
var distFS embed.FS
