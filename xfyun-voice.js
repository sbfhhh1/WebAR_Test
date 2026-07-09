(function () {
  const SAMPLE_RATE = 16000;
  const FRAME_SIZE = 1280;
  const FINAL_RESULT_TIMEOUT_MS = 8000;
  const MIN_RECORDING_MS = 900;
  const VOICE_VERSION = "voicefix11-long";
  const USE_DIRECT_XFYUN_AUTH = window.XFYUN_ALLOW_BROWSER_SIGNING === true;
  const DIRECT_XFYUN_APP_ID = window.XFYUN_DIRECT_APP_ID || "";
  const DIRECT_XFYUN_API_KEY = window.XFYUN_DIRECT_API_KEY || "";
  const DIRECT_XFYUN_API_SECRET = window.XFYUN_DIRECT_API_SECRET || "";
  const MIC_PERMISSION_KEY = "xfyun_voice_mic_primed";
  const AUTH_ENDPOINT = window.XFYUN_AUTH_ENDPOINT || "";
  const TARGET_OBJECT = "VoiceCommandController";
  const TARGET_METHOD = "OnVoiceCommand";

  let state = "idle";
  let websocket = null;
  let mediaStream = null;
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
  let micPrimedThisSession = false;
  let recordingStartedAt = 0;
  let pendingStopTimer = null;

  function $(id) {
    return document.getElementById(id);
  }

  function updateStatus(message, active) {
    const label = $("voiceStatus");
    const button = $("voiceButton");
    if (label) label.textContent = message;
    if (button) button.classList.toggle("voiceButtonActive", !!active);
  }

  function updateButtonText(text) {
    const button = $("voiceButton");
    if (button) button.textContent = text;
  }

  function formatError(error) {
    if (!error) return "unknown";
    if (typeof error === "string") return error.slice(0, 160);
    const name = error.name || "Error";
    const message = error.message || error.errMsg || error.msg || "";
    let detail = "";
    try {
      detail = JSON.stringify(error);
    } catch (jsonError) {
      detail = String(error);
    }
    return `${name}:${message || detail}`.slice(0, 220);
  }

  function clearFinalResultTimer() {
    if (!finalResultTimer) return;
    clearTimeout(finalResultTimer);
    finalResultTimer = null;
  }

  function clearPendingStopTimer() {
    if (!pendingStopTimer) return;
    clearTimeout(pendingStopTimer);
    pendingStopTimer = null;
  }

  function finishRecognition(message) {
    clearFinalResultTimer();
    const recognizedText = (finalText || partialText).trim();
    const debugInfo = `帧:${sentAudioFrames} 回:${receivedResultMessages} 音:${maxInputVolume.toFixed(2)}`;
    updateStatus(message || (recognizedText ? `识别结果：${recognizedText}` : `未识别到语音（${debugInfo}）`));
    updateButtonText("按住说话");
    sendUnityCommand(recognizedText);
    cleanupAudio();
    closeSocket();
    state = "idle";
  }

  function failRecognition(message) {
    clearFinalResultTimer();
    const debugInfo = `帧:${sentAudioFrames} 回:${receivedResultMessages} 音:${maxInputVolume.toFixed(2)}`;
    updateStatus(`${message || "语音识别失败"}（${debugInfo}）`);
    updateButtonText("按住说话");
    cleanupAudio();
    closeSocket();
    state = "idle";
  }

  function hasPrimedMicrophone() {
    if (micPrimedThisSession) return true;
    try {
      return localStorage.getItem(MIC_PERMISSION_KEY) === "1";
    } catch (error) {
      return false;
    }
  }

  function setMicrophonePrimed() {
    micPrimedThisSession = true;
    try {
      localStorage.setItem(MIC_PERMISSION_KEY, "1");
    } catch (error) {
      // Some embedded browsers restrict localStorage; the current page session can still continue.
    }
  }

  async function primeMicrophonePermission() {
    state = "authorizing";
    updateStatus("请先允许麦克风权限", true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      stream.getTracks().forEach((track) => track.stop());
      setMicrophonePrimed();
      state = "idle";
      updateStatus("麦克风已授权，请重新长按说话");
      updateButtonText("按住说话");
    } catch (error) {
      console.error(error);
      state = "idle";
      updateStatus(error && error.name === "NotAllowedError" ? "麦克风权限被拒绝" : "麦克风授权失败");
      updateButtonText("按住说话");
    }
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
      const frame = new Int16Array(pcmBuffer.splice(0, FRAME_SIZE));
      sendFrame(frame, false);
    }
  }

  function sendRemainingAudioAndEnd() {
    if (sendStatus === 0 && !pcmBuffer.length) {
      sendFrame(new Int16Array(FRAME_SIZE), false);
    }
    while (pcmBuffer.length >= FRAME_SIZE) {
      sendFrame(new Int16Array(pcmBuffer.splice(0, FRAME_SIZE)), false);
    }
    if (pcmBuffer.length > 0) {
      const tail = new Int16Array(FRAME_SIZE);
      tail.set(pcmBuffer.splice(0, pcmBuffer.length));
      sendFrame(tail, false);
    }
    sendFrame(null, true);
    updateStatus("正在整理识别结果...", true);
    clearFinalResultTimer();
    finalResultTimer = setTimeout(() => {
      finishRecognition(partialText ? `识别结果：${partialText}` : "语音识别超时，请再试一次");
    }, FINAL_RESULT_TIMEOUT_MS);
  }

  function extractText(message) {
    const result = message && message.data && message.data.result;
    if (!result || !result.ws) return "";
    return result.ws
      .map((item) => (item.cw && item.cw[0] ? item.cw[0].w : ""))
      .join("");
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
      console.error("XFYUN error:", message);
      failRecognition(message.code === 401 || message.code === 403 ? "语音服务鉴权失败" : "语音识别失败");
      return;
    }

    const text = extractText(message);
    if (text) {
      applyRecognitionText(message, text);
      updateStatus(`识别中：${finalText || partialText}`, true);
    }

    if (message.data && message.data.status === 2) {
      finishRecognition();
    }
  }

  function sendUnityCommand(text) {
    if (!text || !window.unityInstance) return;
    window.unityInstance.SendMessage(TARGET_OBJECT, TARGET_METHOD, text);
  }

  function parseAuthPayload(body) {
    let payload = body && body.result ? body.result : body;
    if (payload && payload.statusCode && payload.statusCode >= 400) {
      const errorBody = typeof payload.body === "string" ? JSON.parse(payload.body) : payload.body;
      throw new Error((errorBody && errorBody.error) || "Failed to get XFYUN auth URL.");
    }
    if (payload && typeof payload.body === "string") payload = JSON.parse(payload.body);
    if (!payload || !payload.appId || !payload.url) {
      throw new Error("Invalid XFYUN auth payload.");
    }
    window.XFYUN_APP_ID = payload.appId;
    return payload.url;
  }

  async function createDirectAuthUrl() {
    if (!DIRECT_XFYUN_APP_ID || !DIRECT_XFYUN_API_KEY || !DIRECT_XFYUN_API_SECRET) {
      throw new Error("Browser signing is enabled but XFYUN direct credentials are missing.");
    }

    if (!window.crypto || !window.crypto.subtle) {
      throw new Error("Current browser does not support WebCrypto HMAC signing.");
    }

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
    const signatureBuffer = await window.crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(signatureOrigin)
    );
    const signature = base64ArrayBuffer(signatureBuffer);
    const authorizationOrigin =
      `api_key="${DIRECT_XFYUN_API_KEY}", algorithm="hmac-sha256", headers="host date request-line", signature="${signature}"`;
    const authorization = btoa(authorizationOrigin);
    window.XFYUN_APP_ID = DIRECT_XFYUN_APP_ID;
    return `wss://${host}${path}?authorization=${encodeURIComponent(authorization)}&date=${encodeURIComponent(date)}&host=${host}`;
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

  async function fetchAuthWithCloudBase() {
    await loadCloudBaseSdk();
    const app = cloudbase.init({
      env: window.CLOUDBASE_ENV_ID,
      region: window.CLOUDBASE_REGION || "ap-shanghai",
    });

    try {
      return parseAuthPayload(await app.callFunction({ name: "xfyunAuth", data: {}, parse: true }));
    } catch (directError) {
      console.warn("CloudBase direct call failed, trying anonymous auth:", directError);
      try {
        const auth = app.auth({ persistence: "local" });
        if (!auth.hasLoginState || !(await auth.hasLoginState())) {
          await auth.anonymousAuthProvider().signIn();
        }
        return parseAuthPayload(await app.callFunction({ name: "xfyunAuth", data: {}, parse: true }));
      } catch (authError) {
        throw new Error(`direct=${formatError(directError)}; auth=${formatError(authError)}`);
      }
    }
  }

  async function fetchAuth() {
    if (USE_DIRECT_XFYUN_AUTH) return createDirectAuthUrl();
    if (!AUTH_ENDPOINT) return fetchAuthWithCloudBase();
    const response = await fetch(AUTH_ENDPOINT, { method: "GET", cache: "no-store" });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || "Failed to get XFYUN auth URL.");
    return parseAuthPayload(body);
  }

  async function startRecognition(event) {
    if (event) event.preventDefault();
    if (state !== "idle") return;

    if (!hasPrimedMicrophone()) {
      await primeMicrophonePermission();
      return;
    }

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
    updateStatus("正在启动麦克风...", true);
    updateButtonText("录音中");

    try {
      try {
        updateStatus("正在打开麦克风...", true);
        await startAudioCapture();
      } catch (error) {
        console.error(error);
        failRecognition(`麦克风启动失败：${formatError(error)}`);
        return;
      }

      state = "recording";
      recordingStartedAt = Date.now();
      updateStatus("正在录音，松开结束", true);

      let authUrl;
      try {
        authUrl = await fetchAuth();
      } catch (error) {
        console.error(error);
        failRecognition(`语音签名失败：${formatError(error)}`);
        return;
      }

      websocket = new WebSocket(authUrl);
      websocket.onmessage = handleResult;
      websocket.onerror = (error) => {
        console.error("XFYUN websocket error:", error);
        failRecognition(`讯飞连接失败：${formatError(error)}`);
      };
      websocket.onclose = () => {
        if (state === "stopping") {
          finishRecognition(partialText ? `识别结果：${partialText}` : "语音连接已结束，请再试一次");
        } else if (state !== "idle") {
          failRecognition("语音连接已关闭");
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
        updateStatus("识别中，请说话...", true);
      };
    } catch (error) {
      console.error(error);
      failRecognition(`语音识别启动失败：${formatError(error)}`);
    }
  }

  async function startAudioCapture() {
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    if (audioContext.state === "suspended") {
      await audioContext.resume();
    }
    source = audioContext.createMediaStreamSource(mediaStream);
    processor = audioContext.createScriptProcessor(4096, 1, 1);
    processor.onaudioprocess = (event) => {
      if (state !== "recording") return;
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

  function stopRecognition(event) {
    if (event) event.preventDefault();
    if (state === "authorizing") return;
    if (state !== "recording" && state !== "starting") return;
    if (state === "recording" && recordingStartedAt > 0) {
      const elapsed = Date.now() - recordingStartedAt;
      if (elapsed < MIN_RECORDING_MS) {
        updateStatus("正在补足录音采样，请稍等...", true);
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
    updateButtonText("处理中");
    if (!websocket || websocket.readyState !== WebSocket.OPEN) {
      updateStatus("录音完成，正在连接语音服务...", true);
      clearFinalResultTimer();
      finalResultTimer = setTimeout(() => {
        failRecognition("语音服务连接超时，请再试一次");
      }, FINAL_RESULT_TIMEOUT_MS);
      return;
    }
    sendRemainingAudioAndEnd();
  }

  function cleanupAudio() {
    if (processor) processor.disconnect();
    if (source) source.disconnect();
    if (mediaStream) mediaStream.getTracks().forEach((track) => track.stop());
    if (audioContext) audioContext.close();
    processor = null;
    source = null;
    mediaStream = null;
    audioContext = null;
  }

  function closeSocket() {
    if (websocket && websocket.readyState === WebSocket.OPEN) websocket.close();
    websocket = null;
  }

  function bindVoiceButton() {
    const button = $("voiceButton");
    if (!button) return;
    updateButtonText("按住说话");
    updateStatus(`语音模块 ${VOICE_VERSION} 已加载，长按说话，松开识别`);
    if ("ontouchstart" in window) {
      button.addEventListener("touchstart", startRecognition, { passive: false });
      button.addEventListener("touchend", stopRecognition, { passive: false });
      button.addEventListener("touchcancel", stopRecognition, { passive: false });
    } else {
      button.addEventListener("mousedown", startRecognition);
      button.addEventListener("mouseup", stopRecognition);
      button.addEventListener("mouseleave", stopRecognition);
    }
    button.addEventListener("contextmenu", (event) => event.preventDefault());
  }

  window.addEventListener("load", bindVoiceButton);
})();
