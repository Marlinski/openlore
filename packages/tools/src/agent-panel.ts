/**
 * Agent panel — slide-out drawer with AI chat, tool display, and settings.
 */

import {
  configureAgent,
  setSystemPrompt,
  sendMessage,
  clearConversation,
  isConfigured,
  type AgentEvent,
  type AgentConfig,
} from "./vlm-agent.js";
import { type AgentToolResult, type AgentPreset, setActiveTab, getActiveTools, getActivePresets, getContextSnapshot, onToolsChanged } from "./agent-tools.js";

// ─── Settings persistence ───────────────────────────────────────

const SETTINGS_KEY = "offisims_agent_settings";

interface AgentSettings {
  apiKey: string;
  baseURL: string;
  model: string;
}

const DEFAULT_SETTINGS: AgentSettings = {
  apiKey: "",
  baseURL: "https://openrouter.ai/api/v1",
  model: "google/gemini-2.5-flash",
};

function loadSettings(): AgentSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return { ...DEFAULT_SETTINGS, ...parsed };
    }
  } catch { /* ignore */ }
  return { ...DEFAULT_SETTINGS };
}

function saveSettings(settings: AgentSettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch { /* ignore */ }
}

// ─── Tab system prompts ─────────────────────────────────────────

const tabSystemPrompts = new Map<string, string>();

/**
 * Register a system prompt for a specific tab.
 * Called by each tab during init.
 */
export function setTabSystemPrompt(tabId: string, prompt: string): void {
  tabSystemPrompts.set(tabId, prompt);
}

// ─── State ──────────────────────────────────────────────────────

let panelOpen = false;
let sending = false;
let currentAbortController: AbortController | null = null;
let activeTabId = "cutter";

/** Map from tool_call_id to its DOM element, so tool_result can be merged in */
const pendingToolElements = new Map<string, HTMLDivElement>();

// ─── DOM refs (set during init) ─────────────────────────────────

let panel: HTMLDivElement;
let toggleBtn: HTMLButtonElement;
let settingsToggle: HTMLButtonElement;
let settingsSection: HTMLDivElement;
let apiKeyInput: HTMLInputElement;
let baseUrlInput: HTMLInputElement;
let modelSelect: HTMLSelectElement;
let modelCustomInput: HTMLInputElement;
let messagesDiv: HTMLDivElement;
let inputArea: HTMLTextAreaElement;
let sendBtn: HTMLButtonElement;
let clearBtn: HTMLButtonElement;
let closeBtn: HTMLButtonElement;
let contextDiv: HTMLDivElement;
let contextOverlay: HTMLDivElement;
let contextOverlayTitle: HTMLSpanElement;
let contextOverlayBody: HTMLDivElement;
let contextOverlayClose: HTMLButtonElement;
let presetsDiv: HTMLDivElement;

// ─── Panel toggle ───────────────────────────────────────────────

function openPanel(): void {
  panelOpen = true;
  panel.classList.add("open");
  toggleBtn.classList.add("active");
  inputArea.focus();
}

function closePanel(): void {
  panelOpen = false;
  panel.classList.remove("open");
  toggleBtn.classList.remove("active");
}

function togglePanel(): void {
  if (panelOpen) closePanel();
  else openPanel();
}

// ─── Settings ───────────────────────────────────────────────────

function applySettings(): void {
  const customModel = modelCustomInput.value.trim();
  const selectedModel = modelSelect.value;
  const settings: AgentSettings = {
    apiKey: apiKeyInput.value.trim(),
    baseURL: baseUrlInput.value.trim() || DEFAULT_SETTINGS.baseURL,
    model: customModel || selectedModel || DEFAULT_SETTINGS.model,
  };
  saveSettings(settings);
  configureAgent(settings);
}

function toggleSettings(): void {
  const isVisible = settingsSection.style.display !== "none";
  settingsSection.style.display = isVisible ? "none" : "block";
  settingsToggle.textContent = isVisible ? "Settings ▸" : "Settings ▾";
}

