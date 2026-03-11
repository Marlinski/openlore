/**
 * CLIP ViT-B/32 inference module (server-side, Node.js).
 *
 * Uses onnxruntime-node for model inference and sharp for image preprocessing.
 * Implements a minimal BPE tokenizer from tokenizer.json — no npm tokenizer deps.
 */

import * as ort from "onnxruntime-node";
import sharp from "sharp";
import fs from "node:fs";
import path from "node:path";

// ─── Constants ───────────────────────────────────────────────────────────────

export const EMBEDDING_DIM = 512;

const IMAGE_SIZE = 224;
const MAX_SEQ_LEN = 77;

const CLIP_MEAN = [0.48145466, 0.4578275, 0.40821073] as const;
const CLIP_STD = [0.26862954, 0.26130258, 0.27577711] as const;

const BOS_TOKEN_ID = 49406; // <|startoftext|>
const EOS_TOKEN_ID = 49407; // <|endoftext|>

const MODEL_ID = "clip-vit-b32-fp32";

// ─── Module state ────────────────────────────────────────────────────────────

let visionSession: ort.InferenceSession | null = null;
let textSession: ort.InferenceSession | null = null;

/** BPE vocab: token string → id */
let vocab: Map<string, number> | null = null;
/** BPE merge list in priority order (index = priority) */
let merges: [string, string][] | null = null;
/** Byte-to-unicode mapping (GPT-2 style) */
let byteEncoder: Map<number, string> | null = null;

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Returns a string identifying the model variant, for storing in DB.
 */
export function getModelId(): string {
  return MODEL_ID;
}

/**
 * Load both ONNX sessions and the BPE tokenizer. Call once at startup.
 * @param modelsDir Path to `data/models/clip-vit-base-patch32`
 */
export async function initClip(modelsDir: string): Promise<void> {
  const t0 = performance.now();
  console.log("[clip] Initializing CLIP ViT-B/32...");

  // Load tokenizer
  const tokenizerPath = path.join(modelsDir, "tokenizer.json");
  console.log("[clip] Loading tokenizer from", tokenizerPath);
  const tokT0 = performance.now();
  loadTokenizer(tokenizerPath);
  console.log(`[clip] Tokenizer loaded in ${(performance.now() - tokT0).toFixed(0)}ms (vocab=${vocab!.size}, merges=${merges!.length})`);

  // Load vision model
  const visionPath = path.join(modelsDir, "onnx", "vision_model.onnx");
  console.log("[clip] Loading vision model from", visionPath);
  const vT0 = performance.now();
  visionSession = await ort.InferenceSession.create(visionPath, {
    executionProviders: ["cpu"],
  });
  console.log(`[clip] Vision model loaded in ${(performance.now() - vT0).toFixed(0)}ms`);
  console.log("[clip] Vision model inputs:", visionSession.inputNames);
  console.log("[clip] Vision model outputs:", visionSession.outputNames);

  // Load text model
  const textPath = path.join(modelsDir, "onnx", "text_model.onnx");
  console.log("[clip] Loading text model from", textPath);
  const tT0 = performance.now();
  textSession = await ort.InferenceSession.create(textPath, {
    executionProviders: ["cpu"],
  });
  console.log(`[clip] Text model loaded in ${(performance.now() - tT0).toFixed(0)}ms`);
  console.log("[clip] Text model inputs:", textSession.inputNames);
  console.log("[clip] Text model outputs:", textSession.outputNames);

  console.log(`[clip] Initialization complete in ${(performance.now() - t0).toFixed(0)}ms`);
}

/**
 * Embed a PNG image from a file path.
 * Returns a 512-dim L2-normalized Float32Array.
 */
export async function embedImage(imagePath: string): Promise<Float32Array> {
  const t0 = performance.now();
  const buf = fs.readFileSync(imagePath);
  const result = await embedImageBuffer(buf);
  console.log(`[clip] Image embedded: ${imagePath} (${buf.length} bytes, ${(performance.now() - t0).toFixed(0)}ms)`);
  return result;
}

