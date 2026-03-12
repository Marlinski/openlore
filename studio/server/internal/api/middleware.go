package api

import (
	"context"
	"encoding/json"
	"io"
	"net/http"

	"github.com/go-chi/chi/v5"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
)

type contextKey string

const ownerIDKey contextKey = "ownerID"

// protojson options for API responses — numeric enums match game server convention.
var apiMarshaler = protojson.MarshalOptions{
	UseEnumNumbers: true,
}

// WorkspaceMiddleware extracts the workspace ID from the chi URL param
// and injects it into the request context as the ownerID.
func WorkspaceMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		wsID := chi.URLParam(r, "workspaceId")
		if wsID == "" {
			writeError(w, http.StatusBadRequest, "MISSING_WORKSPACE", "workspace ID required in URL path")
			return
		}
		ctx := context.WithValue(r.Context(), ownerIDKey, wsID)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// ownerID extracts the owner ID (workspace ID) from the request context.
func ownerID(r *http.Request) string {
	if id, ok := r.Context().Value(ownerIDKey).(string); ok && id != "" {
		return id
	}
	return "default"
}

// writeProto serialises a proto message as JSON and writes it with the given status code.
func writeProto(w http.ResponseWriter, status int, m proto.Message) {
	data, err := apiMarshaler.Marshal(m)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "MARSHAL_FAILED", err.Error())
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(data)
}

// writeProtoList serialises a slice of proto messages as a JSON array.
func writeProtoList[T proto.Message](w http.ResponseWriter, status int, items []T) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write([]byte("["))
	for i, item := range items {
		if i > 0 {
			_, _ = w.Write([]byte(","))
		}
		data, err := apiMarshaler.Marshal(item)
		if err != nil {
			continue // best effort — skip broken items
		}
		_, _ = w.Write(data)
	}
	_, _ = w.Write([]byte("]"))
}

// writeJSON serialises v as JSON and writes it with the given status code.
// Used for non-proto payloads (status, error envelopes, etc.).
func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// writeError writes a standard error envelope.
func writeError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, map[string]string{"error": message, "code": code})
}

// decodeProto reads the request body and unmarshals it into a proto message.
func decodeProto(r *http.Request, m proto.Message) error {
	defer r.Body.Close()
	data, err := io.ReadAll(r.Body)
	if err != nil {
		return err
	}
	return protojson.UnmarshalOptions{DiscardUnknown: true}.Unmarshal(data, m)
}
