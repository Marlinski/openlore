package api

import (
	"encoding/json"
	"net/http"
	"os"
	"strings"

	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
)

// protoJSONOpts is the shared marshal configuration for all proto → JSON
// responses. UseEnumNumbers emits enum fields as integers (e.g. 1 for
// PLACEMENT_LAYER_FLOOR) which matches the TypeScript numeric enums generated
// by protobuf-es.
var protoJSONOpts = protojson.MarshalOptions{
	UseEnumNumbers:  true,
	EmitUnpopulated: true,
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

// allowedOrigins is the set of sites permitted to call the API from a browser.
// The landing page at openlore.xyz registers a session and reads game data, so
// it has to be listed here; GAME_ALLOWED_ORIGINS overrides the whole set as a
// comma-separated list.
func allowedOrigins() map[string]bool {
	raw := os.Getenv("GAME_ALLOWED_ORIGINS")
	if raw == "" {
		raw = "https://openlore.xyz,https://www.openlore.xyz," +
			"https://app.openlore.xyz,https://studio.openlore.xyz," +
			"http://localhost:3002,http://localhost:5173"
	}
	out := make(map[string]bool)
	for _, o := range strings.Split(raw, ",") {
		if o = strings.TrimSpace(o); o != "" {
			out[o] = true
		}
	}
	return out
}

var corsOrigins = allowedOrigins()

func corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Echo the origin back only when it is one we allow, so the response
		// stays valid for credentialed requests and unknown sites get nothing.
		if origin := r.Header.Get("Origin"); corsOrigins[origin] {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Add("Vary", "Origin")
		}
		w.Header().Set("Access-Control-Allow-Methods", "GET, PUT, DELETE, POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}
