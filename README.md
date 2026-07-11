# WebAR Test

Unity WebGL + Imagine iTracker WebAR demo, hosted on Tencent CloudBase static hosting.

Current public test path:

```text
https://lafa-d8g0hkbkk586278bc-1302628121.tcloudbaseapp.com/lafa-web-ar/
```

## Included

- Unity WebGL build output in `Build/`
- WebAR runtime files: `index.html`, `arcamera.js`, `itracker.js`, `opencv.js`
- Image target assets in `targets/`
- XFYUN speech recognition bridge in `xfyun-voice.js`
- ComfyUI voice-to-image bridge through `comfySubmit`, `comfyStatus`, and optional `comfyImage`
- Generated-image display config in `comfyui-config.js`
- CloudBase function samples in `cloudfunctions/`
- Build/deploy helper scripts in `scripts/`
- Technical notes in `docs/TECHNICAL_NOTES.md`

## Security

Do not commit XFYUN `APISecret`, `APIKey`, browser-side direct signing credentials, ComfyUI auth headers, or private container tokens.

Use CloudBase function environment variables for production:

- `XFYUN_APP_ID`
- `XFYUN_API_KEY`
- `XFYUN_API_SECRET`
- `COMFY_BASE_URL`
- `COMFY_WORKFLOW_JSON`
- `COMFY_AUTH_HEADER` if needed

## Quick Deploy

From this repository:

```powershell
.\scripts\build-and-deploy-webar.ps1 -SkipUnityBuild
```

Use `-SkipUnityBuild` when Unity has already exported the current WebGL build. See `docs/TECHNICAL_NOTES.md` for full workflow and troubleshooting.
