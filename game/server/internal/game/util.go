package game

import "time"

// nowMillis returns the current time in milliseconds since epoch.
func nowMillis() int64 {
	return time.Now().UnixMilli()
}