// ─── Message rendering ──────────────────────────────────────────

function scrollToBottom(): void {
  messagesDiv.scrollTop = messagesDiv.scrollHeight;
}

function addMessageElement(className: string, html: string): HTMLDivElement {
  const div = document.createElement("div");
  div.className = `agent-msg ${className}`;
  div.innerHTML = html;
  messagesDiv.appendChild(div);
  scrollToBottom();
  return div;
}

function removeThinking(): void {
  const thinking = messagesDiv.querySelector(".agent-msg.thinking");
  if (thinking) thinking.remove();
}

function renderUserMessage(text: string): void {
  const escaped = escapeHtml(text);
  addMessageElement("user", `<div class="msg-content">${escaped}</div>`);
}

function renderAssistantText(text: string): void {
  removeThinking();
  // Simple markdown-ish rendering: code blocks, bold, inline code
  const rendered = renderSimpleMarkdown(text);
  addMessageElement("assistant", `<div class="msg-content">${rendered}</div>`);
}

function renderToolUse(id: string, name: string, args: string): void {
  removeThinking();
  let formattedArgs = args;
  try {
    formattedArgs = JSON.stringify(JSON.parse(args), null, 2);
  } catch { /* keep raw */ }
  const escaped = escapeHtml(formattedArgs);
  const div = addMessageElement(
    "tool-use",
    `<div class="tool-use-header" style="cursor: pointer;">` +
    `<span class="tool-use-name">⚙ ${escapeHtml(name)}</span>` +
    `<span class="tool-use-status">running…</span>` +
    `<span class="tool-use-toggle">▸</span>` +
    `</div>` +
    `<div class="tool-use-details" style="display: none;">` +
    `<div class="tool-use-section"><div class="msg-label">Args</div><pre class="msg-code">${escaped}</pre></div>` +
    `<div class="tool-use-result"></div>` +
    `</div>`,
  );
  // Toggle expand/collapse
  const header = div.querySelector(".tool-use-header") as HTMLDivElement;
  const details = div.querySelector(".tool-use-details") as HTMLDivElement;
  const toggle = div.querySelector(".tool-use-toggle") as HTMLSpanElement;
  header.addEventListener("click", () => {
    const visible = details.style.display !== "none";
    details.style.display = visible ? "none" : "block";
    toggle.textContent = visible ? "▸" : "▾";
  });
  pendingToolElements.set(id, div);
}

function completeToolUse(id: string, name: string, result: AgentToolResult): void {
  const div = pendingToolElements.get(id);
  if (!div) {
    // Fallback: no matching call element, render standalone
    renderStandaloneToolResult(name, result);
    return;
  }
  pendingToolElements.delete(id);

  // Update status
  const status = div.querySelector(".tool-use-status") as HTMLSpanElement;
  if (status) status.textContent = "done";

  // Fill in the result section
  const resultDiv = div.querySelector(".tool-use-result") as HTMLDivElement;
  if (!resultDiv) return;

  let html = `<div class="msg-label">Result</div>`;
  if (typeof result === "string") {
    const truncated = result.length > 500 ? result.slice(0, 500) + "…" : result;
    html += `<pre class="msg-code">${escapeHtml(truncated)}</pre>`;
  } else {
    for (const part of result) {
      if (part.type === "text" && part.text) {
        const truncated = part.text.length > 300 ? part.text.slice(0, 300) + "…" : part.text;
        html += `<pre class="msg-code">${escapeHtml(truncated)}</pre>`;
      } else if (part.type === "image_url" && part.image_url) {
        html += `<img class="msg-image" src="${part.image_url.url}" alt="tool result" />`;
      }
    }
  }
  resultDiv.innerHTML = html;
  scrollToBottom();
}

