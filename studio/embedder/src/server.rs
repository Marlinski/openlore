use std::sync::Arc;
use std::time::Instant;

use axum::extract::DefaultBodyLimit;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use base64::Engine;
use serde::{Deserialize, Serialize};

use crate::model::AppState;

// ─── Request / Response types (OpenAI-compatible) ────────────────────────────

#[derive(Deserialize)]
pub struct EmbeddingRequest {
    pub input: Vec<String>,
    #[serde(default)]
    pub model: String,
    #[serde(default = "default_modality")]
    pub modality: String,
}

fn default_modality() -> String {
    "text".into()
}

#[derive(Serialize)]
pub struct EmbeddingResponse {
    pub object: &'static str,
    pub data: Vec<EmbeddingData>,
    pub model: String,
    pub usage: Usage,
}

#[derive(Serialize)]
pub struct EmbeddingData {
    pub object: &'static str,
    pub embedding: Vec<f32>,
    pub index: usize,
}

#[derive(Serialize)]
pub struct Usage {
    pub prompt_tokens: usize,
    pub total_tokens: usize,
}

#[derive(Serialize)]
pub struct HealthResponse {
    pub status: &'static str,
    pub model: String,
    pub dims: usize,
}

#[derive(Serialize)]
struct ErrorBody {
    error: String,
}

// ─── Router ──────────────────────────────────────────────────────────────────

pub fn router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/embeddings", post(embeddings))
        .route("/health", get(health))
        // Allow large payloads for batch image embedding (base64-encoded PNGs).
        // Default axum limit is 2MB; we need ~50MB for batches of 50 images.
        .layer(DefaultBodyLimit::max(64 * 1024 * 1024))
        .with_state(state)
}

// ─── Handlers ────────────────────────────────────────────────────────────────

async fn health(State(state): State<Arc<AppState>>) -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "ok",
        model: state.model_id().to_string(),
        dims: state.dims(),
    })
}

async fn embeddings(
    State(state): State<Arc<AppState>>,
    Json(req): Json<EmbeddingRequest>,
) -> Result<Json<EmbeddingResponse>, impl IntoResponse> {
    if req.input.is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(ErrorBody {
                error: "input must not be empty".into(),
            }),
        ));
    }

    // Validate model if provided
    if !req.model.is_empty() && req.model != state.model_id() {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(ErrorBody {
                error: format!(
                    "model '{}' not found, this server serves '{}'",
                    req.model,
                    state.model_id()
                ),
            }),
        ));
    }

    let model_id = state.model_id().to_string();
    let n_inputs = req.input.len();
    let modality = req.modality.clone();
    let state = state.clone();

    let t0 = Instant::now();
    tracing::info!(modality = %modality, count = n_inputs, "embedding request");

    let result = tokio::task::spawn_blocking(move || match req.modality.as_str() {
        "image" => encode_images(&state, &req.input),
        _ => encode_texts(&state, &req.input),
    })
    .await
    .map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorBody {
                error: format!("task join error: {e}"),
            }),
        )
    })?
    .map_err(|e| {
        tracing::error!(modality = %modality, count = n_inputs, elapsed_ms = t0.elapsed().as_millis() as u64, error = %e, "embedding failed");
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorBody {
                error: format!("embedding error: {e}"),
            }),
        )
    })?;

    tracing::info!(modality = %modality, count = n_inputs, elapsed_ms = t0.elapsed().as_millis() as u64, "embedding done");

    let data: Vec<EmbeddingData> = result
        .into_iter()
        .enumerate()
        .map(|(i, embedding)| EmbeddingData {
            object: "embedding",
            embedding,
            index: i,
        })
        .collect();

    let total_tokens = data.len();

    Ok(Json(EmbeddingResponse {
        object: "list",
        data,
        model: model_id,
        usage: Usage {
            prompt_tokens: total_tokens,
            total_tokens,
        },
    }))
}

// ─── Encoding helpers ────────────────────────────────────────────────────────

fn encode_texts(state: &AppState, inputs: &[String]) -> anyhow::Result<Vec<Vec<f32>>> {
    state.encode_texts(inputs)
}

fn encode_images(state: &AppState, inputs: &[String]) -> anyhow::Result<Vec<Vec<f32>>> {
    let mut image_bytes: Vec<Vec<u8>> = Vec::with_capacity(inputs.len());

    for input in inputs {
        let bytes = decode_image_input(input)?;
        image_bytes.push(bytes);
    }

    state.encode_images(&image_bytes)
}

/// Decode an image input — supports base64 data URIs and file:// paths.
fn decode_image_input(input: &str) -> anyhow::Result<Vec<u8>> {
    if let Some(rest) = input.strip_prefix("data:") {
        // data:image/png;base64,iVBOR...
        let (_, b64) = rest
            .split_once(",")
            .ok_or_else(|| anyhow::anyhow!("invalid data URI: missing comma"))?;
        let bytes = base64::engine::general_purpose::STANDARD.decode(b64)?;
        Ok(bytes)
    } else if let Some(path) = input.strip_prefix("file://") {
        // file:///absolute/path/to/image.png
        let bytes = std::fs::read(path)?;
        Ok(bytes)
    } else {
        anyhow::bail!(
            "unsupported image input format — use data:image/...;base64,... or file:///path"
        )
    }
}
