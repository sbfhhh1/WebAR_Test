(function () {
  const SAMPLE_RATE = 16000;
  const FRAME_SIZE = 1280;
  const FINAL_RESULT_TIMEOUT_MS = 8000;
  const MIN_RECORDING_MS = 900;
  const VOICE_VERSION = "comfygen27-small-spinner";

  const USE_DIRECT_XFYUN_AUTH = window.XFYUN_ALLOW_BROWSER_SIGNING === true;
  const DIRECT_XFYUN_APP_ID = window.XFYUN_DIRECT_APP_ID || "";
  const DIRECT_XFYUN_API_KEY = window.XFYUN_DIRECT_API_KEY || "";
  const DIRECT_XFYUN_API_SECRET = window.XFYUN_DIRECT_API_SECRET || "";

  const GENERATED_IMAGE_OBJECT = "GeneratedImageDisplayController";
  const GENERATED_IMAGE_METHOD = "OnGeneratedImageUrl";
  const COMFY_RUNTIME_OBJECT = "ComfyUIRuntimeController";
  const COMFY_RUNTIME_STATUS_METHOD = "OnGenerationStatus";
  const AUTH_ENDPOINT = window.XFYUN_AUTH_ENDPOINT || "";
  const COMFY_SUBMIT_ENDPOINT = window.COMFY_SUBMIT_ENDPOINT || "";
  const COMFY_STATUS_ENDPOINT = window.COMFY_STATUS_ENDPOINT || "";
  const COMFY_SUBMIT_FUNCTION = window.COMFY_SUBMIT_FUNCTION || "comfySubmit";
  const COMFY_STATUS_FUNCTION = window.COMFY_STATUS_FUNCTION || "comfyStatus";
  const COMFY_DIRECT_BASE_URL = (window.COMFY_DIRECT_BASE_URL || "").replace(/\/+$/, "");
  const COMFY_DIRECT_FIRST = window.COMFY_DIRECT_FIRST === true;
  const COMFY_WORKFLOW_JSON_URL = window.COMFY_WORKFLOW_JSON_URL || "sent2unity.json";
  const COMFY_FALLBACK_TO_DIRECT = window.COMFY_FALLBACK_TO_DIRECT !== false;
  const COMFY_POLL_INTERVAL_MS = Number(window.COMFY_POLL_INTERVAL_MS || 2000);
  const COMFY_TIMEOUT_MS = Number(window.COMFY_TIMEOUT_MS || 120000);

  let state = "idle";
  let websocket = null;
  let mediaStream = null;
  let ownsMediaStream = true;
  let audioContext = null;
  let processor = null;
  let source = null;
  let pcmBuffer = [];
  let sendStatus = 0;
  let finalText = "";
  let partialText = "";
  let resultPieces = [];
  let finalResultTimer = null;
  let stopRequested = false;
  let sentAudioFrames = 0;
  let receivedResultMessages = 0;
  let maxInputVolume = 0;
  let recordingStartedAt = 0;
  let pendingStopTimer = null;
  let comfyRequestSerial = 0;
  let directWorkflowTemplatePromise = null;

  function $(id) {
    return document.getElementById(id);
  }

  function setVoiceVisual(mode) {
    const button = $("voiceButton");
    if (!button) return;
    button.classList.toggle("voiceButtonActive", mode === "recording");
    button.classList.toggle("voiceButtonProcessing", mode === "processing" || mode === "generating");
  }

  function vibrate(pattern) {
    try {
      if (navigator.vibrate) navigator.vibrate(pattern);
    } catch (error) {
      // Haptics are best-effort in embedded browsers.
    }
  }

  function updateStatus(message, active) {
    const label = $("voiceStatus");
    if (label) label.textContent = message;
    if (active) {
      setVoiceVisual("recording");
      return;
    }
    const button = $("voiceButton");
    if (button && !button.classList.contains("voiceButtonProcessing")) {
      setVoiceVisual("idle");
    }
  }

  function updateButtonText(text) {
    const button = $("voiceButton");
    if (!button) return;
    button.setAttribute("data-label", text);
    button.setAttribute("aria-label", text);
    if (!button.querySelector(".voicePulse")) {
      const pulse = document.createElement("span");
      pulse.className = "voicePulse";
      button.appendChild(pulse);
    }
  }
  function formatError(error) {
    if (!error) return "unknown";
    if (typeof error === "string") return error.slice(0, 180);
    let detail = "";
    try {
      detail = JSON.stringify(error);
    } catch (jsonError) {
      detail = String(error);
    }
    return `${error.name || "Error"}:${error.message || error.errMsg || error.msg || detail}`.slice(0, 260);
  }

  function clearFinalResultTimer() {
    if (finalResultTimer) clearTimeout(finalResultTimer);
    finalResultTimer = null;
  }

  function clearPendingStopTimer() {
    if (pendingStopTimer) clearTimeout(pendingStopTimer);
    pendingStopTimer = null;
  }

  function resetRecognitionState() {
    state = "idle";
    websocket = null;
    audioContext = null;
    scriptNode = null;
    mediaStream = null;
    finalText = "";
    partialText = "";
    audioPeak = 0;
    updateButtonText("\u6309\u4f4f\u8bf4\u8bdd");
    setVoiceVisual("idle");
  }
  function debugInfo() {
    return `frames:${sentAudioFrames} results:${receivedResultMessages} volume:${maxInputVolume.toFixed(2)}`;
  }

  function finishRecognition(message) {
    const recognizedText = (finalText || partialText).trim();
    updateStatus(message || (recognizedText ? `\u8bc6\u522b\u5230\uff1a${recognizedText}` : `\u672a\u8bc6\u522b\u5230\u8bed\u97f3\uff08${debugInfo()}\uff09`), false);
    resetRecognitionState();
    routeRecognizedText(recognizedText);
  }
  function failRecognition(message) {
    updateStatus(`${message || "voice recognition failed"} (${debugInfo()})`, false);
    resetRecognitionState();
  }

  function base64ArrayBuffer(buffer) {
    let binary = "";
    const bytes = new Uint8Array(buffer);
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
  }

  function downsampleTo16BitPcm(input, inputSampleRate) {
    const ratio = inputSampleRate / SAMPLE_RATE;
    const outputLength = Math.floor(input.length / ratio);
    const output = new Int16Array(outputLength);
    let inputOffset = 0;
    for (let i = 0; i < outputLength; i++) {
      const nextInputOffset = Math.floor((i + 1) * ratio);
      let sum = 0;
      let count = 0;
      for (; inputOffset < nextInputOffset && inputOffset < input.length; inputOffset++) {
        sum += input[inputOffset];
        count++;
      }
      const sample = Math.max(-1, Math.min(1, count ? sum / count : 0));
      output[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
    }
    return output;
  }

  function sendFrame(samples, isLast) {
    if (!websocket || websocket.readyState !== WebSocket.OPEN) return;
    const payload = {
      data: {
        status: isLast ? 2 : sendStatus,
        format: "audio/L16;rate=16000",
        encoding: "raw",
        audio: samples ? base64ArrayBuffer(samples.buffer) : "",
      },
    };
    if (sendStatus === 0) {
      payload.common = { app_id: window.XFYUN_APP_ID };
      payload.business = {
        language: "zh_cn",
        domain: "iat",
        accent: "mandarin",
        vad_eos: 5000,
      };
    }
    websocket.send(JSON.stringify(payload));
    if (!isLast) {
      sendStatus = 1;
      if (samples && samples.length) sentAudioFrames++;
    }
  }

  function flushPcmFrames() {
    if (!websocket || websocket.readyState !== WebSocket.OPEN) return;
    while (pcmBuffer.length >= FRAME_SIZE) {
      sendFrame(new Int16Array(pcmBuffer.splice(0, FRAME_SIZE)), false);
    }
  }

  function sendRemainingAudioAndEnd() {
    if (sendStatus === 0 && !pcmBuffer.length) sendFrame(new Int16Array(FRAME_SIZE), false);
    while (pcmBuffer.length >= FRAME_SIZE) sendFrame(new Int16Array(pcmBuffer.splice(0, FRAME_SIZE)), false);
    if (pcmBuffer.length > 0) {
      const tail = new Int16Array(FRAME_SIZE);
      tail.set(pcmBuffer.splice(0, pcmBuffer.length));
      sendFrame(tail, false);
    }
    sendFrame(null, true);
    updateStatus("\u5f55\u97f3\u5b8c\u6210\uff0c\u6b63\u5728\u6574\u7406\u8bc6\u522b\u7ed3\u679c...", false);
    setVoiceVisual("processing");
    clearFinalResultTimer();
    finalResultTimer = setTimeout(() => {
      finishRecognition(partialText ? `\u8bc6\u522b\u5230\uff1a${partialText}` : "\u672a\u8bc6\u522b\u5230\u8bed\u97f3");
    }, FINAL_RESULT_TIMEOUT_MS);
  }
  function extractText(message) {
    const result = message && message.data && message.data.result;
    if (!result || !result.ws) return "";
    return result.ws.map((item) => (item.cw && item.cw[0] ? item.cw[0].w : "")).join("");
  }

  function applyRecognitionText(message, text) {
    const result = message && message.data && message.data.result;
    const status = message && message.data && message.data.status;
    if (!result || !text) return;
    if (result.pgs === "rpl" && Array.isArray(result.rg) && result.rg.length === 2) {
      const start = Math.max(0, result.rg[0] - 1);
      const deleteCount = Math.max(0, result.rg[1] - result.rg[0] + 1);
      resultPieces.splice(start, deleteCount, text);
      partialText = resultPieces.join("");
      return;
    }
    if (result.pgs === "apd") {
      resultPieces.push(text);
      partialText = resultPieces.join("");
      return;
    }
    if (status === 2) {
      finalText += text;
      partialText = finalText;
      return;
    }
    partialText = resultPieces.length ? resultPieces.join("") + text : text;
  }

  function handleResult(event) {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch (error) {
      console.warn("Failed to parse XFYUN result:", error);
      return;
    }
    receivedResultMessages++;
    if (message.code && message.code !== 0) {
      failRecognition(message.code === 401 || message.code === 403 ? "\u8bed\u97f3\u670d\u52a1\u9274\u6743\u5931\u8d25" : "\u8bed\u97f3\u8bc6\u522b\u5931\u8d25");
      return;
    }
    const text = extractText(message);
    if (text) {
      applyRecognitionText(message, text);
      updateStatus(`\u8bc6\u522b\u4e2d\uff1a${finalText || partialText}`, true);
    }
    if (message.data && message.data.status === 2) finishRecognition();
  }

  function normalizeRecognizedText(text) {
    return (text || "").replace(/[\s\uFF0C\u3002\uFF01\uFF1F\u3001,.!?;\uFF1B:"'\u201C\u201D\u2018\u2019\uFF08\uFF09()\[\]\u3010\u3011]/g, "").trim();
  }

  function extractGenerationPrompt(text) {
    const raw = (text || "").trim();
    const normalized = normalizeRecognizedText(raw);
    if (!normalized.startsWith("\u751f\u6210")) return "";
    return raw
      .replace(/^[\s\uFF0C\u3002\uFF01\uFF1F\u3001,.!?;\uFF1B:"'\u201C\u201D\u2018\u2019\uFF08\uFF09()\[\]\u3010\u3011]*\u751F\u6210[\s\uFF0C\u3002\uFF01\uFF1F\u3001,.!?;\uFF1B:"'\u201C\u201D\u2018\u2019\uFF08\uFF09()\[\]\u3010\u3011]*/i, "")
      .trim();
  }

  function routeRecognizedText(text) {
    if (!text) return;
    const prompt = extractGenerationPrompt(text);
    if (!prompt) {
      updateStatus("\u8bf7\u8bf4\u201c\u751f\u6210...\u201d\u6765\u521b\u5efa\u56fe\u7247", false);
      return;
    }
    startComfyGeneration(prompt);
  }

  function sendGeneratedImageUrl(imageUrl) {
    if (!imageUrl || !window.unityInstance) {
      updateStatus("image ready, Unity is not ready", false);
      return;
    }
    window.unityInstance.SendMessage(GENERATED_IMAGE_OBJECT, GENERATED_IMAGE_METHOD, imageUrl);
  }

  function sendUnityGenerationStatus(status, promptId, imageUrl, error) {
    if (!window.unityInstance) return;
    const payload = {
      status: status || "",
      promptId: promptId || "",
      imageUrl: imageUrl || "",
      error: error || "",
    };
    window.unityInstance.SendMessage(COMFY_RUNTIME_OBJECT, COMFY_RUNTIME_STATUS_METHOD, JSON.stringify(payload));
  }

  function parseCloudFunctionPayload(result) {
    let payload = result && result.result ? result.result : result;
    if (payload && payload.statusCode && payload.statusCode >= 400) {
      const errorBody = typeof payload.body === "string" ? JSON.parse(payload.body) : payload.body;
      throw new Error((errorBody && (errorBody.error || errorBody.message)) || payload.error || payload.message || "Cloud function request failed.");
    }
    if (payload && typeof payload.body === "string") payload = JSON.parse(payload.body);
    return payload;
  }

  const COMFY_COLOR_WORDS = [
    ["\u84dd", "blue"],
    ["\u7ea2", "red"],
    ["\u7eff", "green"],
    ["\u9ec4", "yellow"],
    ["\u7d2b", "purple"],
    ["\u7c89", "pink"],
    ["\u9ed1", "black"],
    ["\u767d", "white"],
    ["\u91d1", "gold"],
    ["\u94f6", "silver"],
    ["\u5f69\u8272", "colorful"],
  ];

  const COMFY_SUBJECT_WORDS = [
    ["\u8774\u8776", "butterfly"],
    ["\u82b1\u6735", "flower"],
    ["\u82b1", "flower"],
    ["\u74e2\u866b", "ladybug"],
    ["\u718a", "bear"],
    ["\u623f\u5b50", "house"],
    ["\u57ce\u5821", "castle"],
    ["\u6c7d\u8f66", "car"],
    ["\u5c0f\u8f66", "car"],
    ["\u673a\u5668\u4eba", "robot"],
    ["\u98de\u8239", "spaceship"],
    ["\u9f99", "dragon"],
    ["\u74f6\u5b50", "glass bottle"],
    ["\u6c34\u6676", "crystal"],
    ["\u6811", "tree"],
    ["\u5c71", "mountain"],
    ["\u6d77", "ocean"],
    ["\u6708\u4eae", "moon"],
    ["\u592a\u9633", "sun"],
    ["\u4e91", "cloud"],
    ["\u732b", "cat"],
    ["\u72d7", "dog"],
    ["\u72d0\u72f8", "fox"],
    ["\u5c0f\u72d0\u72f8", "fox"],
    ["\u5154\u5b50", "rabbit"],
    ["\u8001\u864e", "tiger"],
    ["\u72ee\u5b50", "lion"],
    ["\u9e7f", "deer"],
    ["\u9a6c", "horse"],
    ["\u4f01\u9e45", "penguin"],
    ["\u9e2d\u5b50", "duck"],
    ["\u5927\u8c61", "elephant"],
    ["\u6050\u9f99", "dinosaur"],
    ["\u72ec\u89d2\u517d", "unicorn"],
    ["\u9e1f", "bird"],
    ["\u9c7c", "fish"],
  ];

  const COMFY_STYLE_WORDS = [
    ["\u673a\u68b0", "mechanical, hard surface, metallic"],
    ["\u91d1\u5c5e", "metallic"],
    ["\u672a\u6765", "futuristic sci fi"],
    ["\u79d1\u5e7b", "sci fi"],
    ["\u5361\u901a", "cartoon style"],
    ["\u9ecf\u571f", "clay render"],
    ["\u73bb\u7483", "glass material"],
    ["\u6c34\u6676", "crystal material"],
    ["\u53ef\u7231", "cute"],
    ["\u5199\u5b9e", "realistic"],
    ["\u53d1\u5149", "glowing"],
    ["\u8d5b\u535a", "cyberpunk"],
    ["\u50cf\u7d20", "pixel art"],
  ];

  function enhanceComfyPrompt(prompt) {
    return String(prompt || "").trim();
  }

  function isComfyTranslateNode(node) {
    return String((node && node.class_type) || "").toLowerCase().includes("translate");
  }

  function isComfyClipTextNode(node) {
    const type = String((node && node.class_type) || "").toLowerCase();
    return type.includes("clip") && type.includes("text");
  }

  function isComfyKSamplerNode(node) {
    return String((node && node.class_type) || "").toLowerCase().includes("ksampler");
  }

  function isComfyLatentNode(node) {
    return String((node && node.class_type) || "").toLowerCase().includes("emptylatent");
  }

  function isComfyCheckpointNode(node) {
    return String((node && node.class_type) || "").toLowerCase().includes("checkpoint");
  }

  function isComfySaveImageNode(node) {
    return String((node && node.class_type) || "").toLowerCase().includes("saveimage");
  }

  function clampInt(value, fallback, min, max) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(min, Math.min(max, Math.floor(parsed)));
  }

  function clampFloat(value, fallback, min, max) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(min, Math.min(max, parsed));
  }

  function cloneComfyJson(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function setFirstComfyStringInput(inputs, keys, value) {
    if (!inputs) return false;
    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(inputs, key)) {
        inputs[key] = value;
        return true;
      }
    }
    return false;
  }

  async function loadDirectWorkflowTemplate() {
    if (!directWorkflowTemplatePromise) {
      directWorkflowTemplatePromise = fetch(COMFY_WORKFLOW_JSON_URL, { cache: "no-store" })
        .then((response) => {
          if (!response.ok) throw new Error("Failed to load workflow JSON: " + response.status);
          return response.json();
        })
        .catch((error) => {
          console.warn("Workflow JSON unavailable, using fallback workflow:", error);
          return null;
        });
    }
    return directWorkflowTemplatePromise;
  }

  function applyDirectWorkflowOverrides(workflow, rawPrompt) {
    const positivePrompt = formatComfyPrompt(rawPrompt);
    const negativePrompt = window.COMFY_NEGATIVE_PROMPT || "human, person, portrait, bust, statue, sculpture, head, face, mask, mannequin, beautiful woman, anime girl, female, woman, girl, man, boy, body, skin, eyes, lips, hair, selfie, text, watermark, logo, signature, low quality, worst quality";
    let promptApplied = false;

    for (const node of Object.values(workflow)) {
      const inputs = node && node.inputs;
      if (!inputs) continue;

      if (isComfyTranslateNode(node)) {
        promptApplied = setFirstComfyStringInput(inputs, ["text", "prompt", "input", "source_text"], positivePrompt) || promptApplied;
        if (Object.prototype.hasOwnProperty.call(inputs, "from_translate")) inputs.from_translate = "auto";
        if (Object.prototype.hasOwnProperty.call(inputs, "to_translate")) inputs.to_translate = "en";
        if (Object.prototype.hasOwnProperty.call(inputs, "manual_translate")) inputs.manual_translate = false;
        continue;
      }

      if (isComfyClipTextNode(node)) {
        const existingText = typeof inputs.text === "string" ? inputs.text.toLowerCase() : "";
        const looksNegative = /bad|worst|watermark|text|low quality|person|human|portrait|statue|sculpture/.test(existingText);
        if (looksNegative) {
          inputs.text = negativePrompt;
        } else if (!promptApplied && typeof inputs.text === "string") {
          inputs.text = positivePrompt;
          promptApplied = true;
        }
      }

      if (isComfyKSamplerNode(node)) {
        const fixedSeed = clampInt(window.COMFY_FIXED_SEED, 0, 0, 2147483647);
        inputs.seed = window.COMFY_SEED_MODE === "Fixed" && fixedSeed > 0 ? fixedSeed : Math.floor(Math.random() * 2147483647) + 1;
        inputs.steps = clampInt(window.COMFY_STEPS, inputs.steps || 20, 1, 150);
        inputs.cfg = clampFloat(window.COMFY_CFG, inputs.cfg || 8, 0.1, 30);
        if (window.COMFY_SAMPLER_NAME && Object.prototype.hasOwnProperty.call(inputs, "sampler_name")) inputs.sampler_name = String(window.COMFY_SAMPLER_NAME);
        if (window.COMFY_SCHEDULER && Object.prototype.hasOwnProperty.call(inputs, "scheduler")) inputs.scheduler = String(window.COMFY_SCHEDULER);
      }

      if (isComfyLatentNode(node)) {
        inputs.width = clampInt(window.COMFY_WIDTH, inputs.width || 512, 64, 2048);
        inputs.height = clampInt(window.COMFY_HEIGHT, inputs.height || 512, 64, 2048);
      }

      if (window.COMFY_CHECKPOINT_NAME && isComfyCheckpointNode(node) && Object.prototype.hasOwnProperty.call(inputs, "ckpt_name")) {
        inputs.ckpt_name = String(window.COMFY_CHECKPOINT_NAME);
      }

      if (isComfySaveImageNode(node) && Object.prototype.hasOwnProperty.call(inputs, "filename_prefix")) {
        inputs.filename_prefix = "ComfyUI";
      }
    }
  }

  function defaultComfyWorkflow(prompt) {
    const seedMode = window.COMFY_SEED_MODE || "Random";
    const seed = seedMode === "Fixed"
      ? Number(window.COMFY_FIXED_SEED || 156680208)
      : Math.floor(Math.random() * 1000000000000000);
    return {
      "3": {
        class_type: "KSampler",
        inputs: {
          seed,
          steps: Number(window.COMFY_STEPS || 20),
          cfg: Number(window.COMFY_CFG || 8),
          sampler_name: window.COMFY_SAMPLER_NAME || "euler",
          scheduler: window.COMFY_SCHEDULER || "normal",
          denoise: 1,
          model: ["4", 0],
          positive: ["6", 0],
          negative: ["5", 0],
          latent_image: ["7", 0],
        },
      },
      "4": {
        class_type: "CheckpointLoaderSimple",
        inputs: { ckpt_name: window.COMFY_CHECKPOINT_NAME || "SD1.5_dreamshaper_8.safetensors" },
      },
      "5": {
        class_type: "CLIPTextEncode",
        inputs: { text: window.COMFY_NEGATIVE_PROMPT || "human, person, portrait, bust, statue, sculpture, head, face, mask, mannequin, beautiful woman, anime girl, female, woman, girl, man, boy, body, skin, eyes, lips, hair, selfie, text, watermark, logo, signature, low quality, worst quality", clip: ["4", 1] },
      },
      "6": {
        class_type: "CLIPTextEncode",
        inputs: { text: formatComfyPrompt(prompt), clip: ["4", 1] },
      },
      "7": {
        class_type: "EmptyLatentImage",
        inputs: {
          width: Number(window.COMFY_WIDTH || 512),
          height: Number(window.COMFY_HEIGHT || 512),
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

  async function buildDirectComfyWorkflow(prompt) {
    const template = await loadDirectWorkflowTemplate();
    const workflow = template ? cloneComfyJson(template) : defaultComfyWorkflow(prompt);
    applyDirectWorkflowOverrides(workflow, prompt);
    return workflow;
  }

  function formatComfyPrompt(prompt) {
    const template = window.COMFY_PROMPT_TEMPLATE || "{prompt}, 3D clay toy render, cute small animal, full body, single subject, product render, object only, no human, no face, no portrait, no bust, no statue, high quality, detailed";
    const effectivePrompt = enhanceComfyPrompt(prompt);
    return template.indexOf("{prompt}") >= 0 ? template.replace("{prompt}", effectivePrompt) : `${template} ${effectivePrompt}`;
  }

  async function submitComfyDirect(prompt) {
    if (!COMFY_DIRECT_BASE_URL) throw new Error("Missing ComfyUI direct URL.");
    const response = await fetch(`${COMFY_DIRECT_BASE_URL}/prompt`, {
      method: "POST",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: await buildDirectComfyWorkflow(prompt),
        client_id: "webar-direct",
      }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || body.message || JSON.stringify(body));
    return { promptId: body.prompt_id || body.promptId };
  }

  async function fetchComfyStatusDirect(promptId) {
    if (!COMFY_DIRECT_BASE_URL) throw new Error("Missing ComfyUI direct URL.");
    const response = await fetch(`${COMFY_DIRECT_BASE_URL}/history/${encodeURIComponent(promptId)}`, {
      method: "GET",
      cache: "no-store",
    });
    const history = await response.json();
    if (!response.ok) throw new Error(history.error || history.message || "ComfyUI status failed.");
    const item = history[promptId];
    if (!item) return { status: "pending", promptId };
    if (item.status && item.status.status_str === "error") {
      return { status: "failed", promptId, error: "ComfyUI workflow failed." };
    }
    const outputs = item.outputs || {};
    for (const output of Object.values(outputs)) {
      if (output && output.images && output.images[0]) {
        const image = output.images[0];
        const params = new URLSearchParams({
          filename: image.filename,
          subfolder: image.subfolder || "",
          type: image.type || "output",
        });
        return {
          status: "done",
          promptId,
          image,
          imageUrl: `${COMFY_DIRECT_BASE_URL}/view?${params.toString()}`,
        };
      }
    }
    return { status: "pending", promptId };
  }

  function loadCloudBaseSdk() {
    if (window.cloudbase) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://static.cloudbase.net/cloudbase-js-sdk/latest/cloudbase.full.js";
      script.onload = resolve;
      script.onerror = () => reject(new Error("Failed to load CloudBase Web SDK."));
      document.head.appendChild(script);
    });
  }

  async function callCloudBaseFunction(name, data) {
    await loadCloudBaseSdk();
    const app = cloudbase.init({
      env: window.CLOUDBASE_ENV_ID,
      region: window.CLOUDBASE_REGION || "ap-shanghai",
    });

    async function invoke() {
      return parseCloudFunctionPayload(await app.callFunction({ name, data, parse: true }));
    }

    try {
      return await invoke();
    } catch (firstError) {
      const firstMessage = formatError(firstError);
      const shouldRetryWithAuth = /unauthenticated|credentials|auth|login/i.test(firstMessage);
      if (!shouldRetryWithAuth) throw new Error(firstMessage);

      try {
        const auth = app.auth({ persistence: "local" });
        const loginState = auth && auth.hasLoginState ? await auth.hasLoginState() : null;
        if (!loginState && auth && auth.anonymousAuthProvider) {
          await auth.anonymousAuthProvider().signIn();
        }
        return await invoke();
      } catch (authError) {
        throw new Error("CloudBase " + name + " auth failed: direct=" + firstMessage + "; anonymous=" + formatError(authError));
      }
    }
  }
  async function submitComfyPrompt(prompt) {
    const rawPrompt = String(prompt || "").trim();
    const comfyRequest = {
      prompt: rawPrompt,
      rawPrompt,
      checkpointName: window.COMFY_CHECKPOINT_NAME || "SD1.5_dreamshaper_8.safetensors",
      promptTemplate: window.COMFY_PROMPT_TEMPLATE || "{prompt}, 3D clay toy render, cute small animal, full body, single subject, product render, object only, no human, no face, no portrait, no bust, no statue, high quality, detailed",
      negativePrompt: window.COMFY_NEGATIVE_PROMPT || "human, person, portrait, bust, statue, sculpture, head, face, mask, mannequin, beautiful woman, anime girl, female, woman, girl, man, boy, body, skin, eyes, lips, hair, selfie, text, watermark, logo, signature, low quality, worst quality",
      width: Number(window.COMFY_WIDTH || 512),
      height: Number(window.COMFY_HEIGHT || 512),
      seedMode: window.COMFY_SEED_MODE || "Random",
      seed: Number(window.COMFY_FIXED_SEED || 156680208),
      steps: Number(window.COMFY_STEPS || 20),
      cfg: Number(window.COMFY_CFG || 8),
      samplerName: window.COMFY_SAMPLER_NAME || "euler",
      scheduler: window.COMFY_SCHEDULER || "normal",
    };

    if (COMFY_DIRECT_FIRST && COMFY_DIRECT_BASE_URL) return submitComfyDirect(prompt);

    if (COMFY_SUBMIT_ENDPOINT) {
      const response = await fetch(COMFY_SUBMIT_ENDPOINT, {
        method: "POST",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(comfyRequest),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Failed to submit ComfyUI prompt.");
      return body;
    }
    try {
      return await callCloudBaseFunction(COMFY_SUBMIT_FUNCTION, comfyRequest);
    } catch (cloudError) {
      console.warn("CloudBase comfySubmit failed, using direct ComfyUI:", cloudError);
      if (!COMFY_FALLBACK_TO_DIRECT) throw cloudError;
      updateStatus("CloudBase \u751f\u6210\u5931\u8d25\uff0c\u6539\u7528\u76f4\u8fde ComfyUI...", true);
      return submitComfyDirect(prompt);
    }
  }

  async function fetchComfyStatus(promptId) {
    if (COMFY_DIRECT_FIRST && COMFY_DIRECT_BASE_URL) return fetchComfyStatusDirect(promptId);

    if (COMFY_STATUS_ENDPOINT) {
      const url = new URL(COMFY_STATUS_ENDPOINT, window.location.href);
      url.searchParams.set("promptId", promptId);
      const response = await fetch(url.toString(), { method: "GET", cache: "no-store" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Failed to get ComfyUI status.");
      return body;
    }
    try {
      return await callCloudBaseFunction(COMFY_STATUS_FUNCTION, { promptId });
    } catch (cloudError) {
      console.warn("CloudBase comfyStatus failed, using direct ComfyUI:", cloudError);
      if (!COMFY_FALLBACK_TO_DIRECT) throw cloudError;
      return fetchComfyStatusDirect(promptId);
    }
  }

  async function startComfyGeneration(prompt) {
    const serial = ++comfyRequestSerial;
    updateButtonText("\u751f\u6210\u4e2d");
    setVoiceVisual("generating");
    updateStatus(`\u63d0\u4ea4\u751f\u6210\u4e2d\uff1a${prompt}`, false);
    setVoiceVisual("generating");
    sendUnityGenerationStatus("submitting", "", "", "");
    try {
      const submitted = await submitComfyPrompt(prompt);
      if (submitted && submitted.error) throw new Error(submitted.error);
      const promptId = submitted.promptId || submitted.prompt_id;
      if (!promptId) throw new Error("ComfyUI did not return a promptId.");
      if (submitted.effectivePrompt) console.log("[ComfyUI] Effective prompt:", submitted.effectivePrompt);
      updateStatus(`\u56fe\u7247\u751f\u6210\u4e2d\uff1a${prompt}`, false);
      setVoiceVisual("generating");
      sendUnityGenerationStatus("submitted", promptId, "", "");
      const startedAt = Date.now();
      while (Date.now() - startedAt < COMFY_TIMEOUT_MS) {
        if (serial !== comfyRequestSerial) return;
        updateStatus(`\u56fe\u7247\u751f\u6210\u4e2d\uff1a${prompt}`, false);
      setVoiceVisual("generating");
        sendUnityGenerationStatus("pending", promptId, "", "");
        await new Promise((resolve) => setTimeout(resolve, COMFY_POLL_INTERVAL_MS));
        const status = await fetchComfyStatus(promptId);
        if (status.status === "failed" || status.status === "error") {
          throw new Error(status.error || "ComfyUI generation failed.");
        }
        if (status.status === "done" && status.imageUrl) {
          sendGeneratedImageUrl(status.imageUrl);
          sendUnityGenerationStatus("done", promptId, status.imageUrl, "");
          updateStatus(`\u5df2\u663e\u793a\uff1a${prompt}`, false);
          updateButtonText("\u6309\u4f4f\u8bf4\u8bdd");
          return;
        }
      }
      throw new Error("ComfyUI generation timed out.");
    } catch (error) {
      console.error(error);
      sendUnityGenerationStatus("error", "", "", formatError(error));
      updateStatus(`\u751f\u6210\u5931\u8d25\uff1a${formatError(error)}`, false);
      updateButtonText("\u6309\u4f4f\u8bf4\u8bdd");
    }
  }
  function parseAuthPayload(body) {
    let payload = body && body.result ? body.result : body;
    if (payload && payload.statusCode && payload.statusCode >= 400) {
      const errorBody = typeof payload.body === "string" ? JSON.parse(payload.body) : payload.body;
      throw new Error((errorBody && errorBody.error) || "Failed to get XFYUN auth URL.");
    }
    if (payload && typeof payload.body === "string") payload = JSON.parse(payload.body);
    if (!payload || !payload.appId || !payload.url) throw new Error("Invalid XFYUN auth payload.");
    window.XFYUN_APP_ID = payload.appId;
    return payload.url;
  }

  async function createDirectAuthUrl() {
    if (!DIRECT_XFYUN_APP_ID || !DIRECT_XFYUN_API_KEY || !DIRECT_XFYUN_API_SECRET) {
      throw new Error("XFYUN credentials are missing.");
    }
    if (!window.crypto || !window.crypto.subtle) throw new Error("\u5f53\u524d\u6d4f\u89c8\u5668\u4e0d\u652f\u6301 WebCrypto \u7b7e\u540d\u3002");
    const host = "iat-api.xfyun.cn";
    const path = "/v2/iat";
    const date = new Date().toUTCString();
    const signatureOrigin = `host: ${host}\ndate: ${date}\nGET ${path} HTTP/1.1`;
    const key = await window.crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(DIRECT_XFYUN_API_SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const signatureBuffer = await window.crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signatureOrigin));
    const signature = base64ArrayBuffer(signatureBuffer);
    const authorizationOrigin =
      `api_key="${DIRECT_XFYUN_API_KEY}", algorithm="hmac-sha256", headers="host date request-line", signature="${signature}"`;
    const authorization = btoa(authorizationOrigin);
    window.XFYUN_APP_ID = DIRECT_XFYUN_APP_ID;
    return `wss://${host}${path}?authorization=${encodeURIComponent(authorization)}&date=${encodeURIComponent(date)}&host=${host}`;
  }

  async function fetchAuthWithCloudBase() {
    const payload = await callCloudBaseFunction("xfyunAuth", {});
    return parseAuthPayload(payload);
  }

  async function fetchAuth() {
    if (USE_DIRECT_XFYUN_AUTH) return createDirectAuthUrl();
    if (!AUTH_ENDPOINT) return fetchAuthWithCloudBase();
    const response = await fetch(AUTH_ENDPOINT, { method: "GET", cache: "no-store" });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || "Failed to get XFYUN auth URL.");
    return parseAuthPayload(body);
  }

  async function startAudioCapture() {
            const reusableStream = window.preGrantedAudioStream;
    const reusableTracks = reusableStream && reusableStream.getAudioTracks ? reusableStream.getAudioTracks().filter((track) => track.readyState === "live") : [];
    if (reusableTracks.length) {
      mediaStream = reusableStream;
      ownsMediaStream = false;
    } else {
      mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      ownsMediaStream = true;
    }
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    if (audioContext.state === "suspended") await audioContext.resume();
    source = audioContext.createMediaStreamSource(mediaStream);
    processor = audioContext.createScriptProcessor(4096, 1, 1);
    processor.onaudioprocess = (event) => {
      if (state !== "recording" || !audioContext) return;
      const input = event.inputBuffer.getChannelData(0);
      for (let i = 0; i < input.length; i++) {
        const volume = Math.abs(input[i]);
        if (volume > maxInputVolume) maxInputVolume = volume;
      }
      const pcm = downsampleTo16BitPcm(input, audioContext.sampleRate);
      for (let i = 0; i < pcm.length; i++) pcmBuffer.push(pcm[i]);
      flushPcmFrames();
    };
    source.connect(processor);
    processor.connect(audioContext.destination);
  }

  async function startRecognition(event) {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
    if (state !== "idle") return;

    state = "starting";
    finalText = "";
    partialText = "";
    resultPieces = [];
    pcmBuffer = [];
    sendStatus = 0;
    stopRequested = false;
    sentAudioFrames = 0;
    receivedResultMessages = 0;
    maxInputVolume = 0;
    recordingStartedAt = 0;
    clearFinalResultTimer();
    clearPendingStopTimer();
    updateButtonText("\u5f55\u97f3\u4e2d");
    setVoiceVisual("recording");
    vibrate([28]);
    updateStatus("\u6b63\u5728\u542f\u52a8\u9ea6\u514b\u98ce...", true);

    try {
      await startAudioCapture();
      state = "recording";
      recordingStartedAt = Date.now();
      updateStatus("\u5f55\u97f3\u4e2d\uff0c\u677e\u5f00\u7ed3\u675f", true);

      const authUrl = await fetchAuth();
      websocket = new WebSocket(authUrl);
      websocket.onmessage = handleResult;
      websocket.onerror = (error) => {
        console.error("XFYUN websocket error:", error);
        failRecognition(`voice service connection failed: ${formatError(error)}`);
      };
      websocket.onclose = () => {
        if (state === "stopping") {
          finishRecognition(partialText ? `\u8bc6\u522b\u5230\uff1a${partialText}` : "\u672a\u8bc6\u522b\u5230\u8bed\u97f3");
        } else if (state !== "idle") {
          failRecognition("voice service closed");
        }
      };
      websocket.onopen = () => {
        if (state === "stopping" || stopRequested) {
          sendRemainingAudioAndEnd();
          return;
        }
        if (state !== "recording") {
          closeSocket();
          return;
        }
        flushPcmFrames();
        updateStatus("\u8bc6\u522b\u4e2d\uff0c\u8bf7\u7ee7\u7eed\u8bf4", true);
      };
    } catch (error) {
      console.error(error);
      failRecognition(`voice recognition start failed: ${formatError(error)}`);
    }
  }

  function stopRecognition(event) {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
    if (state !== "recording" && state !== "starting") return;
    if (state === "recording" && recordingStartedAt > 0) {
      const elapsed = Date.now() - recordingStartedAt;
      if (elapsed < MIN_RECORDING_MS) {
        clearPendingStopTimer();
        pendingStopTimer = setTimeout(() => {
          pendingStopTimer = null;
          stopRecognition();
        }, MIN_RECORDING_MS - elapsed);
        return;
      }
    }
    state = "stopping";
    stopRequested = true;
    clearPendingStopTimer();
    cleanupAudio();
    updateButtonText("\u8bc6\u522b\u4e2d");
    setVoiceVisual("processing");
    vibrate([18, 40, 18]);
    if (!websocket || websocket.readyState !== WebSocket.OPEN) {
      updateStatus("\u5f55\u97f3\u5b8c\u6210\uff0c\u6b63\u5728\u8fde\u63a5\u8bed\u97f3\u670d\u52a1...", false);
      setVoiceVisual("processing");
      clearFinalResultTimer();
      finalResultTimer = setTimeout(() => failRecognition("voice service connection timeout"), FINAL_RESULT_TIMEOUT_MS);
      return;
    }
    sendRemainingAudioAndEnd();
  }

  function cleanupAudio() {
    try {
      if (processor) processor.disconnect();
      if (source) source.disconnect();
      if (mediaStream && ownsMediaStream) mediaStream.getTracks().forEach((track) => track.stop());
      if (audioContext) audioContext.close();
    } catch (error) {
      console.warn("Audio cleanup failed:", error);
    }
    processor = null;
    source = null;
    mediaStream = null;
    ownsMediaStream = true;
    audioContext = null;
  }

  function closeSocket() {
    if (websocket && websocket.readyState === WebSocket.OPEN) websocket.close();
    websocket = null;
  }

  function bindVoiceButton() {
    const button = $("voiceButton");
    if (!button || button.dataset.voiceBound === "1") return;
    button.dataset.voiceBound = "1";
    updateButtonText("\u6309\u4f4f\u8bf4\u8bdd");
    updateStatus(`\u8bed\u97f3\u5df2\u5c31\u7eea ${VOICE_VERSION}\uff0c\u8bf7\u8bf4\u201c\u751f\u6210...\u201d`, false);

    let activeTouchId = null;
    let lastTouchAt = 0;
    const start = (event) => startRecognition(event);
    const stop = (event) => stopRecognition(event);

    button.addEventListener("touchstart", (event) => {
      if (event.changedTouches && event.changedTouches.length) {
        activeTouchId = event.changedTouches[0].identifier;
      }
      lastTouchAt = Date.now();
      start(event);
    }, { passive: false, capture: true });

    button.addEventListener("touchend", (event) => {
      if (activeTouchId !== null && event.changedTouches && event.changedTouches.length) {
        let matched = false;
        for (let i = 0; i < event.changedTouches.length; i++) {
          if (event.changedTouches[i].identifier === activeTouchId) matched = true;
        }
        if (!matched) return;
      }
      activeTouchId = null;
      stop(event);
    }, { passive: false, capture: true });

    button.addEventListener("touchcancel", (event) => {
      if (Date.now() - lastTouchAt < 600) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      activeTouchId = null;
      stop(event);
    }, { passive: false, capture: true });

    if (!("ontouchstart" in window)) {
      if (window.PointerEvent) {
        button.addEventListener("pointerdown", start, { passive: false, capture: true });
        button.addEventListener("pointerup", stop, { passive: false, capture: true });
      } else {
        button.addEventListener("mousedown", start, { capture: true });
        button.addEventListener("mouseup", stop, { capture: true });
        button.addEventListener("mouseleave", stop, { capture: true });
      }
    }

    button.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      event.stopPropagation();
    }, { capture: true });
  }
  window.XfyunVoice = {
    bindVoiceButton,
    startRecognition,
    stopRecognition
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bindVoiceButton);
  } else {
    bindVoiceButton();
  }
})();