function renderStandaloneToolResult(name: string, result: AgentToolResult): void {
  if (typeof result === "string") {
    const truncated = result.length > 500 ? result.slice(0, 500) + "…" : result;
    addMessageElement(
      "tool-use",
      `<div class="tool-use-header"><span class="tool-use-name">↩ ${escapeHtml(name)}</span></div><pre class="msg-code">${escapeHtml(truncated)}</pre>`,
    );
  } else {
    let html = `<div class="tool-use-header"><span class="tool-use-name">↩ ${escapeHtml(name)}</span></div>`;
    for (const part of result) {
      if (part.type === "text" && part.text) {
        const truncated = part.text.length > 300 ? part.text.slice(0, 300) + "…" : part.text;
        html += `<pre class="msg-code">${escapeHtml(truncated)}</pre>`;
      } else if (part.type === "image_url" && part.image_url) {
        html += `<img class="msg-image" src="${part.image_url.url}" alt="tool result" />`;
      }
    }
    addMessageElement("tool-use", html);
  }
}

function renderThinking(): void {
  removeThinking();
  addMessageElement("thinking", `<div class="msg-content thinking-dots">Thinking<span>...</span></div>`);
}

function renderError(message: string): void {
  removeThinking();
  addMessageElement("error", `<div class="msg-content">${escapeHtml(message)}</div>`);
}

function renderContextSnapshot(snapshot: string): void {
  const escaped = escapeHtml(snapshot);
  const div = addMessageElement(
    "context-snapshot",
    `<div class="msg-label" style="cursor: pointer;">📋 Injected context <span class="context-toggle">▸</span></div><pre class="msg-code context-body" style="display: none;">${escaped}</pre>`,
  );
  const label = div.querySelector(".msg-label") as HTMLDivElement;
  const body = div.querySelector(".context-body") as HTMLPreElement;
  const toggle = div.querySelector(".context-toggle") as HTMLSpanElement;
  label.addEventListener("click", () => {
    const visible = body.style.display !== "none";
    body.style.display = visible ? "none" : "block";
    toggle.textContent = visible ? "▸" : "▾";
  });
}

// ─── Send message ───────────────────────────────────────────────

async function handleSend(): Promise<void> {
  const text = inputArea.value.trim();
  if (!text || sending) return;

  if (!isConfigured()) {
    renderError("Set your API key in the settings above.");
    // Auto-open settings
    if (settingsSection.style.display === "none") toggleSettings();
    return;
  }

  sending = true;
  sendBtn.disabled = true;
  inputArea.value = "";
  inputArea.style.height = "auto";

  renderUserMessage(text);
  renderPresets();

  // Show the context snapshot that will be injected
  const snapshot = getContextSnapshot();
  if (snapshot) {
    renderContextSnapshot(snapshot);
  }

  currentAbortController = new AbortController();

  await sendMessage(text, (event: AgentEvent) => {
    switch (event.type) {
      case "thinking":
        renderThinking();
        break;
      case "text":
        renderAssistantText(event.content);
        break;
      case "tool_call":
        renderToolUse(event.id, event.name, event.args);
        break;
      case "tool_result":
        completeToolUse(event.id, event.name, event.result);
        break;
      case "error":
        renderError(event.message);
        break;
      case "done":
        removeThinking();
        break;
    }
  }, currentAbortController.signal);

  sending = false;
  sendBtn.disabled = false;
  currentAbortController = null;
  inputArea.focus();
}

function handleClear(): void {
  clearConversation();
  messagesDiv.innerHTML = "";
  addMessageElement(
    "system",
    `<div class="msg-content">Conversation cleared. Type a message to start.</div>`,
  );
  renderPresets();
}

