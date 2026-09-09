# Third-party notices

Downshift's original code is licensed under the [MIT License](LICENSE).
The runtime also redistributes or links the following pinned upstream projects.
Their licenses apply to their respective code and binaries.

| Component | Pinned identity | License | Local license copy |
|---|---|---|---|
| Pi packages (`@earendil-works/pi-ai`, `pi-coding-agent`, and `pi-server`) | `v0.85.0`, revision `107d79f11072bbc8a3a757ed7fd69596bee7d68c` | MIT, Copyright (c) 2025 Mario Zechner | [Pi MIT](licenses/PI-MIT.txt) |
| NVIDIA NeMo Switchyard (`switchyard-libsy`, `switchyard-protocol`) | compatibility fork revision `2dd67d76ad12961f92359153e03686773e3e8761`, based on NVIDIA revision `9a743e89223a0d5b14011f1226d5b068f730a3b8` | Apache-2.0, Copyright (c) 2024-2026 NVIDIA CORPORATION & AFFILIATES | [Switchyard Apache-2.0](licenses/SWITCHYARD-APACHE-2.0.txt) and [NOTICE](licenses/SWITCHYARD-NOTICE.txt) |

The immutable dependency graph is recorded in `pnpm-lock.yaml`,
`rust/switchyard-bridge/Cargo.lock`, and `config/upstream-lock.json`. Other
transitive dependencies retain their upstream license terms. This notice does
not change any upstream license.
