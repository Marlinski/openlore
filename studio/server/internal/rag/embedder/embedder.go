package embedder

import "context"

// Embedder produces L2-normalised float32 vectors from text or image paths.
// Swap implementations (CLIP → Ollama → OpenAI) in main.go without touching
// any indexer or search code.
type Embedder interface {
	// EmbedText encodes a text string into a vector.
	EmbedText(ctx context.Context, text string) ([]float32, error)
	// EmbedTexts encodes multiple text strings in a single batch call.
	EmbedTexts(ctx context.Context, texts []string) ([][]float32, error)
	// EmbedImage encodes an image file (by path) into a vector.
	EmbedImage(ctx context.Context, imagePath string) ([]float32, error)
	// EmbedImages encodes multiple image files (by path) in a single batch call.
	EmbedImages(ctx context.Context, imagePaths []string) ([][]float32, error)
	// Dims returns the vector dimensionality (e.g. 512 for CLIP ViT-B/32).
	Dims() int
}
