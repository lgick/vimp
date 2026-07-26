# VIMP

A P2P multiplayer 2D real-time engine: games run authoritatively in a Web
Worker in the room creator's browser tab, clients connect over WebRTC. Game
rules themselves are not part of this repo — they live in separately
published, dynamically loaded game plugins.

![game video](./.github/assets/video/game.gif?raw=true)

- **P2P**: the authoritative host is a Web Worker in the room creator's browser tab (a Rust simulation core compiled to WASM: Rapier 2D physics at ~120 Hz, bots, binary snapshots at 30 packets/sec); clients connect over WebRTC.
- **Master server**: Node.js + Express + `ws` — lobby, WebRTC signaling, map catalog.
- **Accounts**: OAuth login and a global nick via a central auth service, JWT identity verified by the host, per-game rank/state synced across any master domain.
- **Client**: PixiJS, snapshot interpolation, client-side prediction, procedural textures, spatial audio (Howler).
- **Gameplay**: game rules (teams, weapons, bots, votes, chat, statistics, etc.) live in a separately published, dynamically loaded game plugin — see [vimp-tanks](https://github.com/lgick/vimp-tanks) for the reference tank-battle game.

## Quick start

```bash
git clone https://github.com/lgick/vimp.git
cd vimp
npm install
npm link @vimp/tanks   # or another game plugin — see its own setup docs
npm run dev
```

Development requires local HTTPS certificates (mkcert) and, only if you're
changing this repo's own Rust crate, the Rust toolchain — see
[docs/en/getting-started.md](docs/en/getting-started.md). Playing a match
needs a game plugin package installed/linked (this repo no longer ships
one) — see [docs/en/extending.md](https://github.com/lgick/vimp-tanks/blob/main/docs/en/extending.md)
in that plugin's own repository.

## Documentation

Full documentation lives in [docs/en/](docs/en/README.md):

- [Local setup](docs/en/getting-started.md)
- [Architecture](docs/en/architecture.md)
- [Master server](docs/en/master.md) · [Central auth service](docs/en/auth.md) · [Browser host](docs/en/host.md) · [Rust core](docs/en/core.md)
- [Client modules](docs/en/client.md)
- [Network protocol](docs/en/network.md)
- [Configuration](docs/en/configuration.md)
- [Plugin API (engine ↔ game contract)](docs/en/plugin-api.md)
- [Deployment](docs/en/deployment.md)

Game rules and content-authoring docs (gameplay, extending) live in the
active game plugin's own repository, e.g.
[vimp-tanks/docs/en/](https://github.com/lgick/vimp-tanks/blob/main/docs/en/README.md).

[Русская версия](docs/ru/README.md)

## Interface

![interface](./.github/assets/images/face.png?raw=true)

## ❤️ Supporting the Project

If you find this project useful and want to support its development, starring the project on GitHub
is a great way to show your appreciation!

Donations are also welcome via Bitcoin. Every contribution helps sustain the project and is greatly
appreciated.

| Currency | Address                                      | QR Code                                                                                                                                            |
| :------- | :------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------- |
| **BTC**  | `bc1q0fnakv2jean57p3rjqzhq826jklygpj6gc7evu` | <img src="https://api.qrserver.com/v1/create-qr-code/?size=120x120&data=bc1q0fnakv2jean57p3rjqzhq826jklygpj6gc7evu" alt="BTC QR Code" width="120"> |
