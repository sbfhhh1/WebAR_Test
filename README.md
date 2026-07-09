# WebAR Test

Unity WebGL + Imagine iTracker WebAR demo deployed as static files.

Current public test path:

`https://lafa-d8g0hkbkk586278bc-1302628121.tcloudbaseapp.com/lafa-web-ar/`

## What Is Included

- Unity WebGL build output in `Build/`
- WebAR template files: `index.html`, `arcamera.js`, `itracker.js`, `opencv.js`
- Image targets in `targets/`
- Speech recognition frontend bridge in `xfyun-voice.js`
- CloudBase function sample for XFYUN WebSocket auth in `cloudfunctions/xfyunAuth/`
- Technical notes in `docs/TECHNICAL_NOTES.md`

## Security Note

Do not commit XFYUN `APISecret` or browser-side direct signing credentials. Use the CloudBase `xfyunAuth` function and configure secrets as cloud function environment variables.
