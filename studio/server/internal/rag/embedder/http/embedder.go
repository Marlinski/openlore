// Package http implements the Embedder interface by calling an external
// embedding server (e.g. clip-embedder) over HTTP. The server must expose
// an OpenAI-compatible POST /embeddings endpoint.
package http

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

// ModelID is the identifier stored alongside vectors for provenance tracking.
const ModelID = "clip-vit-b32-fp32"

// Embedder calls an external HTTP embedding server.
type Embedder struct {
	baseURL string
	model   string
	client  *http.Client
	dims    int
}

// New creates an HTTP Embedder pointing at the given base URL (e.g. "http://localhost:7997").
// model is the model name to send in requests (e.g. "openai/clip-vit-base-patch32").
func New(baseURL, model string) *Embedder {
	return &Embedder{
		baseURL: strings.TrimRight(baseURL, "/"),
		model:   model,
		client: &http.Client{
			Timeout: 120 * time.Second,
		},
		dims: 512,
	}
}

// Dims returns the embedding dimensionality.
func (e *Embedder) Dims() int { return e.dims }

// EmbedText encodes a text string into a vector via the remote server.
func (e *Embedder) EmbedText(ctx context.Context, text string) ([]float32, error) {
	vecs, err := e.embed(ctx, []string{text}, "text")
	if err != nil {
		return nil, err
	}
	if len(vecs) == 0 {
		return nil, fmt.Errorf("empty response from embedder")
	}
	return vecs[0], nil
}

// EmbedTexts encodes multiple text strings in a single batch call.
func (e *Embedder) EmbedTexts(ctx context.Context, texts []string) ([][]float32, error) {
	if len(texts) == 0 {
		return nil, nil
	}
	return e.embed(ctx, texts, "text")
}

// EmbedImage encodes an image file (by path) into a vector via the remote server.
// The image is read from disk and sent as a base64 data URI.
func (e *Embedder) EmbedImage(ctx context.Context, imagePath string) ([]float32, error) {
	dataURI, err := imageToDataURI(imagePath)
	if err != nil {
		return nil, err
	}

	vecs, err := e.embed(ctx, []string{dataURI}, "image")
	if err != nil {
		return nil, err
	}
	if len(vecs) == 0 {
		return nil, fmt.Errorf("empty response from embedder")
	}
	return vecs[0], nil
}

// EmbedImages encodes multiple image files (by path) in a single batch call.
// Images are read from disk and sent as base64 data URIs. Large batches are
// chunked to avoid oversized HTTP requests.
func (e *Embedder) EmbedImages(ctx context.Context, imagePaths []string) ([][]float32, error) {
	if len(imagePaths) == 0 {
		return nil, nil
	}

	// Convert all paths to data URIs first.
	dataURIs := make([]string, len(imagePaths))
	for i, p := range imagePaths {
		uri, err := imageToDataURI(p)
		if err != nil {
			return nil, fmt.Errorf("image %d (%s): %w", i, p, err)
		}
		dataURIs[i] = uri
	}

	// Send in chunks to keep HTTP payload size and GPU memory reasonable.
	// Base64-encoded images are ~4/3× their raw size; tileset PNGs range
	// from a few KB to ~200KB, so 16 images ≈ 1-4MB per request.
	const chunkSize = 16
	allVecs := make([][]float32, len(imagePaths))
	for start := 0; start < len(dataURIs); start += chunkSize {
		end := start + chunkSize
		if end > len(dataURIs) {
			end = len(dataURIs)
		}
		chunk := dataURIs[start:end]

		vecs, err := e.embed(ctx, chunk, "image")
		if err != nil {
			return nil, fmt.Errorf("batch chunk [%d:%d]: %w", start, end, err)
		}
		if len(vecs) != len(chunk) {
			return nil, fmt.Errorf("batch chunk [%d:%d]: expected %d vectors, got %d", start, end, len(chunk), len(vecs))
		}
		copy(allVecs[start:], vecs)
	}
	return allVecs, nil
}

// ─── internal ────────────────────────────────────────────────────────────────

// imageToDataURI reads an image file from disk and returns a base64 data URI.
func imageToDataURI(imagePath string) (string, error) {
	data, err := os.ReadFile(imagePath)
	if err != nil {
		return "", fmt.Errorf("read image %s: %w", imagePath, err)
	}

	mime := "image/png"
	if strings.HasSuffix(strings.ToLower(imagePath), ".jpg") || strings.HasSuffix(strings.ToLower(imagePath), ".jpeg") {
		mime = "image/jpeg"
	}

	return fmt.Sprintf("data:%s;base64,%s", mime, base64.StdEncoding.EncodeToString(data)), nil
}

type embeddingRequest struct {
	Input    []string `json:"input"`
	Model    string   `json:"model"`
	Modality string   `json:"modality"`
}

type embeddingResponse struct {
	Data  []embeddingData `json:"data"`
	Model string          `json:"model"`
}

type embeddingData struct {
	Embedding []float32 `json:"embedding"`
	Index     int       `json:"index"`
}

type errorResponse struct {
	Error string `json:"error"`
}

func (e *Embedder) embed(ctx context.Context, inputs []string, modality string) ([][]float32, error) {
	reqBody := embeddingRequest{
		Input:    inputs,
		Model:    e.model,
		Modality: modality,
	}

	body, err := json.Marshal(reqBody)
	if err != nil {
		return nil, err
	}

	req, err := http.NewRequestWithContext(ctx, "POST", e.baseURL+"/embeddings", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := e.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("embedder request failed: %w", err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("read embedder response: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		var errResp errorResponse
		if json.Unmarshal(respBody, &errResp) == nil && errResp.Error != "" {
			return nil, fmt.Errorf("embedder error (%d): %s", resp.StatusCode, errResp.Error)
		}
		return nil, fmt.Errorf("embedder error (%d): %s", resp.StatusCode, string(respBody))
	}

	var result embeddingResponse
	if err := json.Unmarshal(respBody, &result); err != nil {
		return nil, fmt.Errorf("decode embedder response: %w", err)
	}

	vecs := make([][]float32, len(result.Data))
	for _, d := range result.Data {
		if d.Index >= len(vecs) {
			continue
		}
		vecs[d.Index] = d.Embedding
	}
	return vecs, nil
}
