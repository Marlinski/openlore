// Package channelstore defines the interface for persisting channel → pack
// bindings, plus a file-based implementation.
//
// The Store interface can be backed by JSON files on disk (FileStore),
// a SQL database, or any other persistence layer.
package channelstore

import "time"

// ChannelConfig is the persisted state of a single channel binding.
type ChannelConfig struct {
	Channel string `json:"channel"` // e.g. "#lobby"
	PackID  string `json:"packId"`
	Created string `json:"created"` // RFC3339
}

// NewChannelConfig creates a ChannelConfig with the current timestamp.
func NewChannelConfig(channel, packID string) *ChannelConfig {
	return &ChannelConfig{
		Channel: channel,
		PackID:  packID,
		Created: time.Now().Format(time.RFC3339),
	}
}

// Store is the persistence interface for channel → pack bindings.
// Implementations must be safe for concurrent use if the caller requires it.
type Store interface {
	// List returns all persisted channel configs.
	List() ([]*ChannelConfig, error)

	// Get returns a channel config by name, or nil if not found.
	Get(channel string) (*ChannelConfig, error)

	// Save persists a channel binding. If the channel already exists it is overwritten.
	Save(cfg *ChannelConfig) error

	// Remove deletes a channel binding. Returns nil if the channel didn't exist.
	Remove(channel string) error
}
