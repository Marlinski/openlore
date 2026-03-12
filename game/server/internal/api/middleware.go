package api

import (
	"encoding/json"
	"net/http"

	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
)

// protoJSONOpts is the shared marshal configuration for all proto → JSON
// responses. UseEnumNumbers emits enum fields as integers (e.g. 1 for
// PLACEMENT_LAYER_FLOOR) which matches the TypeScript numeric enums generated
// by protobuf-es.
var protoJSONOpts = protojson.MarshalOptions{
	UseEnumNumbers: true,
}

// writeJSON serialises v as JSON and writes it with the given status code.
func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// writeProtoJSON serialises a proto message as JSON using protojson and writes
// it with the given status code. This avoids encoding/json (which doesn't
// understand proto field names or enums) and sends lowerCamelCase field names.
func writeProtoJSON(w http.ResponseWriter, status int, m proto.Message) {
	data, err := protoJSONOpts.Marshal(m)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "MARSHAL_ERROR", err.Error())
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(data)
}

// writeProtoJSONList serialises a slice of proto messages as a JSON array.
// protojson.Marshal only handles single messages, so we build the array
// manually.
func writeProtoJSONList(w http.ResponseWriter, status int, msgs []proto.Message) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if len(msgs) == 0 {
		_, _ = w.Write([]byte("[]"))
		return
	}
	_, _ = w.Write([]byte("["))
	for i, m := range msgs {
		if i > 0 {
			_, _ = w.Write([]byte(","))
		}
		data, err := protoJSONOpts.Marshal(m)
		if err != nil {
			// Best effort — write null for this element
			_, _ = w.Write([]byte("null"))
			continue
		}
		_, _ = w.Write(data)
	}
	_, _ = w.Write([]byte("]"))
}

// writeError writes a standard error envelope.
func writeError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, map[string]string{"error": message, "code": code})
}

// decodeJSON reads and decodes the request body into v.
func decodeJSON(r *http.Request, v any) error {
	defer r.Body.Close()
	return json.NewDecoder(r.Body).Decode(v)
}

func corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "http://localhost:3002")
		w.Header().Set("Access-Control-Allow-Methods", "GET, PUT, DELETE, POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}
