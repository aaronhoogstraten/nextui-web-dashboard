# NextUI Web Dashboard

A browser-based management tool for [NextUI](https://github.com/LoveRetro/NextUI) devices. Connects directly to your device over USB using WebUSB and ADB -- no drivers or desktop software required.

Requires a Chromium-based browser (Chrome, Edge, etc.).

## Features

- **ROM Management** -- Browse ROMs per system, upload individually or sync from a local folder, manage box art and display names. Validates emulator availability per system. Custom system folders detected automatically.
- **BIOS Management** -- View required BIOS files per system, check presence and integrity via SHA-1, upload missing files. Supports custom systems.
- **Overlay Management** -- Preview, upload, and remove screen overlays. Browse and install community overlays from the [nextui-community-overlays](https://github.com/LoveRetro/nextui-community-overlays) repository.
- **Cheats Management** -- Upload, download, and manage cheat files per system with ROM matching validation.
- **Collections** -- Edit collection files: add/remove/reorder ROMs with a visual picker and path validation.
- **Screenshots** -- Browse and download screenshots from the device.
- **File Browser** -- Navigate the device filesystem, upload/download files, search recursively, preview images, and edit text-based config files.
- **Download Logs** -- Collect all log files from the device and download as a zip archive.
- **Platform Detection** -- Automatically detects the connected device platform (e.g. tg5040) for targeted emulator validation.
- **Light/Dark Theme** -- Toggle between dark and light modes.

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
