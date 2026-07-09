# Unity WebGL WebAR Deployment And Voice Control Notes

## Architecture

- Unity exports a WebGL build using the `iTracker 6` WebGL template.
- Tencent CloudBase static hosting serves the WebGL files under `lafa-web-ar/`.
- `xfyun-voice.js` handles microphone capture, XFYUN streaming ASR, command normalization, and `unityInstance.SendMessage`.
- Unity receives recognized text in `VoiceCommandController.OnVoiceCommand(string commandText)`.
- The XFYUN secret must stay in CloudBase function environment variables, not in frontend JavaScript.

## CloudBase Deployment

Deploy the built static folder:

```powershell
tcb hosting deploy .deploy-WebAR_Test lafa-web-ar -e lafa-d8g0hkbkk586278bc
```

Use a version query string after each frontend change:

```text
https://lafa-d8g0hkbkk586278bc-1302628121.tcloudbaseapp.com/lafa-web-ar/?v=voicefix11-button-label
```

Keep `ServiceWorker.js` cache names in sync with script versions. When behavior looks stale in WeChat, bump both:

- `index.html`: `xfyun-voice.js?v=...`
- `ServiceWorker.js`: cache suffix
- `xfyun-voice.js`: `VOICE_VERSION`

Do not upload `Imagine WebAR_BurstDebugInformation_DoNotShip/`.

## XFYUN Auth Function

Cloud function: `xfyunAuth`

Required environment variables:

- `XFYUN_APP_ID`
- `XFYUN_API_KEY`
- `XFYUN_API_SECRET`

The function returns:

```json
{
  "appId": "...",
  "url": "wss://iat-api.xfyun.cn/v2/iat?authorization=..."
}
```

Frontend should call the function or a public HTTP route and then open the returned WebSocket URL.

## Voice Frontend Lessons

- WeChat WebView can fire `touchcancel` very early. A long-press button must protect against too-short recordings.
- `voicefix11-button-label` keeps the button label in a CSS pseudo-element to avoid Android WeChat text-selection hijacking during center long-press.
- A debug string like `帧:6 回:1 音:0.00` means the microphone was opened but no meaningful PCM amplitude reached the encoder.
- Keep the voice panel hidden until `createUnityInstance(...).then(...)` completes, so the button does not appear during Unity loading.
- Browser DOM UI is preferred for microphone permission and WebSocket state. Unity UI can style or mirror state, but WebGL microphone access still goes through browser JavaScript.

## WeChat Image Target Saving

- WeChat WebView does not reliably support direct file downloads from `<a download>`.
- Keep normal browser behavior as a real download.
- In WeChat, show the generated target image in a fullscreen overlay and instruct the user to long-press the image and choose save.
- The WebGL bridge is implemented in `Assets/Imagine/Common/Plugins/DownloadTexture.jslib` before rebuilding, then compiled into `Build/.deploy-WebAR_Test.framework.js.unityweb`.
- Do not route users to an external browser for this flow unless the user explicitly wants a raw file download.

## Touch Model Rotation

- Single-finger horizontal drag rotates the currently visible model around its local vertical axis.
- Preserve authored scene transforms. Apply only incremental runtime rotation; do not reset position, rotation, or scale when switching models.
- Ignore the bottom-center voice button area so swiping and long-press speech do not fight each other.
- Add light inertia after release for a more natural product-view feel.

## Unity Voice Command Controller

The controller should:

- Bootstrap a persistent `VoiceCommandController` object after scene load.
- Receive commands with `OnVoiceCommand(string commandText)`.
- Normalize Chinese text by removing whitespace and punctuation.
- Map only intended model names:
  - `熊` / `显示熊` / `切换熊` -> `bear`
  - `蝴蝶` / `显示蝴蝶` / `切换蝴蝶` -> `bfly_idle`
  - `瓢虫` / `显示瓢虫` / `切换瓢虫` -> `ladybug`
- Avoid controlling color blocks such as `red`, `green`, `blue`, `yellow`.
- Preserve all scene transforms. Only call `SetActive(true/false)` on controlled objects.
- Search recursively with `GetComponentsInChildren<Transform>(true)` so inactive or nested models are found.

## Troubleshooting

- PC works but mobile fails to load wasm: check hosting MIME/compression support and avoid services with small file limits.
- Link downloads `index.html`: the object storage content type/static website hosting is wrong.
- Mobile only works with VPN: use a China-accessible hosting provider such as Tencent CloudBase static hosting.
- Speech auth says `credentials not found`: the frontend CloudBase SDK has no login context or the function route is not publicly reachable.
- XFYUN 401/403: check date signing, app id, API key, API secret, and whether the service is enabled.
- Only one model appears: confirm voice controller searches nested inactive objects and does not reset transforms.

## Release Checklist

1. Build Unity WebGL into `.deploy-WebAR_Test`.
2. Confirm no debug folder is present.
3. Confirm `index.html`, `xfyun-voice.js`, and `ServiceWorker.js` share the new version suffix.
4. Deploy with `tcb hosting deploy`.
5. Open the URL with a fresh `?v=` query.
6. In WeChat, clear cache if necessary, then test camera permission, microphone permission, recognition, and model switching.
