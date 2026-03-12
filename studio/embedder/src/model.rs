use std::sync::Mutex;

use anyhow::{Context, Result};
use candle_core::{DType, Device, IndexOp, Tensor};
use candle_nn::VarBuilder;
use candle_transformers::models::clip;
use tokenizers::Tokenizer;

const IMAGE_SIZE: usize = 224;

/// Shared application state holding the CLIP model, tokenizer, and device.
pub struct AppState {
    model: Mutex<clip::ClipModel>,
    tokenizer: Tokenizer,
    device: Device,
    pad_id: u32,
    model_id: String,
}

impl AppState {
    /// Load a CLIP model from HuggingFace Hub (cached locally).
    pub fn load(model_id: &str, device: Device) -> Result<Self> {
        tracing::info!("downloading/loading {model_id} from HuggingFace Hub...");

        let api = hf_hub::api::sync::Api::new()?;
        let repo = api.repo(hf_hub::Repo::with_revision(
            model_id.into(),
            hf_hub::RepoType::Model,
            "refs/pr/15".into(),
        ));

        let model_path = repo.get("model.safetensors").context("downloading model")?;
        let tokenizer_path = repo
            .get("tokenizer.json")
            .context("downloading tokenizer")?;

        tracing::info!("model cached at {}", model_path.display());

        let config = clip::ClipConfig::vit_base_patch32();

        let vb = unsafe {
            VarBuilder::from_mmaped_safetensors(
                std::slice::from_ref(&model_path),
                DType::F32,
                &device,
            )?
        };

        let model = clip::ClipModel::new(vb, &config)?;
        let tokenizer = Tokenizer::from_file(&tokenizer_path)
            .map_err(|e| anyhow::anyhow!("load tokenizer: {e}"))?;

        let pad_id = *tokenizer
            .get_vocab(true)
            .get("<|endoftext|>")
            .context("tokenizer missing <|endoftext|> token")?;

        tracing::info!(
            "CLIP model ready (device={:?}, dims={})",
            device,
            config.text_config.projection_dim
        );

        Ok(Self {
            model: Mutex::new(model),
            tokenizer,
            device,
            pad_id,
            model_id: model_id.to_string(),
        })
    }

    /// Embedding dimensionality (512 for ViT-B/32).
    pub fn dims(&self) -> usize {
        512
    }

    /// The model ID this instance is serving.
    pub fn model_id(&self) -> &str {
        &self.model_id
    }

    /// Encode a text string into an L2-normalised embedding vector.
    #[allow(dead_code)]
    pub fn encode_text(&self, text: &str) -> Result<Vec<f32>> {
        let encoding = self
            .tokenizer
            .encode(text, true)
            .map_err(|e| anyhow::anyhow!("tokenize: {e}"))?;

        let mut tokens: Vec<u32> = encoding.get_ids().to_vec();

        // Truncate to max 77 tokens (CLIP limit)
        if tokens.len() > 77 {
            tokens.truncate(77);
        }

        let input_ids = Tensor::new(vec![tokens], &self.device)?;

        let model = self.model.lock().map_err(|e| anyhow::anyhow!("{e}"))?;
        let features = model.get_text_features(&input_ids)?;
        let features = clip::div_l2_norm(&features)?;

        Ok(features.i(0)?.to_vec1::<f32>()?)
    }

    /// Encode a batch of text strings into L2-normalised embedding vectors.
    pub fn encode_texts(&self, texts: &[String]) -> Result<Vec<Vec<f32>>> {
        if texts.is_empty() {
            return Ok(vec![]);
        }

        // Tokenize all texts
        let mut batch_tokens: Vec<Vec<u32>> = Vec::with_capacity(texts.len());
        let mut max_len = 0;

        for text in texts {
            let encoding = self
                .tokenizer
                .encode(text.as_str(), true)
                .map_err(|e| anyhow::anyhow!("tokenize: {e}"))?;

            let mut tokens: Vec<u32> = encoding.get_ids().to_vec();
            if tokens.len() > 77 {
                tokens.truncate(77);
            }
            max_len = max_len.max(tokens.len());
            batch_tokens.push(tokens);
        }

        // Pad to uniform length
        for tokens in &mut batch_tokens {
            tokens.resize(max_len, self.pad_id);
        }

        let input_ids = Tensor::new(batch_tokens, &self.device)?;

        let model = self.model.lock().map_err(|e| anyhow::anyhow!("{e}"))?;
        let features = model.get_text_features(&input_ids)?;
        let features = clip::div_l2_norm(&features)?;

        let mut results = Vec::with_capacity(texts.len());
        for i in 0..texts.len() {
            results.push(features.i(i)?.to_vec1::<f32>()?);
        }
        Ok(results)
    }

    /// Encode raw image bytes (PNG, JPEG, etc.) into an L2-normalised embedding vector.
    #[allow(dead_code)]
    pub fn encode_image(&self, bytes: &[u8]) -> Result<Vec<f32>> {
        let pixel_values = preprocess_image(bytes, &self.device)?;

        let model = self.model.lock().map_err(|e| anyhow::anyhow!("{e}"))?;
        let features = model.get_image_features(&pixel_values)?;
        let features = clip::div_l2_norm(&features)?;

        Ok(features.i(0)?.to_vec1::<f32>()?)
    }

    /// Encode a batch of raw image byte slices into L2-normalised embedding vectors.
    pub fn encode_images(&self, images: &[Vec<u8>]) -> Result<Vec<Vec<f32>>> {
        if images.is_empty() {
            return Ok(vec![]);
        }

        let tensors: Vec<Tensor> = images
            .iter()
            .map(|bytes| preprocess_single_image(bytes, &self.device))
            .collect::<Result<Vec<_>>>()?;

        let pixel_values = Tensor::stack(&tensors, 0)?;

        let model = self.model.lock().map_err(|e| anyhow::anyhow!("{e}"))?;
        let features = model.get_image_features(&pixel_values)?;
        let features = clip::div_l2_norm(&features)?;

        let mut results = Vec::with_capacity(images.len());
        for i in 0..images.len() {
            results.push(features.i(i)?.to_vec1::<f32>()?);
        }
        Ok(results)
    }
}

/// Preprocess a single image into a (1, 3, 224, 224) tensor.
fn preprocess_image(bytes: &[u8], device: &Device) -> Result<Tensor> {
    let t = preprocess_single_image(bytes, device)?;
    Ok(t.unsqueeze(0)?) // add batch dim
}

/// Preprocess a single image into a (3, 224, 224) tensor (no batch dim).
fn preprocess_single_image(bytes: &[u8], device: &Device) -> Result<Tensor> {
    let img = image::load_from_memory(bytes).context("decode image")?;
    let img = img.resize_to_fill(
        IMAGE_SIZE as u32,
        IMAGE_SIZE as u32,
        image::imageops::FilterType::Triangle,
    );
    let img = img.to_rgb8();
    let raw = img.into_raw();

    let t = Tensor::from_vec(raw, (IMAGE_SIZE, IMAGE_SIZE, 3), &Device::Cpu)?
        .permute((2, 0, 1))? // HWC -> CHW
        .to_dtype(DType::F32)?
        .affine(2.0 / 255.0, -1.0)?; // [0,255] -> [-1,+1]

    Ok(t.to_device(device)?)
}
