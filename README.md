# Passepartout

Your digital valet that knows how to open doors.

Built as a demo app for [Latchkey](https://github.com/imbue-ai/latchkey).

[Passepartout-simple-demo.webm](https://github.com/user-attachments/assets/85f30779-ab91-4da4-8095-e64232566549)


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