/**
 * Embed a PNG image from a Buffer.
 * Returns a 512-dim L2-normalized Float32Array.
 */
export async function embedImageBuffer(buffer: Buffer): Promise<Float32Array> {
  if (!visionSession) throw new Error("[clip] Not initialized. Call initClip() first.");

  const t0 = performance.now();
  const pixelValues = await preprocessImage(buffer);
  const tensor = new ort.Tensor("float32", pixelValues, [1, 3, IMAGE_SIZE, IMAGE_SIZE]);

  const feeds: Record<string, ort.Tensor> = { pixel_values: tensor };
  const results = await visionSession.run(feeds);

  // Find the embedding output — try common names
  const embeddingData = extractEmbedding(results, visionSession.outputNames, "vision");
  const normalized = l2Normalize(embeddingData);

  return normalized;
}

/**
 * Embed a text string.
 * Returns a 512-dim L2-normalized Float32Array.
 */
export async function embedText(text: string): Promise<Float32Array> {
  if (!textSession) throw new Error("[clip] Not initialized. Call initClip() first.");
  if (!vocab || !merges || !byteEncoder) throw new Error("[clip] Tokenizer not loaded.");

  const t0 = performance.now();
  const tokenIds = tokenize(text);
  const { inputIds, attentionMask } = padTokens(tokenIds);

  const inputIdsTensor = new ort.Tensor("int64", inputIds, [1, MAX_SEQ_LEN]);
  const attentionMaskTensor = new ort.Tensor("int64", attentionMask, [1, MAX_SEQ_LEN]);

  const feeds: Record<string, ort.Tensor> = {
    input_ids: inputIdsTensor,
    attention_mask: attentionMaskTensor,
  };
  const results = await textSession.run(feeds);

  const embeddingData = extractEmbedding(results, textSession.outputNames, "text");
  const normalized = l2Normalize(embeddingData);

  console.log(`[clip] Text embedded: "${text.slice(0, 80)}" (${(performance.now() - t0).toFixed(0)}ms)`);
  return normalized;
}

// ─── Image preprocessing ─────────────────────────────────────────────────────

/**
 * Preprocess an image buffer for CLIP:
 * 1. Resize to 224x224 (bicubic, matching CLIP's resample=3)
 * 2. Convert to float32 [0, 1]
 * 3. Normalize with CLIP mean/std
 * 4. Convert to CHW layout
 */
