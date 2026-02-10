# NextUI Web Dashboard

A browser-based management tool for [NextUI](https://github.com/LoveRetro/NextUI) devices. Connects directly to your device over USB using WebUSB and ADB -- no drivers or desktop software required.

Requires a Chromium-based browser (Chrome, Edge, etc.).

## Features

- **BIOS Management** -- View required BIOS files per system, check presence and integrity via SHA-256, upload missing files. Supports dynamically discovered custom systems.
- **ROM Management** -- Browse ROMs per system, upload new ROMs with format validation, view file counts. Custom system folders are detected automatically.
- **Overlay Management** -- Preview, upload, and remove screen overlays. Browse and install community overlays from the [nextui-community-overlays](https://github.com/LoveRetro/nextui-community-overlays) repository.
- **File Browser** -- Navigate the device filesystem, upload and download files, and edit text-based config files directly on the device.
- **Download Logs** -- Collect all log files from the device and download them as a zip archive.
- **Device Verification** -- Validates that the connected device is running NextUI (not a different MinUI fork) before allowing access.

## Development

```sh
npm install
npm run dev
```

## Tech Stack

- SvelteKit / Svelte 5
- Tailwind CSS v4
- ya-webadb (WebUSB ADB implementation)
- JSZip
