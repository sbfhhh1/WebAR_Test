const fs = require("fs");
const path = require("path");

const DEFAULT_COMFY_BASE_URL = "https://977qqnuu43t86uzs-80.container.x-gpu.com";
const DEFAULT_WORKFLOW_FILE = "sent2unity.json";
const DEFAULT_PROMPT_TEMPLATE =
  "{prompt}, 3D clay toy render, cute small animal, full body, single subject, product render, object only, no human, no face, no portrait, no bust, no statue, high quality, detailed";
const DEFAULT_NEGATIVE_PROMPT =
  "human, person, portrait, bust, statue, sculpture, head, face, mask, mannequin, beautiful woman, anime girl, female, woman, girl, man, boy, body, skin, eyes, lips, hair, selfie, text, watermark, logo, signature, low quality, worst quality";

function json(statusCode, payload) {
  return {
    statusCode,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(payload),
  };
}

function parseEvent(event) {
  if (!event) return {};
  if (typeof event.body === "string") {
    try {
      return JSON.parse(event.body);
    } catch {
      return {};
    }
  }
  if (event.body && typeof event.body === "object") return event.body;
  return event;
}

function baseUrl() {
  return (process.env.COMFY_BASE_URL || DEFAULT_COMFY_BASE_URL).replace(/\/+$/, "");
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function loadWorkflowTemplate() {
  if (process.env.COMFY_WORKFLOW_JSON) {
    return JSON.parse(process.env.COMFY_WORKFLOW_JSON);
  }

  const workflowPath = path.join(__dirname, process.env.COMFY_WORKFLOW_FILE || DEFAULT_WORKFLOW_FILE);
  if (fs.existsSync(workflowPath)) {
    return JSON.parse(fs.readFileSync(workflowPath, "utf8"));
  }

  return null;
}

function positiveInt(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function positiveFloat(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function isTranslateNode(node) {
  const type = String(node && node.class_type || "").toLowerCase();
  return type.includes("translate");
}

function isClipTextNode(node) {
  const type = String(node && node.class_type || "").toLowerCase();
  return type.includes("clip") && type.includes("text");
}

function isKSamplerNode(node) {
  const type = String(node && node.class_type || "").toLowerCase();
  return type.includes("ksampler");
}

function isEmptyLatentNode(node) {
  const type = String(node && node.class_type || "").toLowerCase();
  return type.includes("emptylatent");
}

function isCheckpointNode(node) {
  const type = String(node && node.class_type || "").toLowerCase();
  return type.includes("checkpoint");
}

function isSaveImageNode(node) {
  const type = String(node && node.class_type || "").toLowerCase();
  return type.includes("saveimage");
}

function setFirstStringInput(inputs, keys, value) {
  if (!inputs || !value) return false;
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(inputs, key)) {
      inputs[key] = value;
      return true;
    }
  }
  return false;
}

function formatPrompt(template, prompt) {
  const raw = String(prompt || "").trim();
  const actualTemplate = String(template || DEFAULT_PROMPT_TEMPLATE).trim();
  if (!actualTemplate) return raw;
  return actualTemplate.includes("{prompt}")
    ? actualTemplate.replace(/\{prompt\}/g, raw)
    : `${raw}, ${actualTemplate}`;
}

function applyWorkflowOverrides(workflow, options) {
  const rawPrompt = String(options.rawPrompt || options.prompt || "").trim();
  const positivePrompt = formatPrompt(options.promptTemplate, rawPrompt);
  const negativePrompt = String(options.negativePrompt || DEFAULT_NEGATIVE_PROMPT).trim();
  let promptApplied = false;
  let negativeApplied = false;

  for (const [id, node] of Object.entries(workflow)) {
    const inputs = node && node.inputs;
    if (!inputs) continue;

    if (isTranslateNode(node)) {
      promptApplied = setFirstStringInput(inputs, ["text", "prompt", "input", "source_text"], positivePrompt) || promptApplied;
      if (Object.prototype.hasOwnProperty.call(inputs, "from_translate")) inputs.from_translate = "auto";
      if (Object.prototype.hasOwnProperty.call(inputs, "to_translate")) inputs.to_translate = "en";
      if (Object.prototype.hasOwnProperty.call(inputs, "manual_translate")) {
        inputs.manual_translate = false;
      }
      continue;
    }

    if (!promptApplied && isClipTextNode(node)) {
      const existingText = typeof inputs.text === "string" ? inputs.text.toLowerCase() : "";
      const looksNegative = /bad|worst|watermark|text|low quality|person|human/.test(existingText);
      if (!looksNegative && typeof inputs.text === "string" && !Array.isArray(inputs.text)) {
        inputs.text = positivePrompt;
        promptApplied = true;
      }
    }

    if (negativePrompt && isClipTextNode(node)) {
      const existingText = typeof inputs.text === "string" ? inputs.text.toLowerCase() : "";
      if (/bad|worst|watermark|text|low quality|person|human/.test(existingText)) {
        inputs.text = negativePrompt;
        negativeApplied = true;
      }
    }

    if (isKSamplerNode(node)) {
      const fixedSeed = positiveInt(options.seed, 0, 0, 2147483647);
      inputs.seed = options.seedMode === "Fixed" && fixedSeed > 0
        ? fixedSeed
        : Math.floor(Math.random() * 2147483647) + 1;
      inputs.steps = positiveInt(options.steps, inputs.steps || 20, 1, 150);
      inputs.cfg = positiveFloat(options.cfg, inputs.cfg || 8, 0.1, 30);
      if (options.samplerName && Object.prototype.hasOwnProperty.call(inputs, "sampler_name")) inputs.sampler_name = String(options.samplerName);
      if (options.scheduler && Object.prototype.hasOwnProperty.call(inputs, "scheduler")) inputs.scheduler = String(options.scheduler);
    }

    if (isEmptyLatentNode(node)) {
      inputs.width = positiveInt(options.width, inputs.width || 512, 64, 2048);
      inputs.height = positiveInt(options.height, inputs.height || 512, 64, 2048);
    }

    if (options.checkpointName && isCheckpointNode(node) && Object.prototype.hasOwnProperty.call(inputs, "ckpt_name")) {
      inputs.ckpt_name = String(options.checkpointName);
    }

    if (isSaveImageNode(node) && Object.prototype.hasOwnProperty.call(inputs, "filename_prefix")) {
      inputs.filename_prefix = "ComfyUI";
    }

    void id;
  }

  if (!promptApplied) {
    throw new Error("No translate/text prompt input was found in workflow.");
  }

  return { promptApplied, negativeApplied };
}

function fallbackWorkflow(options = {}) {
  const rawPrompt = String(options.rawPrompt || options.prompt || "").trim();
  const positivePrompt = formatPrompt(options.promptTemplate, rawPrompt);
  const negativePrompt = String(options.negativePrompt || DEFAULT_NEGATIVE_PROMPT).trim();
  const fixedSeed = positiveInt(options.seed, 0, 0, 2147483647);
  const seed = options.seedMode === "Fixed" && fixedSeed > 0
    ? fixedSeed
    : Math.floor(Math.random() * 2147483647) + 1;

  return {
    "3": {
      class_type: "KSampler",
      inputs: {
        seed,
        steps: positiveInt(options.steps, 20, 1, 150),
        cfg: positiveFloat(options.cfg, 8, 0.1, 30),
        sampler_name: String(options.samplerName || "euler"),
        scheduler: String(options.scheduler || "normal"),
        denoise: 1,
        model: ["4", 0],
        positive: ["6", 0],
        negative: ["5", 0],
        latent_image: ["7", 0],
      },
    },
    "4": {
      class_type: "CheckpointLoaderSimple",
      inputs: { ckpt_name: String(options.checkpointName || process.env.COMFY_CHECKPOINT || "SD1.5_dreamshaper_8.safetensors") },
    },
    "5": {
      class_type: "CLIPTextEncode",
      inputs: { text: negativePrompt, clip: ["4", 1] },
    },
    "6": {
      class_type: "CLIPTextEncode",
      inputs: { text: positivePrompt, clip: ["4", 1] },
    },
    "7": {
      class_type: "EmptyLatentImage",
      inputs: {
        width: positiveInt(options.width, 512, 64, 2048),
        height: positiveInt(options.height, 512, 64, 2048),
        batch_size: 1,
      },
    },
    "8": {
      class_type: "VAEDecode",
      inputs: { samples: ["3", 0], vae: ["4", 2] },
    },
    "9": {
      class_type: "SaveImage",
      inputs: { filename_prefix: "ComfyUI", images: ["8", 0] },
    },
  };
}

function buildWorkflow(data) {
  const template = loadWorkflowTemplate();
  if (!template) {
    return { workflow: fallbackWorkflow(data), source: "fallback", promptApplied: true, negativeApplied: false };
  }

  const workflow = cloneJson(template);
  const patch = applyWorkflowOverrides(workflow, data);
  return { workflow, source: process.env.COMFY_WORKFLOW_FILE || DEFAULT_WORKFLOW_FILE, ...patch };
}

exports.main = async (event) => {
  if (event && event.httpMethod === "OPTIONS") return json(204, {});

  const data = parseEvent(event);
  const prompt = String(data.rawPrompt || data.prompt || "").trim();
  if (!prompt) return json(400, { error: "Missing prompt." });
  data.rawPrompt = prompt;
  data.prompt = prompt;

  let built;
  try {
    built = buildWorkflow(data);
  } catch (error) {
    return json(500, {
      error: `Workflow patch failed: ${error.message || error}`,
      rawPrompt: prompt,
    });
  }

  const url = `${baseUrl()}/prompt`;
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: built.workflow,
        client_id: "cloudbase-webar",
      }),
    });
  } catch (error) {
    return json(502, {
      error: `ComfyUI fetch failed: ${error.message || error}`,
      comfyBaseUrl: baseUrl(),
      rawPrompt: prompt,
      workflowSource: built.source,
    });
  }

  const bodyText = await response.text();
  let body;
  try {
    body = JSON.parse(bodyText);
  } catch {
    body = { raw: bodyText };
  }

  if (!response.ok) {
    return json(502, {
      error: `ComfyUI submit failed: HTTP ${response.status}`,
      detail: body,
      comfyBaseUrl: baseUrl(),
      rawPrompt: prompt,
      workflowSource: built.source,
    });
  }

  const promptId = body.prompt_id || body.promptId;
  if (!promptId) {
    return json(502, { error: "ComfyUI returned no prompt id.", detail: body, rawPrompt: prompt, workflowSource: built.source });
  }

  return json(200, {
    status: "submitted",
    promptId,
    rawPrompt: prompt,
    positivePrompt: formatPrompt(data.promptTemplate, prompt),
    workflowSource: built.source,
    promptApplied: built.promptApplied,
    negativeApplied: built.negativeApplied,
  });
};
