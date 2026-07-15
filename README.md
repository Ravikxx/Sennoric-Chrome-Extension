# Axion Chrome Extension

Axion is an AI browser assistant that runs in Chrome's side panel. It can read
the current page, answer questions about it, and—with explicit approval—click,
type, select options, navigate, or send a screenshot to the configured model.

## Install from source

1. Clone or download this repository.
2. Open `chrome://extensions` in Chrome.
3. Enable **Developer mode**.
4. Click **Load unpacked** and select this repository's root folder.
5. Click the Axion toolbar icon or press `Alt+Shift+A`.

No build step is required. Chrome loads `manifest.json` directly from the
repository root.

## Configure models

Open the extension settings and add a supported provider key or custom
OpenAI-compatible endpoint. Secrets are stored in extension-owned Chrome
storage and are hidden from content-script contexts.

The extension can import API keys, custom endpoints, and the active model from
the Axion CLI without copying them individually:

1. Run `/web` in Axion CLI.
2. Copy the short-lived extension import token printed by the CLI.
3. Paste the loopback URL and token into the extension settings.

The import flow accepts loopback addresses only, requires an exact session
token, omits credentials, and disables caching.

## Permissions

The extension requests broad page access because its browser tools must work
on the page the user chooses. Read-only tools can run directly. Mutating or
sensitive tools require approval before execution.

## Test

Requires Node.js 18 or newer:

```bash
npm test
npm run check
```

## License

Apache-2.0
