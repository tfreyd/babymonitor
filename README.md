# Baby Monitor (Bibino-style MVP)

Small web app with:

- Baby mode: listens to microphone and detects loud noise.
- Baby mode also streams live audio to parent device.
- Parent mode: receives live alerts and browser notifications.
- Works on phone and desktop in a browser.

## Run

```bash
npm install
npm start
```

App runs on `http://localhost:3000` by default.

To allow other devices on your Wi-Fi:

```bash
HOST=0.0.0.0 PORT=3000 npm start
```

Then open `http://YOUR_LOCAL_IP:3000` from phone/computer.

## Usage

1. Open the app on two devices.
2. Set the same monitor code on both.
3. Set the same access key (minimum 6 chars) on both.
4. On baby device:
   - click `Use as Baby Device`
   - click `Start Monitoring`
5. On parent device:
   - click `Use as Parent Device`
   - click `Enable Notifications`
6. Parent can listen to live audio in the `Live Audio` section.
7. When noise is detected, parent sees real-time alerts and browser notifications.

## Notes

- Microphone requires user permission.
- Baby microphone is not shared until `Start Monitoring` is clicked.
- Push notifications need service worker support and HTTPS in most browsers (localhost usually works without HTTPS during local development).
- Current subscription storage is in memory, so restarting server clears subscriptions.

## Deploy on Render

This repo includes `/Users/thibaud/Documents/GitHub/babymonitor/render.yaml` for Render Blueprint deploy.

1. Push this repository to GitHub.
2. In Render, choose `New` -> `Blueprint` and connect your repo.
3. Render reads `render.yaml` and creates a web service.
4. After deploy, open `https://YOUR_RENDER_URL`.

Recommended environment variables (Render dashboard -> service -> Environment):

- `VAPID_SUBJECT` (example: `mailto:you@example.com`)
- `PUBLIC_VAPID_KEY`
- `PRIVATE_VAPID_KEY`

Generate VAPID keys with:

```bash
npx web-push generate-vapid-keys
```
