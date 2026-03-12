mod model;
mod server;

use std::sync::Arc;

use anyhow::Result;
use candle_core::Device;
use clap::Parser;

#[derive(Parser)]
#[command(name = "clip-embedder", about = "CLIP embedding server")]
struct Args {
    /// HTTP listen port
    #[arg(short, long, default_value_t = 7997)]
    port: u16,

    /// HuggingFace model ID to serve
    #[arg(short, long, default_value = "openai/clip-vit-base-patch32")]
    model: String,

    /// Use Metal GPU (macOS Apple Silicon)
    #[arg(long, default_value_t = false)]
    metal: bool,
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "clip_embedder=info".parse().unwrap()),
        )
        .init();

    let args = Args::parse();

    let device = if args.metal {
        Device::new_metal(0).unwrap_or_else(|e| {
            tracing::warn!("metal not available ({e}), falling back to CPU");
            Device::Cpu
        })
    } else {
        Device::Cpu
    };

    let state = Arc::new(model::AppState::load(&args.model, device)?);
    let app = server::router(state);

    let addr = format!("0.0.0.0:{}", args.port);
    tracing::info!("clip-embedder listening on http://{addr}");

    let listener = tokio::net::TcpListener::bind(&addr).await?;
    axum::serve(listener, app).await?;

    Ok(())
}
