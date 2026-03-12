package game

// ChatProvider is the chat backend interface.
// V1 is in-memory; future versions may use IRC.
type ChatProvider interface {
	CreateChannel(name string)
	DestroyChannel(name string)
	Join(channel, avatarID string)
	Leave(channel, avatarID string)
	LeaveAll(avatarID string)
	Send(channel, avatarID, text string)
	OnMessage(handler ChatMessageHandler)
	GetMembers(channel string) []string
}

// ChatMessageHandler is called when a message is sent to a channel.
type ChatMessageHandler func(channel, avatarID, text string)

// MemoryChatProvider is a simple in-memory chat implementation.
// Channels are maps of avatar ID sets. Messages are dispatched synchronously.
// Owned exclusively by the World goroutine — no concurrent access.
type MemoryChatProvider struct {
	channels map[string]map[string]struct{} // channel → set of avatar IDs
	handlers []ChatMessageHandler
}

// NewMemoryChatProvider creates an empty chat provider.
func NewMemoryChatProvider() *MemoryChatProvider {
	return &MemoryChatProvider{
		channels: make(map[string]map[string]struct{}),
	}
}

func (c *MemoryChatProvider) CreateChannel(name string) {
	if _, ok := c.channels[name]; !ok {
		c.channels[name] = make(map[string]struct{})
	}
}

func (c *MemoryChatProvider) DestroyChannel(name string) {
	delete(c.channels, name)
}

func (c *MemoryChatProvider) Join(channel, avatarID string) {
	if _, ok := c.channels[channel]; !ok {
		c.CreateChannel(channel)
	}
	c.channels[channel][avatarID] = struct{}{}
}

func (c *MemoryChatProvider) Leave(channel, avatarID string) {
	if members, ok := c.channels[channel]; ok {
		delete(members, avatarID)
	}
}

func (c *MemoryChatProvider) LeaveAll(avatarID string) {
	for _, members := range c.channels {
		delete(members, avatarID)
	}
}

func (c *MemoryChatProvider) Send(channel, avatarID, text string) {
	members, ok := c.channels[channel]
	if !ok {
		return
	}
	// Only deliver if the sender is in the channel
	if _, isMember := members[avatarID]; !isMember {
		return
	}
	for _, handler := range c.handlers {
		handler(channel, avatarID, text)
	}
}

func (c *MemoryChatProvider) OnMessage(handler ChatMessageHandler) {
	c.handlers = append(c.handlers, handler)
}

func (c *MemoryChatProvider) GetMembers(channel string) []string {
	members, ok := c.channels[channel]
	if !ok {
		return nil
	}
	result := make([]string, 0, len(members))
	for id := range members {
		result = append(result, id)
	}
	return result
}
