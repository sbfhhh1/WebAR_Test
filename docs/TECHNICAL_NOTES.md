# Unity WebGL WebAR Technical Notes

## Architecture

- Unity exports WebGL with the `iTracker 6` WebGL template.
- Tencent CloudBase static hosting serves the app under `lafa-web-ar/`.
- `xfyun-voice.js` owns microphone capture, XFYUN WebSocket recognition, command routing, and browser-to-Unity calls.
- CloudBase functions keep private credentials out of frontend code.
- ComfyUI is called through CloudBase first, with optional direct HTTPS fallback for public test containers.
- Unity displays generated images through `GeneratedImageDisplayController.OnGeneratedImageUrl(string imageUrl)`.

## Deployment

Deploy static files:

```powershell
tcb hosting deploy . lafa-web-ar --env-id lafa-d8g0hkbkk586278bc
```

Recommended helper:

```powershell
.\scripts\build-and-deploy-webar.ps1 -SkipUnityBuild
```

After every frontend change, bump the version in:

- `index.html`
- `xfyun-voice.js`
- `ServiceWorker.js`

Then test with a fresh query string:

```text
https://lafa-d8g0hkbkk586278bc-1302628121.tcloudbaseapp.com/lafa-web-ar/?v=<version>
```

## Loading Screen

The loading screen is part of `index.html` and the Unity WebGL template. It uses `Assets/UI/main.png` as a full-screen background and a circular spinner with a fixed center percentage.

Rules:

- Start the loading animation before `initialize()` so iTracker/OpenCV initialization does not create a blank wait.
- Do not put the percentage inside the rotating spinner element; keep it as a fixed sibling layer.
- Avoid horizontal progress bars on mobile if alignment is sensitive.
- Keep the loading screen outside `#unity-container` so Unity canvas sizing cannot shrink it.
- Do not change camera or Unity canvas layout when editing the loading UI.

## XFYUN Speech Recognition

Use CloudBase function `xfyunAuth`.

Required environment variables:

- `XFYUN_APP_ID`
- `XFYUN_API_KEY`
- `XFYUN_API_SECRET`

Frontend rules:

- Keep browser-side direct signing disabled in committed code.
- Use Web Audio API to capture 16 kHz, 16-bit, mono PCM.
- Send 40 ms frames to XFYUN.
- In WeChat WebView, use touch events with `preventDefault()` and `stopPropagation()`.
- Add a minimum recording duration to avoid early `touchcancel`.
- Keep the voice button visible only after Unity is loaded.
- Request microphone through browser JavaScript; Unity UI can style the control but cannot replace WebGL microphone access.

## ComfyUI Voice-To-Image

Speech beginning with `生成` enters the ComfyUI path. Other speech can be ignored or routed to model switching depending on the current test mode.

CloudBase functions:

- `comfySubmit`: inserts the prompt into the workflow and calls ComfyUI `/prompt`.
- `comfyStatus`: polls `/history/{promptId}` and returns `{ status, imageUrl }`.
- `comfyImage`: optional proxy for ComfyUI `/view`.

Important environment variables:

- `COMFY_BASE_URL`
- `COMFY_WORKFLOW_JSON`
- `COMFY_PROMPT_NODE_ID`
- `COMFY_OUTPUT_NODE_ID`
- `COMFY_AUTH_HEADER`, optional
- `COMFY_INLINE_IMAGE=1`, optional data URL return mode

Workflow guidance:

- Prefer a local workflow JSON asset during development, then sync it to CloudBase environment variables.
- If Chinese prompts must be precise, keep translation inside the ComfyUI workflow or use a dedicated prompt-normalization service before CLIP text encoding.
- Use a negative prompt that explicitly excludes `human`, `portrait`, `bust`, `statue`, `sculpture`, and `face` when testing object generation.

## Unity Display Rules

- Reuse an authored `Quad` or `GeneratedImagePlane` when present.
- Preserve authored transform values. Do not reset position, rotation, or scale.
- Apply generated images with an independent material instance.
- Support normal URLs and `data:image/...;base64,...`.
- If no image target is tracked, cache the latest generated image and apply it when tracking resumes.

## Mobile WeChat Lessons

- A native permission dialog cannot be skipped; avoid showing separate app permission prompts before the browser prompt.
- If the microphone prompt appears every time, check whether audio tracks are being stopped too early.
- If the voice button long-press selects text, keep visible button text out of the button body and disable selection/callout.
- If camera view becomes tiny or white, inspect malformed overlay DOM and fullscreen canvas CSS first.
- If behavior looks stale, bump cache versions and use a new `?v=` query.

## Pre-Commit Checklist

1. Run `node --check xfyun-voice.js`.
2. Search for secrets:

```powershell
rg "XFYUN_DIRECT|API_SECRET|APISecret|COMFY_AUTH_HEADER|Authorization: Bearer|<known-secret-fragment>"
```

3. Verify `index.html`, `xfyun-voice.js`, and `ServiceWorker.js` use the same frontend version.
4. Confirm generated UI changes are also copied to the Unity WebGL template before rebuilding.
5. Test CloudBase functions with the current ComfyUI URL.
6. Deploy and verify remote files with `Cache-Control: no-cache`.