async function preprocessImage(buffer: Buffer): Promise<Float32Array> {
  // sharp: resize → raw RGB pixels
  const { data, info } = await sharp(buffer)
    .resize(IMAGE_SIZE, IMAGE_SIZE, { fit: "cover", kernel: "cubic" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const pixels = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  const numPixels = info.width * info.height;
  const chw = new Float32Array(3 * numPixels);

  // Convert HWC uint8 → CHW float32, rescale to [0,1], then normalize
  for (let i = 0; i < numPixels; i++) {
    for (let c = 0; c < 3; c++) {
      const val = pixels[i * 3 + c] / 255.0;
      chw[c * numPixels + i] = (val - CLIP_MEAN[c]) / CLIP_STD[c];
    }
  }

  return chw;
}

// ─── BPE Tokenizer ───────────────────────────────────────────────────────────

/**
 * Build the GPT-2/CLIP byte-to-unicode mapping.
 *
 * Bytes 33..126, 161..172, 174..255 map to their direct unicode codepoints.
 * Remaining bytes (0..32, 127..160, 173) map to 256+ codepoints.
 */
function buildByteEncoder(): Map<number, string> {
  const bs: number[] = [];
  // printable ASCII-ish ranges
  for (let i = 33; i <= 126; i++) bs.push(i);   // ! through ~
  for (let i = 161; i <= 172; i++) bs.push(i);  // ¡ through ¬
  for (let i = 174; i <= 255; i++) bs.push(i);  // ® through ÿ

  const cs = [...bs];
  let n = 0;
  for (let b = 0; b < 256; b++) {
    if (!bs.includes(b)) {
      bs.push(b);
      cs.push(256 + n);
      n++;
    }
  }

  const map = new Map<number, string>();
  for (let i = 0; i < bs.length; i++) {
    map.set(bs[i], String.fromCodePoint(cs[i]));
  }
  return map;
}

/**
 * Load BPE vocab and merges from tokenizer.json.
 */
function loadTokenizer(tokenizerPath: string): void {
  const raw = fs.readFileSync(tokenizerPath, "utf-8");
  const data = JSON.parse(raw) as {
    model: {
      vocab: Record<string, number>;
      merges: string[];
    };
  };

  vocab = new Map(Object.entries(data.model.vocab));
  merges = data.model.merges.map((m) => {
    const parts = m.split(" ");
    return [parts[0], parts.slice(1).join(" ")] as [string, string];
  });
  byteEncoder = buildByteEncoder();
}

/**
 * Tokenize a string using the CLIP BPE tokenizer.
 *
 * Steps:
 * 1. Lowercase + normalize whitespace (matching CLIP's normalizer)
 * 2. Pre-tokenize using CLIP's regex pattern
 * 3. Byte-encode each pre-token
 * 4. Apply BPE merges
 * 5. Wrap with BOS/EOS
 */
function tokenize(text: string): number[] {
  if (!vocab || !merges || !byteEncoder) {
    throw new Error("[clip] Tokenizer not loaded.");
  }

  // Normalize: NFC, collapse whitespace, lowercase
  const normalized = text.normalize("NFC").replace(/\s+/g, " ").toLowerCase().trim();

  // Pre-tokenize with CLIP regex
  // Matches: contractions ('s, 't, etc.), letter sequences, single digits, non-whitespace/non-letter/non-digit sequences
  const pattern = /'s|'t|'re|'ve|'m|'ll|'d|[\p{L}]+|[\p{N}]|[^\s\p{L}\p{N}]+/gu;
  const preTokens = normalized.match(pattern) || [];

  const allTokenIds: number[] = [BOS_TOKEN_ID];

  for (const preToken of preTokens) {
    // Byte-encode: convert each byte of the UTF-8 representation to its unicode char
    const bytes = Buffer.from(preToken, "utf-8");
    let bpeStr = "";
    for (let i = 0; i < bytes.length; i++) {
      bpeStr += byteEncoder!.get(bytes[i])!;
    }

    // Add </w> suffix to the last character (CLIP's end_of_word_suffix)
    const chars = [...bpeStr];
    if (chars.length === 0) continue;
    chars[chars.length - 1] = chars[chars.length - 1] + "</w>";

    // Apply BPE
    const bpeTokens = applyBpe(chars);

    // Look up token IDs
    for (const token of bpeTokens) {
      const id = vocab!.get(token);
      if (id !== undefined) {
        allTokenIds.push(id);
      }
      // Unknown tokens are silently dropped (CLIP uses eos as unk, but in practice BPE covers everything)
    }
  }

  allTokenIds.push(EOS_TOKEN_ID);
  return allTokenIds;
}

/**
 * Apply BPE merges to a list of token strings.
 */
function applyBpe(tokens: string[]): string[] {
  if (!merges) throw new Error("[clip] Merges not loaded.");
  if (tokens.length <= 1) return tokens;

  // Build a lookup for merge priority (lower index = higher priority)
  // We build this lazily per call because the token set is small
  let word = [...tokens];

  while (true) {
    if (word.length < 2) break;

    // Find the highest-priority merge that applies
    let bestMergeIdx = Infinity;
    let bestPairPos = -1;

    for (let i = 0; i < word.length - 1; i++) {
      const pair = word[i] + " " + word[i + 1];
      const idx = getMergeRank(pair);
      if (idx !== -1 && idx < bestMergeIdx) {
        bestMergeIdx = idx;
        bestPairPos = i;
      }
    }

    if (bestPairPos === -1) break;

    // Apply the merge
    const merged = word[bestPairPos] + word[bestPairPos + 1];
    const newWord: string[] = [];
    let i = 0;
    while (i < word.length) {
      if (i === bestPairPos) {
        newWord.push(merged);
        i += 2;
      } else {
        newWord.push(word[i]);
        i++;
      }
    }
    word = newWord;
  }

  return word;
}

/**
 * Cache for merge pair → rank lookups.
 */
let mergeRankCache: Map<string, number> | null = null;

function buildMergeRankCache(): void {
  if (!merges) return;
  mergeRankCache = new Map();
  for (let i = 0; i < merges.length; i++) {
    const key = merges[i][0] + " " + merges[i][1];
    mergeRankCache.set(key, i);
  }
}

function getMergeRank(pair: string): number {
  if (!mergeRankCache) buildMergeRankCache();
  return mergeRankCache!.get(pair) ?? -1;
}

/**
 * Pad token IDs to MAX_SEQ_LEN and create attention mask.
 * Truncates to MAX_SEQ_LEN if needed (keeping BOS at start and EOS at end).
 */
function padTokens(tokenIds: number[]): { inputIds: BigInt64Array; attentionMask: BigInt64Array } {
  let ids = tokenIds;

  // Truncate if too long: keep BOS, truncate middle, keep EOS
  if (ids.length > MAX_SEQ_LEN) {
    ids = [...ids.slice(0, MAX_SEQ_LEN - 1), EOS_TOKEN_ID];
  }

  const inputIds = new BigInt64Array(MAX_SEQ_LEN);
  const attentionMask = new BigInt64Array(MAX_SEQ_LEN);

  for (let i = 0; i < ids.length; i++) {
    inputIds[i] = BigInt(ids[i]);
    attentionMask[i] = 1n;
  }
  // Remaining positions stay 0 (padding)

  return { inputIds, attentionMask };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Extract the embedding vector from ONNX output.
 * Tries common output names: text_embeds, image_embeds, last_hidden_state, etc.
 */
function extractEmbedding(
  results: ort.InferenceSession.OnnxValueMapType,
  outputNames: readonly string[],
  kind: "vision" | "text",
): Float32Array {
  // Try specific names first
  const preferredNames =
    kind === "vision"
      ? ["image_embeds", "image_embedding", "embeddings", "last_hidden_state"]
      : ["text_embeds", "text_embedding", "embeddings", "last_hidden_state"];

  for (const name of preferredNames) {
    if (results[name]) {
      const tensor = results[name];
      const data = tensor.data as Float32Array;
      // If it's a pooled embedding [1, 512], return directly
      if (data.length === EMBEDDING_DIM) return new Float32Array(data);
      // If it's a sequence [1, seq_len, hidden], take first token (CLS)
      if (data.length > EMBEDDING_DIM) return new Float32Array(data.slice(0, EMBEDDING_DIM));
    }
  }

  // Fallback: use the first output
  const firstOutput = results[outputNames[0]];
  if (!firstOutput) throw new Error(`[clip] No output found for ${kind} model`);
  const data = firstOutput.data as Float32Array;
  if (data.length === EMBEDDING_DIM) return new Float32Array(data);
  if (data.length > EMBEDDING_DIM) return new Float32Array(data.slice(0, EMBEDDING_DIM));
  throw new Error(`[clip] Unexpected ${kind} output size: ${data.length}`);
}

/**
 * L2-normalize a vector in place and return it.
 */
function l2Normalize(vec: Float32Array): Float32Array {
  let norm = 0;
  for (let i = 0; i < vec.length; i++) {
    norm += vec[i] * vec[i];
  }
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < vec.length; i++) {
      vec[i] /= norm;
    }
  }
  return vec;
}
