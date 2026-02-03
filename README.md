# Passepartout

A digital valet that knows how to open doors.
Built as a demo app for [Latchkey](https://github.com/imbue-ai/latchkey).

[Passepartout-demo.webm](https://github.com/user-attachments/assets/ed972b55-44bb-40bf-a3d2-5c32100c6506)

You can find prebuilt apps in [Releases](https://github.com/imbue-ai/passepartout/releases).

Why this demo app may be interesting to you:

- Passepartout bundles an agentic environment and requires no configuration.
  Using similar packaging techniques, you can build apps for *non-technical* users and enable them to use AI agents that can make requests to third-party services on their behalf.

- Thanks to Latchkey, Passepartout doesn't require an intermediary when making requests to third-party services;
  it makes HTTP requests directly to the API endpoints of such services.

> [!WARNING]
> Passepartout runs opencode with all permissions set to "allow" (aka "YOLO mode").

## External dependencies

This project requires two external executables.
You can put them either in your system `$PATH` or in the `native_tools` directory in the repo.

- OpenCode: download the binary from their [releases](https://github.com/anomalyco/opencode/releases) page.
- Latchkey: clone the repo and build with `npm run bun-compile`.

(This will be automated in future.)

## Development

Install dependencies:

```bash
npm install
```

Run the development server:

```bash
npm run tauri dev
```

## Build

Build for production:

```bash
npm run tauri build
```

## License

MIT