// ─── Helpers ────────────────────────────────────────────────────

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Very simple markdown rendering for assistant messages */
function renderSimpleMarkdown(text: string): string {
  let html = escapeHtml(text);
  // Code blocks: ```...```
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_m, _lang, code) => {
    return `<pre class="msg-code">${code}</pre>`;
  });
  // Inline code: `...`
  html = html.replace(/`([^`]+)`/g, '<code class="msg-inline-code">$1</code>');
  // Bold: **...**
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  // Newlines
  html = html.replace(/\n/g, "<br>");
  return html;
}

// ─── Context chips (show injected system prompt + tools) ────────

function renderContextChips(): void {
  contextDiv.innerHTML = "";

  const prompt = tabSystemPrompts.get(activeTabId) ?? "";
  const tools = getActiveTools();

  if (!prompt && tools.length === 0) {
    const hint = document.createElement("span");
    hint.style.cssText = "font-size: 10px; color: var(--text-dim); font-style: italic;";
    hint.textContent = "No context injected for this tab";
    contextDiv.appendChild(hint);
    return;
  }

  // System prompt chip
  if (prompt) {
    const chip = document.createElement("button");
    chip.className = "agent-context-chip system-prompt";
    chip.textContent = "System Prompt";
    chip.title = "Click to view the system prompt sent to the AI";
    chip.addEventListener("click", () => showContextOverlay("System Prompt", prompt));
    contextDiv.appendChild(chip);
  }

  // Tool definition chips
  // Known conditional tools (shown greyed out when not registered)
  const CONDITIONAL_TOOLS: Record<string, string> = {
    fetch_selected: "Available when an area is selected on the canvas",
  };

  // Collect active tool names for quick lookup
  const activeToolNames = new Set(tools.map((t) => t.name));

  // Tool definition chips — active tools
  for (const tool of tools) {
    const chip = document.createElement("button");
    chip.className = "agent-context-chip tool-def";
    chip.textContent = tool.name;
    chip.title = `Click to view tool definition: ${tool.name}`;
    const toolDetail = `${tool.name}\n\n${tool.description}\n\nParameters:\n${JSON.stringify(tool.parameters, null, 2)}`;
    chip.addEventListener("click", () => showContextOverlay(`Tool: ${tool.name}`, toolDetail));
    contextDiv.appendChild(chip);
  }

  // Conditional tool chips — shown greyed out when not registered
  for (const [name, hint] of Object.entries(CONDITIONAL_TOOLS)) {
    if (!activeToolNames.has(name)) {
      const chip = document.createElement("button");
      chip.className = "agent-context-chip tool-def inactive";
      chip.textContent = name;
      chip.title = hint;
      chip.disabled = true;
      contextDiv.appendChild(chip);
    }
  }
}

function renderPresets(): void {
  if (!presetsDiv) return;
  presetsDiv.innerHTML = "";

  // Only show presets when conversation is fresh (no user/assistant messages)
  const hasConversation = messagesDiv.querySelector(".agent-msg.user, .agent-msg.assistant, .agent-msg.tool-use") !== null;
  if (hasConversation) return;

  const presets = getActivePresets();
  if (presets.length === 0) return;

  for (const preset of presets) {
    const btn = document.createElement("button");
    btn.className = "agent-preset-btn";
    btn.textContent = preset.label;
    btn.title = preset.prompt;
    btn.addEventListener("click", () => {
      inputArea.value = preset.prompt;
      handleSend();
    });
    presetsDiv.appendChild(btn);
  }
}

function showContextOverlay(title: string, content: string): void {
  contextOverlayTitle.textContent = title;
  contextOverlayBody.innerHTML = `<pre>${escapeHtml(content)}</pre>`;
  contextOverlay.classList.add("visible");
}

function hideContextOverlay(): void {
  contextOverlay.classList.remove("visible");
}

// ─── Tab change handler ─────────────────────────────────────────

/**
 * Called by main.ts when the active tab changes.
 * Updates the active tab in the tool registry and system prompt.
 */
export function onTabChange(tabId: string): void {
  activeTabId = tabId;
  setActiveTab(tabId);
  const prompt = tabSystemPrompts.get(tabId) ?? "";
  setSystemPrompt(prompt);
  // Re-render context chips and presets if panel is initialized
  if (contextDiv) {
    renderContextChips();
    renderPresets();
  }
}

// ─── Init ───────────────────────────────────────────────────────

export function initAgentPanel(): void {
  // Grab DOM elements
  panel = document.getElementById("agent-panel") as HTMLDivElement;
  toggleBtn = document.getElementById("agent-toggle-btn") as HTMLButtonElement;
  settingsToggle = document.getElementById("agent-settings-toggle") as HTMLButtonElement;
  settingsSection = document.getElementById("agent-settings") as HTMLDivElement;
  apiKeyInput = document.getElementById("agent-api-key") as HTMLInputElement;
  baseUrlInput = document.getElementById("agent-base-url") as HTMLInputElement;
  modelSelect = document.getElementById("agent-model") as HTMLSelectElement;
  modelCustomInput = document.getElementById("agent-model-custom") as HTMLInputElement;
  messagesDiv = document.getElementById("agent-messages") as HTMLDivElement;
  inputArea = document.getElementById("agent-input") as HTMLTextAreaElement;
  sendBtn = document.getElementById("agent-send-btn") as HTMLButtonElement;
  clearBtn = document.getElementById("agent-clear-btn") as HTMLButtonElement;
  closeBtn = document.getElementById("agent-close-btn") as HTMLButtonElement;
  contextDiv = document.getElementById("agent-context") as HTMLDivElement;
  contextOverlay = document.getElementById("agent-context-overlay") as HTMLDivElement;
  contextOverlayTitle = document.getElementById("agent-context-overlay-title") as HTMLSpanElement;
  contextOverlayBody = document.getElementById("agent-context-overlay-body") as HTMLDivElement;
  contextOverlayClose = document.getElementById("agent-context-overlay-close") as HTMLButtonElement;

  // Load saved settings
  const settings = loadSettings();
  apiKeyInput.value = settings.apiKey;
  baseUrlInput.value = settings.baseURL;

  // Set model: check if saved model matches a dropdown option
  const savedModel = settings.model;
  const matchesOption = Array.from(modelSelect.options).some((o) => o.value === savedModel);
  if (matchesOption) {
    modelSelect.value = savedModel;
    modelCustomInput.value = "";
  } else {
    modelSelect.value = modelSelect.options[0]?.value ?? "";
    modelCustomInput.value = savedModel;
  }

  // Configure the agent if we have a key
  if (settings.apiKey) {
    configureAgent(settings);
  }

  // Event listeners
  toggleBtn.addEventListener("click", togglePanel);

  settingsToggle.addEventListener("click", toggleSettings);

  // Save settings on change
  apiKeyInput.addEventListener("change", applySettings);
  baseUrlInput.addEventListener("change", applySettings);
  modelSelect.addEventListener("change", () => {
    // When dropdown changes, clear custom input and apply
    modelCustomInput.value = "";
    applySettings();
  });
  modelCustomInput.addEventListener("change", applySettings);

  sendBtn.addEventListener("click", handleSend);
  clearBtn.addEventListener("click", handleClear);
  closeBtn.addEventListener("click", closePanel);

  // Context overlay
  contextOverlayClose.addEventListener("click", hideContextOverlay);
  contextOverlay.addEventListener("click", (e) => {
    if (e.target === contextOverlay) hideContextOverlay();
  });

  // Enter to send, Shift+Enter for newline
  inputArea.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  });

  // Auto-resize textarea
  inputArea.addEventListener("input", () => {
    inputArea.style.height = "auto";
    inputArea.style.height = Math.min(inputArea.scrollHeight, 120) + "px";
  });

  // Welcome message
  addMessageElement(
    "system",
    `<div class="msg-content">AI assistant ready. Type a message to start.</div>`,
  );

  // Create presets container (inserted before messages)
  presetsDiv = document.createElement("div");
  presetsDiv.id = "agent-presets";
  presetsDiv.className = "agent-presets";
  messagesDiv.parentNode!.insertBefore(presetsDiv, messagesDiv);

  // Render initial context chips and presets
  renderContextChips();
  renderPresets();

  // Re-render chips and presets when tools change (e.g. fetch_selected becomes available/unavailable)
  onToolsChanged(() => {
    renderContextChips();
    renderPresets();
  });

  // Set initial tab
  onTabChange("cutter");
}
