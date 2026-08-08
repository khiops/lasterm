# Changelog

## [0.9.0](https://github.com/khiops/lasterm/compare/v0.8.0...v0.9.0) (2026-08-08)


### Features

* **desktop:** bring the running window back instead of starting a second process ([7042569](https://github.com/khiops/lasterm/commit/7042569a24b8b728fd798a0fd8a5d4be9a38cac0)), closes [#197](https://github.com/khiops/lasterm/issues/197)


### Bug Fixes

* **agent:** drop the lock assertion that covered a path production never takes ([aeaf4a6](https://github.com/khiops/lasterm/commit/aeaf4a66359ca02b8466b3b1bb397822d4fba926)), closes [#139](https://github.com/khiops/lasterm/issues/139)
* **desktop:** talk only to the hub we launched, at the address it bound ([c26dfc8](https://github.com/khiops/lasterm/commit/c26dfc8748a6a0b8014bace0f1c8dd757a7de6da)), closes [#171](https://github.com/khiops/lasterm/issues/171) [#170](https://github.com/khiops/lasterm/issues/170) [#175](https://github.com/khiops/lasterm/issues/175)

## [0.8.0](https://github.com/khiops/lasterm/compare/v0.7.0...v0.8.0) (2026-08-07)


### ⚠ BREAKING CHANGES

* the executables, CLI command, environment variables, HTTP headers, application identifier, package scope and the config and state directories are all renamed. An existing installation is detected and refused rather than silently presented as empty.

### Bug Fixes

* **root:** take the published fixes for four advisories, on the supported majors ([f384aa7](https://github.com/khiops/lasterm/commit/f384aa7ec766c489a54030d823d6f6c3cc222176))


### Refactoring

* rename termora to lasterm, and refuse to start beside the old install ([117d9dc](https://github.com/khiops/lasterm/commit/117d9dcb43d25364c6c56db7c347a2c44a3afd0e)), closes [#166](https://github.com/khiops/lasterm/issues/166) [#167](https://github.com/khiops/lasterm/issues/167) [#158](https://github.com/khiops/lasterm/issues/158)


### Documentation

* say which hub a client drives, and what local means ([2eecbd5](https://github.com/khiops/lasterm/commit/2eecbd51818c7e6673e2dab3750cc9b17b0a6e76))
* say why quitting kills process trees when an API already exists ([debcfe1](https://github.com/khiops/lasterm/commit/debcfe1d9af9b4a29dcf67db3840e227a5a0c4a3))
* trim the process-tree rationale back under the line budget ([4eb4c21](https://github.com/khiops/lasterm/commit/4eb4c21f6d607be0812d5333f4d042e1c28d80df))


### CI/CD

* run the built hub before publishing it, and check what it printed ([#159](https://github.com/khiops/lasterm/issues/159)) ([29e9f53](https://github.com/khiops/lasterm/commit/29e9f53fb8df801fe6a5b8db0cf906f2f0101e88)), closes [#144](https://github.com/khiops/lasterm/issues/144)

## [0.7.0](https://github.com/khiops/lasterm/compare/v0.6.0...v0.7.0) (2026-08-04)


### Features

* **agent:** end a terminal's whole workload, not just its shell ([#115](https://github.com/khiops/lasterm/issues/115)) ([78351a2](https://github.com/khiops/lasterm/commit/78351a2306c73d2f81804fee2dba249a51378eb5))
* **agent:** publish who the daemon is, and let it be asked to stop ([#123](https://github.com/khiops/lasterm/issues/123)) ([9833e11](https://github.com/khiops/lasterm/commit/9833e1105dba3e4160c251bdfd39d50a6dadfa47))
* **agent:** tear down terminals when the daemon is asked to stop ([#118](https://github.com/khiops/lasterm/issues/118)) ([023c3a3](https://github.com/khiops/lasterm/commit/023c3a300cfd562432b13fa2ccf12c25a5898320))
* **desktop:** keep the updater out of Store builds, record its public key ([#112](https://github.com/khiops/lasterm/issues/112)) ([3626f92](https://github.com/khiops/lasterm/commit/3626f92d3591ab81afe96059ba74955f5cddd1fd))
* **desktop:** the close preference moves where the gestures arrive ([#137](https://github.com/khiops/lasterm/issues/137)) ([36cb07f](https://github.com/khiops/lasterm/commit/36cb07fbb9b4add08072fa2b651ad063e7180c16))
* **desktop:** the gestures quit, and one place decides it ([#138](https://github.com/khiops/lasterm/issues/138)) ([fdb8fc6](https://github.com/khiops/lasterm/commit/fdb8fc67d943099f55abcdb022842d633d4febfa))
* **hub:** let the hub quit — stop reviving, stop the agent, stop itself ([#126](https://github.com/khiops/lasterm/issues/126)) ([11a7055](https://github.com/khiops/lasterm/commit/11a70551cf3530e00fc0d25d529312d41cd87566))
* **hub:** make a second hub impossible, with a lock the kernel releases ([#133](https://github.com/khiops/lasterm/issues/133)) ([014e3f2](https://github.com/khiops/lasterm/commit/014e3f22d06d9dad39dd24de34ba713f396e8d16))
* **hub:** quit ends everyone's terminals, so it asks first ([#135](https://github.com/khiops/lasterm/issues/135)) ([0dc17e0](https://github.com/khiops/lasterm/commit/0dc17e0f2248062a7f02c990f76a703fd65e0d77))


### Documentation

* ask a local agent to stop with the OS, not with a protocol message ([40d2b59](https://github.com/khiops/lasterm/commit/40d2b59cdcc58d34063a344856266a1091a8816e))
* mark the quit lifecycle plan as canonical ([7af2b75](https://github.com/khiops/lasterm/commit/7af2b75011562cd9f63ca4747bb8a20ab0c455ea))
* narrow the update flow's Unix teardown promise to the process group ([5eefa5c](https://github.com/khiops/lasterm/commit/5eefa5cf9d54de0622f453d06920aae4c3077cae))
* **plans:** stop promising that logging out quits lasterm ([9407c2c](https://github.com/khiops/lasterm/commit/9407c2c88a03589b00aba2f2546ae09de4029637))
* put the no-relaunch latch in the hub and give it all three paths ([53f51bb](https://github.com/khiops/lasterm/commit/53f51bbf15948b598e2da125e4e4a217d2fc0bf8))
* spec the in-app update flow ([2b16a8c](https://github.com/khiops/lasterm/commit/2b16a8c03df6cb3d4118b082e816fb53e5ee27c6))


### CI/CD

* run the Rust tests on Windows, and make them pass there ([#120](https://github.com/khiops/lasterm/issues/120)) ([1eaf1c9](https://github.com/khiops/lasterm/commit/1eaf1c931ed05424064733798cb41a7d2b3bff81))

## [0.6.0](https://github.com/khiops/lasterm/compare/v0.5.0...v0.6.0) (2026-07-31)


### Features

* **desktop:** clean shutdown / quit lifecycle ([#94](https://github.com/khiops/lasterm/issues/94)) ([#104](https://github.com/khiops/lasterm/issues/104)) ([3ab91f5](https://github.com/khiops/lasterm/commit/3ab91f5d10ebcd25d1fd411f48a5a62fcd9bae51))
* **desktop:** Microsoft Store MSIX packaging in CI (MakeAppx) ([#106](https://github.com/khiops/lasterm/issues/106)) ([d98332b](https://github.com/khiops/lasterm/commit/d98332b69d471a081c779138161455bb80872493))


### CI/CD

* pass the desktop deny.toml as a global cargo-deny option ([#109](https://github.com/khiops/lasterm/issues/109)) ([2753165](https://github.com/khiops/lasterm/commit/2753165516f9a9b7798d5688692100ad92ad5a26))

## [0.5.0](https://github.com/khiops/lasterm/compare/v0.4.0...v0.5.0) (2026-06-18)


### Features

* GUI agent manager (list / fetch / prune / import) ([#97](https://github.com/khiops/lasterm/issues/97)) ([86e6e50](https://github.com/khiops/lasterm/commit/86e6e502cef942720a4664ba843281637108a87f))


### Bug Fixes

* **desktop:** window transparency on Windows ([#102](https://github.com/khiops/lasterm/issues/102)) ([fb533ab](https://github.com/khiops/lasterm/commit/fb533ab7b86f708dda907ef4b78d84d4cc031f77))
* signal a successful agent re-deploy as an AGENT_SYNCED info event, not an error ([#99](https://github.com/khiops/lasterm/issues/99)) ([#103](https://github.com/khiops/lasterm/issues/103)) ([2828cdf](https://github.com/khiops/lasterm/commit/2828cdfadfea9efcb05c042e82353f08413b97d0))


### Documentation

* document the agent binary distribution model (bundle local, fetch remote) ([#91](https://github.com/khiops/lasterm/issues/91)) ([2339df6](https://github.com/khiops/lasterm/commit/2339df69b46f62d9cccea6e8ce21b4af6ac3823c))

## [0.4.0](https://github.com/khiops/lasterm/compare/v0.3.4...v0.4.0) (2026-06-16)


### Features

* **hub:** populate agent cache from GitHub Releases + version-aware deploys ([#77](https://github.com/khiops/lasterm/issues/77)) ([#89](https://github.com/khiops/lasterm/issues/89)) ([46b3998](https://github.com/khiops/lasterm/commit/46b39981642e387acc51d0f705805083af00e5f2))


### Refactoring

* **agent:** consume async-xpty from its own repo ([#87](https://github.com/khiops/lasterm/issues/87)) ([#88](https://github.com/khiops/lasterm/issues/88)) ([a2d0ee6](https://github.com/khiops/lasterm/commit/a2d0ee6f92b08ed2ee12d4b51447698eab79e4cf))


### CI/CD

* **release:** bump minor for feat in pre-1.0 (drop bump-patch-for-minor-pre-major) ([#90](https://github.com/khiops/lasterm/issues/90)) ([cc7c221](https://github.com/khiops/lasterm/commit/cc7c2218b00c8e7102f53445fb38ff43a51c189f))
* **release:** plain version tags and windows-only hub/desktop builds ([#75](https://github.com/khiops/lasterm/issues/75)) ([d8314a7](https://github.com/khiops/lasterm/commit/d8314a7906e9d141162d0810b3dab97daa97770f))

## [0.3.4](https://github.com/khiops/lasterm/compare/termora-v0.3.3...termora-v0.3.4) (2026-06-11)


### Bug Fixes

* **root:** sync lockfile specifier for @tauri-apps/plugin-shell floor ([ad56bbe](https://github.com/khiops/lasterm/commit/ad56bbe7331c419e73a2831ceffdca2ad86c231e))

## [0.3.3](https://github.com/khiops/lasterm/compare/termora-v0.3.2...termora-v0.3.3) (2026-06-11)


### Features

* **agent,scripts:** Agent SEA binary packaging pipeline (Blocks 1-3) ([a0c66ab](https://github.com/khiops/lasterm/commit/a0c66ab0d719efbeab94e29efbccdfe196c7191b))
* **agent:** add daemon mode with UDS socket server and output buffer ([9a2355f](https://github.com/khiops/lasterm/commit/9a2355f022e5baccc09f9bb53c5e3a8f5a1f01be))
* **agent:** implement Block 1.2 — Agent Core PTY manager and protocol handler ([26a48a1](https://github.com/khiops/lasterm/commit/26a48a176d7a5b78812406d62d15bdc8782df2f4))
* **agent:** implement Block 3.1 — xterm.js headless terminal + SNAPSHOT handler ([5cd87b1](https://github.com/khiops/lasterm/commit/5cd87b1ec713ab079d11df973c57efb4fe4a883a))
* **agent:** Rust agent rewrite — async-xpty crate + nexterm-agent binary ([957fdfc](https://github.com/khiops/lasterm/commit/957fdfc5794d7011e9274e3728796fa9928717f0))
* **agent:** standalone agent daemon with UDS/named pipe transport ([cd6e146](https://github.com/khiops/lasterm/commit/cd6e146c4874dc7b5add9c3d85184cf6dff6d016))
* **all:** build versioning — /api/health version field + About modal ([c49eb3b](https://github.com/khiops/lasterm/commit/c49eb3b0e8f746656aedddddfd0d31b5a597130e))
* build matrix refactoring — unified scripts, Rust agent, dead code cleanup ([b0d30f2](https://github.com/khiops/lasterm/commit/b0d30f2811cc57ba6812710841d42e9876dd42ca))
* build versioning, optional shell/cwd, default profile, last-profile guard ([2e0bed5](https://github.com/khiops/lasterm/commit/2e0bed532974655945dd851416c62784fcd2485f))
* **build:** cross-build SEA for Windows from Linux ([c0f18fe](https://github.com/khiops/lasterm/commit/c0f18fe6b464a71fcef67ef35302f66dcce83fd0))
* **ci:** rewrite build pipeline — matrix-driven, script-based, Rust agent ([d9c557c](https://github.com/khiops/lasterm/commit/d9c557c00c99154efdd7a81027b7a3572de6a088))
* **desktop,web:** window translucency + background modes ([#58](https://github.com/khiops/lasterm/issues/58)) ([#59](https://github.com/khiops/lasterm/issues/59)) ([19d1d32](https://github.com/khiops/lasterm/commit/19d1d32f89437bf4d9e8d4312fe44fe215862278))
* **desktop:** custom NSIS installer with component selection + skip SEA tests locally ([fc5ff7f](https://github.com/khiops/lasterm/commit/fc5ff7f3fafe19a614d1b580a10038a8b619c23c))
* **desktop:** dynamic hub port — detect existing hub via runtime.json, skip spawn if alive ([dfb15c2](https://github.com/khiops/lasterm/commit/dfb15c238238488bbf3e286e20da041180a9ee61))
* **desktop:** probe default port 4100 before sidecar spawn ([d4a05e1](https://github.com/khiops/lasterm/commit/d4a05e185918ce515dcb3c428cadb38b52d980e7))
* **desktop:** Tauri v2 desktop app with custom titlebar, auto-auth, hybrid dev/build mode ([6cdb63a](https://github.com/khiops/lasterm/commit/6cdb63a5194f3acdb807b6a04f36c8c8d126236e))
* font picker + per-terminal profiles + bell unification ([17c590b](https://github.com/khiops/lasterm/commit/17c590b93a324c91a495a990312712278306cbdf))
* **hub,scripts:** complete packaging pipeline — Hub SEA, agent deploy, CI release workflow ([22e53c2](https://github.com/khiops/lasterm/commit/22e53c2f0267375f779e578d71610053b50c220a))
* **hub,shared,agent,web:** UX-02 Terminal Title — OSC 0/2 dynamic titles ([0a3d4a0](https://github.com/khiops/lasterm/commit/0a3d4a02ea3de6b523e95a987898aa5a9e7451da))
* **hub,web,shared,agent:** UX-01 tab actions, split panes, welcome tab ([779ecab](https://github.com/khiops/lasterm/commit/779ecab0222ead403859a3af5b877ba77d832137))
* **hub,web,shared:** SC-23 host groups as first-class DB entities ([47b03c9](https://github.com/khiops/lasterm/commit/47b03c949279369a7e40e4ab05054c17752fddc8))
* **hub,web,shared:** SC-23 host groups as first-class DB entities ([a80c245](https://github.com/khiops/lasterm/commit/a80c24578495942461d6e01a5ee00f8f4437a3f4))
* **hub+agent:** unified per-channel logging + Windows daemon mode ([78ea1b9](https://github.com/khiops/lasterm/commit/78ea1b9c2987b80093926ba2ecd4bc8977b847ac))
* **hub:** add agent launcher for daemon auto-start and reconnect ([ca0ff11](https://github.com/khiops/lasterm/commit/ca0ff11b500d347461ce79d02dc222d7790aaa2b))
* **hub:** add daemon integration tests and session-manager daemon path ([688d0e7](https://github.com/khiops/lasterm/commit/688d0e727ae7e75ab2865e2f479c4af86aabcaa0))
* **hub:** add NextermAgent class for daemon socket connections ([b7198e5](https://github.com/khiops/lasterm/commit/b7198e55899ecc55f3de3398571af474cd527201))
* **hub:** add waitForChannelState() for daemon reconnect reconciliation ([af7c8c1](https://github.com/khiops/lasterm/commit/af7c8c1e11e0fa93a0de535ab46f045247ed8a7f))
* **hub:** auto-detect shells on first startup + Windows Terminal import + /etc/shells parsing ([8bb4fcf](https://github.com/khiops/lasterm/commit/8bb4fcfb80139a5bcb2adc9d4aeecb357d2b45c1))
* **hub:** DELETE /api/fonts/:family — delete font by family name ([e94805b](https://github.com/khiops/lasterm/commit/e94805b267052e72da1f749e24544ea20baa7e35))
* **hub:** implement Block 0.3 — SQLite storage layer ([414ad08](https://github.com/khiops/lasterm/commit/414ad08652f6ea1daea2c189a65928815ba7a935))
* **hub:** implement Block 1.5 — WebSocket transport ([ee2a222](https://github.com/khiops/lasterm/commit/ee2a2228478f0a62e98b750d9a98d9b919560a8d))
* **hub:** implement Block 2.1 — SSH connector via ssh2 ([b2d2a99](https://github.com/khiops/lasterm/commit/b2d2a998201cbc74cc53188c4ff9a6974e97ed38))
* **hub:** implement Block 2.2 — session state machine + DB persistence ([190423d](https://github.com/khiops/lasterm/commit/190423d9c23070b48bc2d03a348986a7296ddf2b))
* **hub:** implement Block 2.3 — REST API for hosts, sessions, channels ([1346457](https://github.com/khiops/lasterm/commit/13464571df2563e62534c3921852ab46410bda28))
* **hub:** implement Block 3.2 — snapshot scheduler ([87f21eb](https://github.com/khiops/lasterm/commit/87f21eb636fd794828c47312c95cec70bd32a03e))
* **hub:** implement Block 4.1 — Token Auth ([247a24b](https://github.com/khiops/lasterm/commit/247a24bd439fc274dc083b1161437970f6079e50))
* **hub:** implement M3 — Session Persistence ([901890c](https://github.com/khiops/lasterm/commit/901890cfef0431843677c738eea950d9799037fa))
* **hub:** implement M4 — Multi-Client auth, pairing, write-lock ([c03824a](https://github.com/khiops/lasterm/commit/c03824afba70164a437bc944946396f1c3d11b16))
* **hub:** per-host launch profiles from remote agent HELLO shells + SSH fallback ([c34f3c6](https://github.com/khiops/lasterm/commit/c34f3c620ad03d8aa8d751a1f96a266616168734))
* **hub:** POST /api/fonts — font upload with MIME validation ([5eb75c5](https://github.com/khiops/lasterm/commit/5eb75c59c1d5eca9e2fe92b707675b61a98de099))
* **hub:** SSH key browse API — list, upload, delete keys in ~/.ssh ([b4cde96](https://github.com/khiops/lasterm/commit/b4cde96646738c5854d1e682de4ea1c0bc8c7c13))
* **hub:** zero_conf port retry on EADDRINUSE ([3411698](https://github.com/khiops/lasterm/commit/341169827361d8a94e3f1b0fad47089cdb3c31bc))
* launch profiles — named terminal configurations with elevation ([#10](https://github.com/khiops/lasterm/issues/10)) ([e346eb4](https://github.com/khiops/lasterm/commit/e346eb4f59534c8a0dc5b31c1a244eb0406073c6))
* **logging:** configurable format (text|jsonl) + unified hub/agent log config ([#51](https://github.com/khiops/lasterm/issues/51)) ([07bef75](https://github.com/khiops/lasterm/commit/07bef75b44552071cb6c045f6ead0d9ebfc85fe2))
* remote agent auto-deploy with SHA256 integrity + binary TOFU ([#21](https://github.com/khiops/lasterm/issues/21)) ([99bb27d](https://github.com/khiops/lasterm/commit/99bb27d81fa29fe3b3a39a9ddc04d7502a6707aa))
* **root:** add channel deletion endpoint and tab bar scroll ([ce54568](https://github.com/khiops/lasterm/commit/ce54568aff9d2472cb5e2210b01c684066b19b4a))
* **root:** Block 0.1 — monorepo init with pnpm workspaces, TypeScript strict, biome, vitest ([f7daa3d](https://github.com/khiops/lasterm/commit/f7daa3dd69efaea285210f3a2aa61ca107faf0d6))
* **root:** block 0.4 — dev tooling + CI ([ba987ac](https://github.com/khiops/lasterm/commit/ba987ace79bea6ac3cc3d9cd79ff1c4a8d4f21bd))
* **root:** implement editable channel names ([6820038](https://github.com/khiops/lasterm/commit/68200389ee5696d94c63f2dd2b931ade290f7fcb))
* **root:** implement M5 — Polish: UI, config, CLI, onboarding ([097e585](https://github.com/khiops/lasterm/commit/097e58569af74920dcc124654f134c6ff47894f9))
* **root:** implement session persistence across hub restarts ([a5574f2](https://github.com/khiops/lasterm/commit/a5574f22a699b46c0010258f2b62b299400b4d08))
* **root:** M0 Foundation — monorepo, shared types, storage, dev tooling ([facdc74](https://github.com/khiops/lasterm/commit/facdc745c337f21f2e5b1e7aa896ddfe70db100c))
* **root:** server-side channel group persistence + bug fixes ([90f32c8](https://github.com/khiops/lasterm/commit/90f32c84b317cda45d149314991b39a41ecf2f57))
* **scripts:** add build-agent.sh/.ps1 — unified Rust agent build script ([bf216f9](https://github.com/khiops/lasterm/commit/bf216f9c1c2d59b71481c58997fa88431fcfcedc))
* **scripts:** add build-desktop.sh/.ps1 — unified desktop orchestrator ([bf29b39](https://github.com/khiops/lasterm/commit/bf29b39e62522dc070f52c34fc1bcd47c20554b8))
* **scripts:** add build-hub.sh/.ps1 — unified hub SEA build script ([726e701](https://github.com/khiops/lasterm/commit/726e7017b04455204d67e7d721f871787303181d))
* **scripts:** add build-web.sh/.ps1 — unified web build script ([aff0c33](https://github.com/khiops/lasterm/commit/aff0c33d60bb6352d815d47ca7451f8f91375d27))
* **scripts:** add NEXTERM_* env var support to SEA packaging scripts ([fa1587d](https://github.com/khiops/lasterm/commit/fa1587dc2e6bfdaddf47b7565c4c69b4b09b5631))
* **scripts:** add Windows dev scripts, switch to Rust agent daemon ([f63acee](https://github.com/khiops/lasterm/commit/f63acee0410a117b447dd1a717a8e618d63cf676))
* Settings Panel — Config Cascade UI (UX-09) ([#3](https://github.com/khiops/lasterm/issues/3)) ([82d89c2](https://github.com/khiops/lasterm/commit/82d89c2e50604a984572f9d4a0dab468433d72dd))
* **shared,agent,hub:** UX-05 blocks 1-3 — BELL/NOTIFICATION protocol, agent detection, hub routing ([17ddc36](https://github.com/khiops/lasterm/commit/17ddc3605b7959c7925d699ec152d2c761abe8c4))
* **shared,hub,web:** implement UX-06 theming & color schemes ([e5580ea](https://github.com/khiops/lasterm/commit/e5580ea442788f3d38b065e524b47bf24c2790ff))
* **shared,hub:** UX-03 blocks 1-3 — host management backend ([86c738e](https://github.com/khiops/lasterm/commit/86c738e63cb731f5548ca18d7cba26c8032d27e1))
* **shared,web,hub:** UX-07 host customization & visual profiles ([a0826fc](https://github.com/khiops/lasterm/commit/a0826fc7e8e58a1f20a13195e77787b1a31a00bb))
* **shared,web:** unify bell audio — 3 modes (mute/system/custom) per-cascade ([2bf6c5d](https://github.com/khiops/lasterm/commit/2bf6c5d47b60f50a5a913ea68cd7b6067b0a87c3))
* **shared:** add socket path utilities and agent config parser ([c32f22c](https://github.com/khiops/lasterm/commit/c32f22cdea6e997f8eebe4a11fc77a95dbbf12a0))
* SSH key picker with browse, upload, and metadata ([20e56df](https://github.com/khiops/lasterm/commit/20e56df4429b20f1e7939f90ed11c806752e1478))
* **web,hub,shared:** UX-04 scrollback search — SearchAddon, overlay, multi-pane, history ([3a9b568](https://github.com/khiops/lasterm/commit/3a9b568f91be630237eab84d4bf449a01c5d8cc7))
* **web:** add semantic badge color CSS vars to theme system ([d887165](https://github.com/khiops/lasterm/commit/d88716507e82b7121b6023d30e5a7c0734034a51))
* **web:** bell badge flashes briefly on active tab before auto-clear ([1bc7f77](https://github.com/khiops/lasterm/commit/1bc7f77b68192fd5516942e0e08536501bdce79d))
* **web:** bellBadge setting — toggle notification badge per terminal ([dceb421](https://github.com/khiops/lasterm/commit/dceb42108753ed2577d9f20fe546e716bcc42d38))
* **web:** dead channel shows snapshot behind overlay + seamless restart ([6db69bc](https://github.com/khiops/lasterm/commit/6db69bc0e289284341a241c161b463e2d7ac0825))
* **web:** FontCard component with preview and inline delete ([40f785f](https://github.com/khiops/lasterm/commit/40f785f32e87a5e13d996943acd16d2f6b8e76a0))
* **web:** FontPicker modal with upload, delete, and drag & drop ([bbcb04b](https://github.com/khiops/lasterm/commit/bbcb04bc5b8a9313201b124e45a38fffb778159c))
* **web:** implement Block 4.4 — Multi-Client UX ([3cd6829](https://github.com/khiops/lasterm/commit/3cd68291028e7297fab1549b9ce4b1f43b607948))
* **web:** implement Blocks 1.6+1.7 — Vue 3 UI shell + xterm.js integration ([27ac47d](https://github.com/khiops/lasterm/commit/27ac47d64ff722b08ca4040c0a9e17349fd11a91))
* **web:** integrate FontPicker into settings via 'font' control type ([894a683](https://github.com/khiops/lasterm/commit/894a6839d7c45209ede618a004dc19a6cc8ff0b4))
* **web:** integrate SshKeyPicker Browse button in HostModal ([b843c56](https://github.com/khiops/lasterm/commit/b843c56c79548652a03ad1768a0644f774b31381))
* **web:** replace system dialogs with GroupActionDialog component ([73336ae](https://github.com/khiops/lasterm/commit/73336ae8a7c433198d66dd558172f3aff5d14cf6))
* **web:** SC-21 tab DnD reorder in tab bar ([#7](https://github.com/khiops/lasterm/issues/7)) ([1efd219](https://github.com/khiops/lasterm/commit/1efd219a4c1e686a277e989ffc867b756a9c67af))
* **web:** SshKeyCard component with metadata badges and inline delete ([e7ce135](https://github.com/khiops/lasterm/commit/e7ce135920956cbea893c49244bc5ef492589ac3))
* **web:** SshKeyPicker modal with browse, upload, and breadcrumb navigation ([a943bb6](https://github.com/khiops/lasterm/commit/a943bb6e805fab240969c49d945891a871c22c56))
* **web:** toast notifications for SSH/SPAWN errors — no more silent timeouts ([7e47714](https://github.com/khiops/lasterm/commit/7e47714d5ca17a56ca358473952f91ad574d86d6))
* **web:** useFontDrop composable for drag & drop font upload ([bd3c232](https://github.com/khiops/lasterm/commit/bd3c2322b464aa4b699e475ec5dc1a33f0a6f9e2))
* **web:** UX-03 blocks 4-7 — host rail, modal, context menus, batch import ([a23f1ad](https://github.com/khiops/lasterm/commit/a23f1add180286b3024d0f010664a58234d657ef))
* **web:** UX-05 blocks 4-7 — notification store, badges, desktop notifications, unread bar ([7299432](https://github.com/khiops/lasterm/commit/7299432ebdf80727df29cfddeeb162c684894979))
* **web:** UX-11 Connection Experience — 6 blocks + user feedback ([81acf56](https://github.com/khiops/lasterm/commit/81acf565ddd6d2ebc63fef6db4fcde2ba7c7fd61))
* **web:** wallpaper drag&drop upload + fix(hub): index.html no-cache ([#55](https://github.com/khiops/lasterm/issues/55)) ([0bb5238](https://github.com/khiops/lasterm/commit/0bb52382b3223c51c4a37ef42ce0416a9c10efb5))
* **web:** window-wide wallpaper driven by the active pane's scope ([#57](https://github.com/khiops/lasterm/issues/57)) ([0f5a4db](https://github.com/khiops/lasterm/commit/0f5a4dbd6b647c33b3f84fbb3427fb12f1b5e5f2))


### Bug Fixes

* **agent,web:** replace wmic with native Windows API + clear stale channel state on startup ([decdc8d](https://github.com/khiops/lasterm/commit/decdc8d14d1ca27d8d88f2ed8870d78e08d7ddc7))
* **agent:** add --stdio/--buffer CLI flags, remove inheritable pipe handles ([a832f24](https://github.com/khiops/lasterm/commit/a832f2408d7113ddccbaeb6224e89b750ac198aa))
* **agent:** ConPTY cwd fix + wire Windows spawn dispatch ([fad67fb](https://github.com/khiops/lasterm/commit/fad67fbcb5cf96f53e2c015bff39a372d277cfed))
* **agent:** ConPTY deadlock + shell exit 0 on Windows daemon mode ([45b64e9](https://github.com/khiops/lasterm/commit/45b64e91eb9b0d598a37514435323ed06b9c7593))
* **agent:** ConPTY env block — ensure System32 on PATH, fix STATUS_DLL_NOT_FOUND ([a3860bb](https://github.com/khiops/lasterm/commit/a3860bbe319b632e138898b64f3b1a86a54e864c))
* **agent:** ConPTY fully working — HPCON passed as value not pointer ([e2898f5](https://github.com/khiops/lasterm/commit/e2898f52987841ebc606b981872ce5962eb5d7d4))
* **agent:** ConPTY reader/writer initialized at spawn — cmd.exe stays alive ([1d2f755](https://github.com/khiops/lasterm/commit/1d2f7552c3294ec996b8b7f6dbc8811c260318de))
* **agent:** embed conpty.node in SEA build — use modern conpty API on Windows 10+ ([6c3d6d5](https://github.com/khiops/lasterm/commit/6c3d6d5c571e85a8c597bc47d2817f1a5e347e2c))
* **agent:** embed winpty.dll + winpty-agent.exe in SEA for Windows pty support ([5b23859](https://github.com/khiops/lasterm/commit/5b238596f8c67d858030823d3e78f4842073b4c0))
* **agent:** emit SPAWN_OK before starting the PTY reader task ([ee95f84](https://github.com/khiops/lasterm/commit/ee95f84597956c884197a29c93c71087abe8bd86))
* **agent:** extract winpty.dll BEFORE pty.node dlopen in SEA bootstrap banner ([033f67a](https://github.com/khiops/lasterm/commit/033f67a9e2517cf76d425f3113145ad5bf875421))
* **agent:** fix clippy 1.94 Windows-only warnings (io::Error::other, needless_return, doc comment) ([94cf12e](https://github.com/khiops/lasterm/commit/94cf12e8baeaa7a7bf981119b9627f4868fa6688))
* **agent:** force useConpty:false in SEA mode — only winpty pty.node is embedded ([64a0880](https://github.com/khiops/lasterm/commit/64a0880b0dc521d1ed343f76609656dbf56a3d1e))
* **agent:** prepend SEA cache dir to PATH so winpty.dll is found by Windows DLL loader ([9271e79](https://github.com/khiops/lasterm/commit/9271e791f287e84a9fcdd01ff4eb1de9d682d1f2))
* **agent:** prevent ConPTY stdout leak by clearing HANDLE_FLAG_INHERIT ([c6282bb](https://github.com/khiops/lasterm/commit/c6282bb4cc25dcc838ea84d8be18e33c18bf4c89))
* **agent:** revert to useConpty:false in SEA — conpty.node hangs on Windows, keep winpty until validated ([9254e3d](https://github.com/khiops/lasterm/commit/9254e3d8820faf0917224d13c93eb544cc40f30e))
* **agent:** search winpty files in prebuilds/ too (not just build/Release/) ([32201a0](https://github.com/khiops/lasterm/commit/32201a06fcc18ec9bc66f7ac22e6e8238d6d4931))
* **agent:** signal number-to-name mapping in CHANNEL_EXIT + M1 review backlog ([fd3193d](https://github.com/khiops/lasterm/commit/fd3193d857fcb2910df632111f636d9d6671075c))
* **agent:** use is_null() for HANDLE comparison on Windows MSVC ([ebc7eac](https://github.com/khiops/lasterm/commit/ebc7eac43b8b4aeef4f45b567735ea8191bbcb2e))
* **agent:** Windows cross-compilation errors in async-xpty + daemon cfg guard ([eed7e17](https://github.com/khiops/lasterm/commit/eed7e17e13f51c53abfcc5ea5d73678e961b5a48))
* **ci:** build shared package before web UI ([ae59325](https://github.com/khiops/lasterm/commit/ae593250061a0b13a51fe9792ec5aebb68a34cec))
* **ci:** exclude desktop from SEA build step ([6298b05](https://github.com/khiops/lasterm/commit/6298b0503f5e5b504bd4a655056a49d7da0894f7))
* **ci:** upload NSIS installer (.exe) not .nsis glob — was uploading only MSI ([7a08146](https://github.com/khiops/lasterm/commit/7a08146f0c60bbf114af26b4602b4d7456289f4f))
* **ci:** use --target for cross-compile — aarch64 agent was built as x86_64 ([9c6a506](https://github.com/khiops/lasterm/commit/9c6a5064cefc265d0a9a4ff14c66e9da5ff11d62))
* **desktop+hub:** desktop reads runtime.json for hub port, no hardcoded fallback ([3bec53f](https://github.com/khiops/lasterm/commit/3bec53f28b64c1fe807e4b1aa9982e5e3aaa3cde))
* **desktop:** absolute URLs for Tauri, sidecar logging, NSIS template marker ([e20b262](https://github.com/khiops/lasterm/commit/e20b2623a4b30b34ef21ea371ecf1d36bfacd4e6))
* **desktop:** add mut to sidecar rx receiver ([6f61818](https://github.com/khiops/lasterm/commit/6f618186381913fe5799d31cde2d51c6a887872b))
* **desktop:** auto-auth flow, titlebar z-index, sidecar paths + test updates ([e7db460](https://github.com/khiops/lasterm/commit/e7db460c1bda1cfa28dd82172f78d02712657dbc))
* **desktop:** disable CSP — blocks Tauri IPC, inline styles, and xterm.js rendering ([8698e98](https://github.com/khiops/lasterm/commit/8698e983e88334b4c2c852431c248bbf37d493da))
* **desktop:** enable DevTools in release + add 127.0.0.1 to CSP for debugging ([0d8f981](https://github.com/khiops/lasterm/commit/0d8f98131501153aeaeead693a2a605f04f753bc))
* **desktop:** floor @tauri-apps/plugin-shell range at the patched 2.2.1 ([7454020](https://github.com/khiops/lasterm/commit/745402028af73c7dfe823c92271bdd9bc78f2cff))
* **desktop:** move license from nsis to bundle level (licenseFile) ([65a22fd](https://github.com/khiops/lasterm/commit/65a22fd4ef2f35263a944c856573c82d274c8c02))
* **desktop:** pass 'start' arg to hub sidecar (was exiting immediately) ([9435bbb](https://github.com/khiops/lasterm/commit/9435bbbdcfbec8732521e1326b2a8bf73de0e99a))
* **desktop:** place sidecars in src-tauri root, not binaries/ subfolder ([24e22e6](https://github.com/khiops/lasterm/commit/24e22e6dcfc4a13dcd0459ebcf2c5fcd80f13eec))
* **desktop:** Tauri command for auto-auth, better pairing error handling ([bbecc1f](https://github.com/khiops/lasterm/commit/bbecc1ff9fb6d953f6c3d9bc4163ddcb258fee75))
* **desktop:** use async spawn for sidecar log receiver ([45fef64](https://github.com/khiops/lasterm/commit/45fef64df8d123ad5fcbd32c7acc7ecf18ad9cb4))
* **hub,agent:** address review conditions — version validation, daemon logging, doc fix ([7293ea2](https://github.com/khiops/lasterm/commit/7293ea28377dc7bd5f8b7b12cbcbaf9bee8e67db))
* **hub,agent:** create socket parent dir before bind so the daemon starts under WSL ([72cf1ed](https://github.com/khiops/lasterm/commit/72cf1eddbb97dd58508aff71eefdd61bc71f7238))
* **hub,shared,agent:** address 5 S-priority review findings (F-004,F-005,F-006,F-007,F-009) ([b344a5f](https://github.com/khiops/lasterm/commit/b344a5f2d54e0fdfd9211cf374f9db8b4b88fdaa))
* **hub,web,shared:** move title resolution from client to hub + UX bugfixes batch 2 ([82f3d22](https://github.com/khiops/lasterm/commit/82f3d22018c6f7808fa6a7792804c58f93d4c578))
* **hub,web:** 3 M-priority bugs — SSH test auth, bell aggregation, delete modal ([a002a84](https://github.com/khiops/lasterm/commit/a002a84615b0ab89848aca8f33f7cf2e095e607f))
* **hub,web:** 3 M-priority bugs — SSH test auth, bell aggregation, delete modal ([553a68c](https://github.com/khiops/lasterm/commit/553a68c5488fc8d2c61e5d6f970df3aa2b764c54))
* **hub,web:** harden host-group input validation and useLogs request races ([960aa2d](https://github.com/khiops/lasterm/commit/960aa2df37125dd988fce13669bf98f6980f14b8))
* **hub,web:** propagate SSH spawn errors to UI + deploy instructions modal ([5d8929f](https://github.com/khiops/lasterm/commit/5d8929f226e825c194c7da8d8bd39d7c83973ee3))
* **hub+agent:** daemon-only local agent + ConPTY stdout leak workaround + 8-digit pairing UI ([106df20](https://github.com/khiops/lasterm/commit/106df20818230eff6c648b6a68440be2962c3ed5))
* **hub+agent:** final LOW fixes — SEC-020/024/027/028 ([123bef3](https://github.com/khiops/lasterm/commit/123bef3e3a71ae3f28b4108a10245424bc0f5d94))
* **hub:** add CORS headers + skip auth on OPTIONS preflight (Tauri cross-origin) ([d34f7d4](https://github.com/khiops/lasterm/commit/d34f7d4f6f1ba2bc86b702224dda801d9eb9affe))
* **hub:** address M5 review findings — TS errors, Windows compat, stale comment ([afc1ab8](https://github.com/khiops/lasterm/commit/afc1ab8ed5849c3d2982f610a6a180f52b029c5d))
* **hub:** always cache passphrase 60s for TOFU retry + trace logging ([f0999d4](https://github.com/khiops/lasterm/commit/f0999d4a94429965cc162be58ab62594524d8dfb))
* **hub:** bundle better-sqlite3 JS in SEA — shim bindings to use dlopen'd addon ([399ffd6](https://github.com/khiops/lasterm/commit/399ffd6ad377727759765d87dbfce7b798c918e1))
* **hub:** correct resolveAgentPath dev-mode traversal (4 levels, not 5) ([485830b](https://github.com/khiops/lasterm/commit/485830bf799568666292de601b38ad6d80bbf9ac))
* **hub:** cross-platform build script — replace cp -r with Node.js fs.cpSync ([ea5f321](https://github.com/khiops/lasterm/commit/ea5f32128d9d54427dff12ce6eadc7aadec2b109))
* **hub:** embed toml-edit WASM as SEA asset — fixes WebAssembly crash in packaged binary ([81393a8](https://github.com/khiops/lasterm/commit/81393a8c133beb8bbe49014b42d4cd33bd6448c6))
* **hub:** integration fixes — restore SEC-008 TOFU flow, add missing type fields, remove dead LogViewer ([1e10bcd](https://github.com/khiops/lasterm/commit/1e10bcd544873f468ef86463b1f232582b51223c))
* **hub:** P0 security fixes from audit + catalog hygiene ([b605745](https://github.com/khiops/lasterm/commit/b605745769ccaddc1471aca34dc8e34e061b09ec))
* **hub:** P1 security fixes + quick wins (SEC-004/005/009/010/019/022/023/029/030) ([e21cd8d](https://github.com/khiops/lasterm/commit/e21cd8d92d64bfc07bda0e9b6dc5fd654e886a8b))
* **hub:** pre-decrypt SSH key with passphrase before connect — fixes ed25519/bcrypt auth ([3104d27](https://github.com/khiops/lasterm/commit/3104d270c9f324e71414b45240592360bd13abce))
* **hub:** put cmd.exe first in Windows shell discovery — pwsh.exe incompatible with winpty ([5c339a1](https://github.com/khiops/lasterm/commit/5c339a15c2df8b6ea219a5b412d55202a0e0525d))
* **hub:** re-serialize decrypted SSH key as PEM — fixes ed25519/bcrypt connect ([5318b00](https://github.com/khiops/lasterm/commit/5318b0051f214a7d81d57d8bc7804b1a92836734))
* **hub:** remaining P1+P2 security fixes (SEC-002/007/008/011-017) ([b29f335](https://github.com/khiops/lasterm/commit/b29f3350816e9f4e16fc2050b538d254f2684810))
* **hub:** remove LocalAgent dead code, fix agent path for Rust binary ([b486717](https://github.com/khiops/lasterm/commit/b4867171a5d19c45d4bca95f306eccf64e672ccd))
* **hub:** remove non-null assertions in session-manager spec ([8be429b](https://github.com/khiops/lasterm/commit/8be429b838c137912e1c79fc39983f0687c4c3a5))
* **hub:** resolve agent binary path in SEA/Tauri mode (use co-located binary, not dev main.js) ([7ada002](https://github.com/khiops/lasterm/commit/7ada002abefabbf4ceb816a9520d0380c7a2c2e0))
* **hub:** resolve review blockers — rate limit, exactOptionalPropertyTypes, lint ([08acdec](https://github.com/khiops/lasterm/commit/08acdec55827c4eabf3308715416e29ddcd4e569))
* **hub:** review findings F-001/002/003/004 — WS auth expiry, protocol types, CORS escape, TOFU comments ([56ce4be](https://github.com/khiops/lasterm/commit/56ce4be9190932ef3cc69e94a2433e84351c01df))
* **hub:** route interactive SSH prompts by owner identity, not bare host ([#43](https://github.com/khiops/lasterm/issues/43)) ([bd2cc04](https://github.com/khiops/lasterm/commit/bd2cc0413d843e377c8bb90843b1b2bb7b5243c4))
* **hub:** runtime.json persists actual port after zero_conf retry ([1e5b518](https://github.com/khiops/lasterm/commit/1e5b518cdc7ffc26dc8341b7bbd506967c3cbf48))
* **hub:** SEA bundle must invoke main() — cli.ts exports but never self-calls ([a30e1ce](https://github.com/khiops/lasterm/commit/a30e1ceccc9e94ba6d2e9e3f5d1cb48bd27504c5))
* **hub:** single-flight local agent daemon connection + level-gated debug logging ([#53](https://github.com/khiops/lasterm/issues/53)) ([d67e3d5](https://github.com/khiops/lasterm/commit/d67e3d54b63ab5223d91b5b061e0d6aa228ac689))
* **hub:** skip probe in connectOrLaunch — direct connect avoids named pipe AUTH race on Windows ([eb987ea](https://github.com/khiops/lasterm/commit/eb987eaa65e33e78a3f93aba57ee651821eeae85))
* **hub:** snapshot timeout 5s (prevents hang) + revert shell order to pwsh-first ([cf63a35](https://github.com/khiops/lasterm/commit/cf63a35565d9636a1dfd80c7775e270b0f75e8c5))
* **hub:** SSH verbose logging + DELETE host cascade + About modal verified ([fb21d6f](https://github.com/khiops/lasterm/commit/fb21d6f89a7801592d710443a1c749715da26664))
* **hub:** unify agent message routing via pendingRequests dispatcher ([21e8738](https://github.com/khiops/lasterm/commit/21e87388d1d6d1d4d132247ad47898ac929d16c7))
* **hub:** use @fastify/cors instead of manual CORS — supports credentials + remote hubs ([3b45543](https://github.com/khiops/lasterm/commit/3b455432658ee0923f1c4d92ec5634d98aa1fe1c))
* **hub:** use max Shell number instead of count to avoid duplicate titles ([a50177c](https://github.com/khiops/lasterm/commit/a50177cd2f606e6870a5c582f65d06850f727e74))
* **hub:** use ssh_user from host config instead of parsing sshHost only ([26771fb](https://github.com/khiops/lasterm/commit/26771fb6d8112d4bc1b28b8035b3b83b6b95fcee))
* **hub:** wait for daemon readiness in SEA mode before success ([#66](https://github.com/khiops/lasterm/issues/66)) ([a6e3960](https://github.com/khiops/lasterm/commit/a6e3960db448e52c2fcd5fad0b35786650996030))
* **hub:** wire up main.ts, fix WS auth bypass, auto-copy migrations ([01f8fec](https://github.com/khiops/lasterm/commit/01f8fece2931ec79864ab9696621da9ed553b329))
* review findings F-001/F-002/F-003 + test isolation for seedShellProfiles ([3ba6639](https://github.com/khiops/lasterm/commit/3ba663967532d274f5d211857b45205170bb1c36))
* **root:** add backpressure flow control to PTY input pipeline ([51feac5](https://github.com/khiops/lasterm/commit/51feac50b803c2811f626137d0a990c86f4da266))
* **root:** clear all S-priority review backlog — 24 items across 8 blocks ([27c675e](https://github.com/khiops/lasterm/commit/27c675e3bdde53cb186a8828524291e35395a66f))
* **root:** exclude spec files from build tsconfigs, add @types/node to all packages ([544c2f0](https://github.com/khiops/lasterm/commit/544c2f0e9cc7cdea4339c60deb6c7765086c6674))
* **root:** host status dot + configurable dead channel tab behavior ([a7e8a0c](https://github.com/khiops/lasterm/commit/a7e8a0cc60d85046835eabf45a8cdd04c77594eb))
* **root:** make orchestrator model-agnostic in Workflow Execution Strategy ([a1f1a0b](https://github.com/khiops/lasterm/commit/a1f1a0bcd49e7f4a9eb6efcbc9a393d512e698c8))
* **root:** prevent agent crash on channel destroy and keep dead tabs ([75484fc](https://github.com/khiops/lasterm/commit/75484fc0383264ff7cdb32358b7b5d9545681141))
* **root:** push-first state architecture and write-lock race fix ([3609073](https://github.com/khiops/lasterm/commit/3609073afe724294a9c0186990f2f9eea506cf22))
* **root:** resolve seq collision, font reload, and UI polish for warm restart ([39db256](https://github.com/khiops/lasterm/commit/39db256c7b1207ea01740e3b0e09a34daae81c82))
* **root:** restore write-lock state after WS reconnection ([e11e438](https://github.com/khiops/lasterm/commit/e11e438bca015ef386c561546c3d0aeedeca9a36))
* **root:** review fixes — whitespace-only title validation, dead code removal, eslint comment ([3797bd6](https://github.com/khiops/lasterm/commit/3797bd65f352fffaead12151b6d6dadf1e7a7338))
* **root:** review fixes — WS input validation, GC config, SendQueue DRY, composable tests ([ca66b69](https://github.com/khiops/lasterm/commit/ca66b69ef7f6dcc6d61d70adac593425307ee908))
* **root:** Sonnet for code implementation, Opus for review — best cost/quality ratio ([883bfa0](https://github.com/khiops/lasterm/commit/883bfa02372305ffe2a01d2e45fad53257bf4870))
* **root:** upgrade vite 6→8 and pin vulnerable transitives ([#73](https://github.com/khiops/lasterm/issues/73)) ([91b4454](https://github.com/khiops/lasterm/commit/91b44543860c13c94f4711eecc9b92bb8aa862d6))
* **root:** wire per-package test scripts to root vitest projects ([#70](https://github.com/khiops/lasterm/issues/70)) ([8d30343](https://github.com/khiops/lasterm/commit/8d30343f733daa436dedc72432e5cc9fe1ddc786))
* **scripts:** look for node-pty prebuilds in SEA packaging ([6e1662d](https://github.com/khiops/lasterm/commit/6e1662de1eb6e2edf9845dd8db9d0193fd2cf5e1))
* **scripts:** use shell on Windows for npx/postject in SEA build ([55eedae](https://github.com/khiops/lasterm/commit/55eedae06e21a9036e41880b0c2cff1f1ea903fa))
* **shared:** exclude sea-addon-loader from barrel export (breaks Vite web build) ([ccc696b](https://github.com/khiops/lasterm/commit/ccc696b7b876fbbe4f5f23192d61d32db0f72ad2))
* **tests:** cross-platform test suite — Windows named pipes, dead LocalAgent cleanup ([a1f31cd](https://github.com/khiops/lasterm/commit/a1f31cdffb7af4d910e1bf00b20365e465f1e401))
* **tests:** fix 3 remaining Windows test failures (shell-seed, config API) ([e9d9038](https://github.com/khiops/lasterm/commit/e9d90382b1dd6b72402e9233aad59f721e781f67))
* **tests:** make test suite cross-platform for Windows ([32494a2](https://github.com/khiops/lasterm/commit/32494a2933147ca00c011be61e425b76df3c49fb))
* **web,hub,agent:** resolve 16 L-priority tech debt items ([0df8622](https://github.com/khiops/lasterm/commit/0df8622d470695faf8d43a4e3032646420f9d97b))
* **web,hub,agent:** resolve 16 L-priority tech debt items ([bc2807b](https://github.com/khiops/lasterm/commit/bc2807b63cf4af67c4b676bfe368cfcafd3c151a))
* **web,hub:** multi-client channel sync + SSH reconnect for encrypted keys ([930a299](https://github.com/khiops/lasterm/commit/930a299ce5f2fc906594e1c91e4354a531f8507e))
* **web,hub:** resolve 10 UX bugs across channel lifecycle, pairing, and theming ([b037c40](https://github.com/khiops/lasterm/commit/b037c403828fdd6d13405d1fc295ea2b89d431eb))
* **web,hub:** resolve 9 M-priority Sprint 1 review findings ([#4](https://github.com/khiops/lasterm/issues/4)) ([7a4a862](https://github.com/khiops/lasterm/commit/7a4a862e8c109028ded43cbe18cbaa57d898b2c8))
* **web,hub:** SSH key picker — fix relative URL fetch + filter .pub/config files ([1497184](https://github.com/khiops/lasterm/commit/1497184759a380edc708cd3fc64e38726a8a1044))
* **web,hub:** UX bugfixes batch 2 + tab identity refactor ([b14604e](https://github.com/khiops/lasterm/commit/b14604ef8225400ab86bb842ea59f49fa3865083))
* **web,hub:** UX-05 review blockers — wire sound/notifications, badge clear, reconnect, timers ([ced5e3e](https://github.com/khiops/lasterm/commit/ced5e3ea673b70b8abe867266795ef13867a5fc5))
* **web:** bell badge persists ~1s on active tab, scroll no longer clears bells ([1f55b40](https://github.com/khiops/lasterm/commit/1f55b40c7286a4bd4ac6fe072f806ed7957d8662))
* **web:** clear bell + activity in store on tab focus ([b945007](https://github.com/khiops/lasterm/commit/b945007ad187af34e64365ae47c12cd2d8b352b0))
* **web:** close tab when channel is explicitly deleted from sidebar ([0988ddb](https://github.com/khiops/lasterm/commit/0988ddb07faa8ad44cb31b41acf0c141c8f61479))
* **web:** enable Ctrl+V paste and Ctrl+C copy in terminal ([97cde1c](https://github.com/khiops/lasterm/commit/97cde1c4d2ef6eb6f04fde2e20805b8a56ccf425))
* **web:** enable host/channel settings overrides and wire bellStyle to xterm.js ([b9ccf3b](https://github.com/khiops/lasterm/commit/b9ccf3b6ab2744bea58dcf2ec6e8fd762debff24))
* **web:** filter ERROR listener by channelId in reattachChannel (race condition) ([8dd2b34](https://github.com/khiops/lasterm/commit/8dd2b34524ce3be10827f02690281e8f81f74bcc))
* **web:** hide "Move to General" for channels already in General group ([20ca7f1](https://github.com/khiops/lasterm/commit/20ca7f1d3db7ba4a5316322a01d1b12307930baf))
* **web:** hide write-lock indicator on dead channels ([6366684](https://github.com/khiops/lasterm/commit/6366684639f03a686fb59cd8808eda1aa41d1354))
* **web:** keep terminals alive across tab switches (v-show instead of destroy/recreate) ([567eac7](https://github.com/khiops/lasterm/commit/567eac71be92d8f2b5ab7ece9f0df84ec0cd703f))
* **web:** move AppearancePanel before v-if/v-else chain in App.vue ([4eaceb2](https://github.com/khiops/lasterm/commit/4eaceb26fa1fbcc374621ac9db3da8daee5447c4))
* **web:** only clear channels on host switch, not on refresh — keeps tabs open ([dae8149](https://github.com/khiops/lasterm/commit/dae81493cf288b5d97bdf30b18ccd60507d65975))
* **web:** pass hostId prop to TerminalPane for per-pane visual profile ([04ed02e](https://github.com/khiops/lasterm/commit/04ed02e6740410a06c8cf68af779eb15baa7cffb))
* **web:** prevent auto-spawn on SSH hosts (avoids Starting… timeout tab) ([b013a6c](https://github.com/khiops/lasterm/commit/b013a6c0f8546c8ea1af650765508c737d0f98fd))
* **web:** resolve font URLs against hub base URL for Tauri ([234764f](https://github.com/khiops/lasterm/commit/234764fd3be380a6bedea56fd456115a6c2e3058))
* **web:** resolve font watcher race and finalize channel names story ([d2f7905](https://github.com/khiops/lasterm/commit/d2f79057beced3a03be0dd6547be4568e0c30a2b))
* **web:** resolve typecheck errors from UX-03 host entity changes ([57dda20](https://github.com/khiops/lasterm/commit/57dda20bce44e52c63aebbbe34a6ed805b9b6429))
* **web:** settings theming (light/dark), tab activation, font auth/list + index.html no-cache ([#54](https://github.com/khiops/lasterm/issues/54)) ([5792eab](https://github.com/khiops/lasterm/commit/5792eabcdd0d58152d69e991a07da1151b29821b))
* **web:** show bell badge on channel sidebar and tab bar for active tab ([e74cc37](https://github.com/khiops/lasterm/commit/e74cc373b472348e083a046ee324e8319dce9e9e))
* **web:** sidebar click always opens tab even when re-selecting same channel ([d5d81eb](https://github.com/khiops/lasterm/commit/d5d81ebd0697c3765998d9141acd80b8e398c9c0))
* **web:** snake_case mapping + edit host remount ([46a21d4](https://github.com/khiops/lasterm/commit/46a21d4d6ffc018a8250c11fb9df164d135dc6fd))
* **web:** split pane creates vacant instead of terminal, enforce max 4 panes ([3dff4f9](https://github.com/khiops/lasterm/commit/3dff4f9d92c85241fedffeee20c8cf3f9f25347a))
* **web:** TypeScript strict mode errors (vue-tsc CI) ([9c96659](https://github.com/khiops/lasterm/commit/9c966599d041da89fc3f2b5e8c8a6eaf214676fb))
* **web:** unread line bar + host DnD — 3 bugs found during E2E ([3a95d32](https://github.com/khiops/lasterm/commit/3a95d32f13a9afe69dac0e769afd2d622342843b))
* **web:** write-lock dialog shows channel title instead of raw ID ([9bf223d](https://github.com/khiops/lasterm/commit/9bf223d16795366e52c0e77e0d2e633eeec86c83))
* **web:** write-lock takeover now visible on observer clients ([81c2c0a](https://github.com/khiops/lasterm/commit/81c2c0adf8bbc39babdd6153d26cd8ace8b6358e))


### Refactoring

* audit P2 batch — route splitting, WS handlers, pagination, cleanup (AUD-017/018/019/020/021/023/024/025) ([38f76d7](https://github.com/khiops/lasterm/commit/38f76d7f06c953aeded8bb90c175baaeaca6ce65))
* **hub,web:** AUD-024 — verb-in-URL cleanup for reorder/purge endpoints ([db52d64](https://github.com/khiops/lasterm/commit/db52d64ef39d64d3780fc85397984c8d117e8f44))
* **hub,web:** consolidate /api/config/resolved into /api/config/cascade ([e65e3fa](https://github.com/khiops/lasterm/commit/e65e3faaa60cdb4794d4e78b580591410997fa10))
* **hub,web:** remove dead host-group DAL methods + define theme-aware --nt-* tokens ([29aac9e](https://github.com/khiops/lasterm/commit/29aac9e12f78bb1ae4910c8d17fd99cb5f51ac99))
* **hub:** AUD-014/015 — decompose SessionManager + split MetaDAL into domain DALs ([9460208](https://github.com/khiops/lasterm/commit/94602081f534f86aa04d1a70904e519d83dd0e6a))
* **hub:** extract _storeSnapshot helper (DRY fix F-003) ([2129051](https://github.com/khiops/lasterm/commit/2129051683ec2e4cfd06a20bfa1a14d570d6f65c))
* **hub:** extract sanitizeFilename to shared upload-utils ([86598d3](https://github.com/khiops/lasterm/commit/86598d3153f9460eef2d907c1bc836602f1f72ac))
* **root:** rename project nexterm → termora ([339b198](https://github.com/khiops/lasterm/commit/339b1984aab732cf9eeca8711ed35da617661bed))
* **root:** simplify default channel title to 'Terminal' instead of 'Shell #N' ([7a842cb](https://github.com/khiops/lasterm/commit/7a842cb49fa15ca24f149d9023aa5d292c6b38d3))
* **web:** AUD-016 — split useLayout (793 lines) into useTabManager + usePaneTree ([b70f09a](https://github.com/khiops/lasterm/commit/b70f09aa4f21fc6dbc4c1cc1cb6bc6a300e9481d))
* **web:** decouple tab identity from channelId, add pane focus tracking ([233c0f5](https://github.com/khiops/lasterm/commit/233c0f50aafb576a18884bae0f14fcf9437f9476))
* **web:** per-terminal profile resolution via cascade API ([f5ae339](https://github.com/khiops/lasterm/commit/f5ae339ef528b5e9522f806320d6e545d70bd652))
* **web:** rename useFontDrop → useFileDrop with configurable extensions ([99b3bf1](https://github.com/khiops/lasterm/commit/99b3bf120b59359dfaaca4b79765065aeb6c7c11))


### Performance

* **hub:** stream log-search reads instead of slurping whole file ([80f8db3](https://github.com/khiops/lasterm/commit/80f8db39038ee362fc3d2e037017858163594e08))


### Tests

* **agent:** skip LOG frames before SPAWN_OK in full lifecycle test ([1fe598f](https://github.com/khiops/lasterm/commit/1fe598f429839c45239104b6313c0920fea6240c))
* **async-xpty:** drain PTY output until EOF to fix flaky env/output tests ([707a67c](https://github.com/khiops/lasterm/commit/707a67cb732c0042cc2bd556455e4aba79c9d7ac))
* **e2e:** add regression scenarios 89-92 for bell, scroll, SSH spawn, group dialogs ([1be5f86](https://github.com/khiops/lasterm/commit/1be5f86ec352a14de205411b18543bb863b6aba2))
* **hub,web:** cover host-groups API routes and useLogs composable ([2c45abb](https://github.com/khiops/lasterm/commit/2c45abb7bfaa5cb5bf283591763f09e912b81962))
* **hub:** harden ssh-keys.spec.ts isolation (mkdtempSync + afterEach cleanup) ([4aa1dba](https://github.com/khiops/lasterm/commit/4aa1dbabb79a49b14a33e5876621e31a059af91b))


### Documentation

* add build matrix spec, plan, and fix JSON formatting ([171b70f](https://github.com/khiops/lasterm/commit/171b70f556733886fca27f492d305b67c26c84e1))
* add E2E scenarios for UX-03, UX-05, UX-07 (scenarios 59-88) ([3e9c1e8](https://github.com/khiops/lasterm/commit/3e9c1e8b9562de146a6d857a29fe560d337fdd26))
* agent as universal PTY manager, port 4100, XDG/Windows paths ([4541965](https://github.com/khiops/lasterm/commit/454196558d4a271bbec917590d26067fa26c9e00))
* **audit:** update report v1.1 — mark 4 P0 findings resolved ([456d910](https://github.com/khiops/lasterm/commit/456d910c6d5fe5720945a90f5e176147cd2fb61b))
* **audit:** v1.2 — 13/30 findings resolved (P0 all done, P1 4/6, quick wins 7/7) ([dd08540](https://github.com/khiops/lasterm/commit/dd085408790507a59038a6aeb3389b34993be590))
* **audit:** v1.3 — 23/30 findings resolved (P0+P1 all done, P2 9/9) ([71ef032](https://github.com/khiops/lasterm/commit/71ef0321d23ba57ae4348611c6be99721541650d))
* **audit:** v1.4 — 24/30 resolved, all P0/P1/P2 done, SEC-018 structured logging ([6124b18](https://github.com/khiops/lasterm/commit/6124b18f09307e9c9675c305807319c888074f92))
* **audit:** v1.5 — 30/30 findings closed, overall health 🟢 SECURE ([1b8d9ad](https://github.com/khiops/lasterm/commit/1b8d9ad3474d165ebbab4fb19547ec950c9515fd))
* **briefs:** UX ideation — 8 stories with coherence addendum ([388b438](https://github.com/khiops/lasterm/commit/388b4380ac96b874cf5dfd9e468021e3d7b13522))
* complete MVP specification suite — IDEATION_BRIEF, SPEC, PROTOCOL, STORAGE, SECURITY, MVP_ROADMAP, TODO ([709cecf](https://github.com/khiops/lasterm/commit/709cecf2d49f00dd4de1eb56bffaeda13ea721a9))
* document local production SEA build & run (verified on Linux) ([9d734f3](https://github.com/khiops/lasterm/commit/9d734f32ce1aab20b8410c81329394451ca3ef3a))
* finalize UX-03 — decisions archived, TODO cleaned, spec canonical ([684231a](https://github.com/khiops/lasterm/commit/684231abbc32a6f2597603a6e3661e7b5a4697b7))
* finalize UX-05 — decisions archived, TODO cleaned, spec canonical ([e888c1e](https://github.com/khiops/lasterm/commit/e888c1e3808182e669109e7816dea219027693e6))
* finalize UX-07 ([e6bc691](https://github.com/khiops/lasterm/commit/e6bc6917b422472169baca61c4013922a0e95901))
* first codebase audit — OVERVIEW + BACKLOG (25 items, 4 P0) ([6f6bdfe](https://github.com/khiops/lasterm/commit/6f6bdfef6e8496901afd0ed688be3891d15349c0))
* font picker spec and implementation plan ([58e9fb6](https://github.com/khiops/lasterm/commit/58e9fb6c1814199c295630b024c5bdc644237448))
* mark all audit P0+P1 items as completed ([60dce5f](https://github.com/khiops/lasterm/commit/60dce5fd6142bd73b9afdf15c654c3449d466088))
* mark all audit P2+P3 items as completed ([1c4fb0a](https://github.com/khiops/lasterm/commit/1c4fb0ae751fea5ce1b471e4672a8dad0c1d9cef))
* mark desktop-translucency spec canonical ([97d1e11](https://github.com/khiops/lasterm/commit/97d1e11435d738769c82a964c3d20a5d44a566d4))
* **plans:** mark [#43](https://github.com/khiops/lasterm/issues/43) redesign specs + rust-agent canonical ([cf67536](https://github.com/khiops/lasterm/commit/cf6753680d689c503c4086d4f151ad978dde0c2e))
* **plans:** promote UX-01, UX-02, UX-04, UX-06 to canonical ([a64603e](https://github.com/khiops/lasterm/commit/a64603eb310ef738bfed7a2026016793b3e40098))
* **plans:** Sprint 1 specs — UX-06, UX-01, UX-02, UX-04 (hardened) ([2a2a0a0](https://github.com/khiops/lasterm/commit/2a2a0a092f5aa0f7ab68b6b3b5cf32676a02e432))
* record automated release chaining design decisions ([585f593](https://github.com/khiops/lasterm/commit/585f5930372a1dd41967b68fb03533e26d62db07))
* record release-please version-sync design decisions ([#64](https://github.com/khiops/lasterm/issues/64)) ([8a53da1](https://github.com/khiops/lasterm/commit/8a53da12bf741bbbf8c35df8e2434fcf4ee2fa6e))
* restructure to @nexterm/* org + clients/web/ + clarify naming ([f3518af](https://github.com/khiops/lasterm/commit/f3518afdfe9f97a3a06b69546bc48104a7d9888b))
* **root:** add channel names review findings to backlog ([288254a](https://github.com/khiops/lasterm/commit/288254abd87b54623064071eee2d6d8bde0a50d6))
* **root:** add E2E testing checklist for channel/tab lifecycle ([a30bc6a](https://github.com/khiops/lasterm/commit/a30bc6a1dab6457cea42ae815ed8be45a81c9c94))
* **root:** add review findings to backlog ([7971437](https://github.com/khiops/lasterm/commit/797143712f72fd91b94a606be05a80f7a7398eaa))
* **root:** add Workflow Execution Strategy with mandatory model routing ([4753609](https://github.com/khiops/lasterm/commit/475360957c4e0ed10ada7f5e76d59615b73b37dc))
* **root:** complete E2E run [#1](https://github.com/khiops/lasterm/issues/1) — 16/18 pass, 2 manual-only skipped ([8d37027](https://github.com/khiops/lasterm/commit/8d37027f9dc562c6364ba3420b72a51b3119a2b8))
* **root:** config reference + backlog cleanup ([387f9f0](https://github.com/khiops/lasterm/commit/387f9f028a19c9989207d7030580d36a1c542fb0))
* **root:** E2E run [#1](https://github.com/khiops/lasterm/issues/1) — 17/18 pass, add multi-browser write-lock test ([cd0a4c9](https://github.com/khiops/lasterm/commit/cd0a4c94e7b9d2531e847cd179209070fbba9f01))
* **root:** M2 complete — update TODO and CLAUDE.md ([9a614f3](https://github.com/khiops/lasterm/commit/9a614f3718b8607299268f2d75247f177035107f))
* **root:** mark 3 M-priority bugs as resolved in TODO.md ([ce1af4f](https://github.com/khiops/lasterm/commit/ce1af4f9b4fc22bc4e156db7320228f4bcfde546))
* **root:** restructure E2E test suite and fix COHERENCE brief schema ([35442b8](https://github.com/khiops/lasterm/commit/35442b8cbb6b78cb7d5ad67c642f97a427e810cc))
* **root:** restructure TODO by priority tiers + packaging strategy ([afa0be6](https://github.com/khiops/lasterm/commit/afa0be6ffbe8d99adbf30ffe38e8a0967804ebf2))
* **root:** update architecture docs for agent daemon transport ([7bf51c3](https://github.com/khiops/lasterm/commit/7bf51c34701971534c1c28edaefa85748c1cbbdf))
* **root:** update E2E run log and dev scripts for daemon lifecycle ([629f6aa](https://github.com/khiops/lasterm/commit/629f6aa885123ead84f0d7d43da269b8c6443677))
* SSH key picker spec and implementation plan ([e0d8d44](https://github.com/khiops/lasterm/commit/e0d8d446dba6e2bfbc8bb7ee14aa845af46928b3))
* sync all audit items (P0-P3) into TODO.md for next session ([bd75bdb](https://github.com/khiops/lasterm/commit/bd75bdb403bbd7e1f554ab2e2459eb0d3db39941))
* sync audit findings (P0+P1) into TODO.md ([3535de9](https://github.com/khiops/lasterm/commit/3535de9107ac815f0ea20ad6ffbafb4ce8a93fc7))
* update TODO.md — 16 completed items, 2 new discovered items ([53936a5](https://github.com/khiops/lasterm/commit/53936a57ebaa80e78588358ca3c53207699505b7))
* **web:** UX-11 Connection Experience spec — adversarial + 3-LLM hardened ([08ae2f8](https://github.com/khiops/lasterm/commit/08ae2f88d0621452aa14e02e345cb49cec495db7))


### CI/CD

* --ignore-scripts for Web UI build (no native addons needed) ([811eea5](https://github.com/khiops/lasterm/commit/811eea5ab73d2e319478fd714dada862dd76bfbe))
* add --clobber to release upload — handle partial reruns ([190d858](https://github.com/khiops/lasterm/commit/190d858b47d79d176237897f1552d221fe22ba22))
* add desktop Cargo.toml to Release Please + dynamic version patching ([f63036b](https://github.com/khiops/lasterm/commit/f63036bc4168a90ce602376f70e572cf178ccdf4))
* add desktop/NSIS build to release pipeline — download from release, upload installers ([9754bdd](https://github.com/khiops/lasterm/commit/9754bddff8e756e4cf7b8fb75c5fa7330a3ee9c0))
* add ilammy/msvc-dev-cmd to setup MSVC env (link.exe in PATH) ([f148714](https://github.com/khiops/lasterm/commit/f1487148a06f48162761af181360447f802b4a58))
* add publish-release verification — fail if still draft after edit ([4a72ead](https://github.com/khiops/lasterm/commit/4a72ead8b8cb75ddea062b1a4aee389d61f8cbe2))
* add sccache for faster Rust builds in Tauri CI ([443155f](https://github.com/khiops/lasterm/commit/443155f04d526e715b28e072fa80d231293248e7))
* add smoke test job to diagnose org startup_failure ([6620854](https://github.com/khiops/lasterm/commit/662085417b6021820ac11306aa13b86368024bc0))
* add workflow_dispatch to release pipeline + reuse existing releases ([835b46c](https://github.com/khiops/lasterm/commit/835b46c9a7b674bdce79935f6176d8ac6eac598b))
* add workflow_dispatch trigger for manual reruns ([1a508b1](https://github.com/khiops/lasterm/commit/1a508b1f5a16ebe25486233c81b4207ee2ec0b6e))
* align tauri.conf.json version with release tag at build time ([e35d01b](https://github.com/khiops/lasterm/commit/e35d01bd0448ce6cce821e45a54bd9517e413665))
* all hosted runners (ubuntu-latest + windows-latest) — self-hosted not accessible ([b8e148f](https://github.com/khiops/lasterm/commit/b8e148fecb537b61d68fbe7c1291f2250c41b570))
* all jobs on Windows self-hosted runner (no Linux runner available) ([0b3459e](https://github.com/khiops/lasterm/commit/0b3459e9da3909699a5258792eedad6cc127ef56))
* artifacts + hub/desktop builds only on release tags — zero quota usage on push/PR ([1a3b120](https://github.com/khiops/lasterm/commit/1a3b120149603dee2e9e934114011e9ac8dc37ff))
* auto-cleanup old caches after CI — keep 1 per group ([50390e2](https://github.com/khiops/lasterm/commit/50390e2166e61e74cd990a54ee2b0371eb61628a))
* delete ALL draft releases for tag before creating — fix duplicate drafts ([f018d53](https://github.com/khiops/lasterm/commit/f018d53779c3d0b4f41ae83ab3ba173cdce634ec))
* delete stale draft releases before recreating — handle retag reruns ([922a9ff](https://github.com/khiops/lasterm/commit/922a9ffc177c1a00673c1619b725eba9a9b47f90))
* disable macOS builds temporarily to save runner minutes ([9cc3614](https://github.com/khiops/lasterm/commit/9cc3614ce6e36b5862989ae0486315b478fb5d5a))
* drop darwin-x64 target (macos-13 runners unavailable) ([fb20cd0](https://github.com/khiops/lasterm/commit/fb20cd012f442674621ce2c417e858582c1d2e51))
* fix release asset naming (triple suffix) + Windows temp path ([2950f50](https://github.com/khiops/lasterm/commit/2950f504fbe7ca21f5f414f87b10f7bc0cf702f2))
* fix Tauri build — patch beforeBuildCommand + shell:bash for Windows runner ([f4bb240](https://github.com/khiops/lasterm/commit/f4bb240284f2cf627371a1719108affbd2c08ff0))
* fix Windows tar path in hub release download ([547c1bf](https://github.com/khiops/lasterm/commit/547c1bf9bc8d9df30e887ecb3109d3f700194e4d))
* install python3/make/g++ for native addon compilation on Linux runner ([9b50700](https://github.com/khiops/lasterm/commit/9b50700e9e80d265528c5dbd986d6c54a2962484))
* Linux hosted (free for public) + Windows self-hosted — zero quota usage ([783a1f0](https://github.com/khiops/lasterm/commit/783a1f049a17c3fe1dfa3c7f6dc572e3b7c814f2))
* Linux self-hosted + Windows hosted — optimize quota usage ([fd02638](https://github.com/khiops/lasterm/commit/fd02638b155cbefe2667388097601bc31f534ab9))
* make sccache graceful — fallback to direct compile if cache unavailable ([40e4bb0](https://github.com/khiops/lasterm/commit/40e4bb0bdbfdd5c7ed5bc371783dca64c28b4243))
* PowerShell checkout on Windows to bypass Avast/Cygwin fork crash ([f4a839b](https://github.com/khiops/lasterm/commit/f4a839bb15c1317eb63f2822fa8bf28b242f433d))
* PowerShell Rust install + defaults shell pwsh for Tauri (no bash in container) ([c3872ba](https://github.com/khiops/lasterm/commit/c3872baf46550f6f44e9883c19d636e32c34cc1b))
* PowerShell Rust install + defaults shell pwsh for Tauri (WSL bash conflicts) ([2c25f8f](https://github.com/khiops/lasterm/commit/2c25f8f31a5686901ff376ad4cac0a663b441055))
* re-trigger release-please after repo permissions fix ([8ead678](https://github.com/khiops/lasterm/commit/8ead678ab243e3a6f4272d47a0834a63e9695199))
* release pipeline uses GitHub Releases directly — zero artifact quota ([0b2d5fa](https://github.com/khiops/lasterm/commit/0b2d5fa9f4d9b149f65610a45cd2c328de4a198a))
* **release:** auto-trigger multi-OS build on release-please merge ([#69](https://github.com/khiops/lasterm/issues/69)) ([af830c4](https://github.com/khiops/lasterm/commit/af830c4b6e3694b3a578d07000cb4ef491650758))
* **release:** fix release-please version sync across all packages ([#68](https://github.com/khiops/lasterm/issues/68)) ([3533d44](https://github.com/khiops/lasterm/commit/3533d44ee32fd02fef9e25334e0d93e48f7727fc))
* remove sccache (redundant with Swatinem), add thin LTO + strip for faster builds ([cee26fc](https://github.com/khiops/lasterm/commit/cee26fc204b5f1c9dc07d8710fdaac7e2cee758d))
* remove thin LTO (slower than default), keep strip only ([f0c486d](https://github.com/khiops/lasterm/commit/f0c486d993d78dfe1d282eb1623c5ed25036b106))
* replace self-hosted Windows runner with windows-latest ([efd16d6](https://github.com/khiops/lasterm/commit/efd16d6e32c6e85ccd9267c56b0c58f18c8987e6))
* restore Linux + Windows self-hosted runners ([07bec34](https://github.com/khiops/lasterm/commit/07bec34ab1e57f392b74a16cb1ad3fdae044683d))
* retrigger ([5f5963f](https://github.com/khiops/lasterm/commit/5f5963f883c473296fe9b3b577adf81f76e509ee))
* retrigger build after Web UI failures ([d749060](https://github.com/khiops/lasterm/commit/d749060c750a23465cd87d1713071d8576af68ec))
* revert sccache (GHA cache backend unreliable), keep Swatinem/rust-cache ([02b77da](https://github.com/khiops/lasterm/commit/02b77daf270d71ab6872b863752d09b47423fc9c))
* revert to dtolnay/rust-toolchain (Windows container now has bash) ([e99716a](https://github.com/khiops/lasterm/commit/e99716ad04b33ec0a0258eaec92e74d5c897de38))
* revert to ubuntu-latest (GitHub Actions global outage, not runner-specific) ([78edd3a](https://github.com/khiops/lasterm/commit/78edd3a04767d8966e84b391f09a1c2c12896032))
* revert workarounds — back to standard checkout + rust-toolchain actions ([b0cdf0e](https://github.com/khiops/lasterm/commit/b0cdf0e4f016f2b21f24fc6ddcda5b4c02ff3d44))
* **root:** add biome lint enforcement, clean up test suppressions ([#71](https://github.com/khiops/lasterm/issues/71)) ([ef6a523](https://github.com/khiops/lasterm/commit/ef6a5238dc8faecaa0a66050dd44b270a27f0ea0))
* run the vitest suite on every PR and push ([5f62a9e](https://github.com/khiops/lasterm/commit/5f62a9ee1b583c751805ee0c7f8e7fa6bce19f44))
* sccache with runtime health check — graceful fallback if cache backend down ([a67b77e](https://github.com/khiops/lasterm/commit/a67b77ec0708f2f20dfd2ede58b7ccf4c16efbe7))
* setup Release Please — auto changelog + version bump on merge to main ([6d79977](https://github.com/khiops/lasterm/commit/6d79977dbdbaf4ef98b43e379220d4d1797f3f98))
* skip cargo test on aarch64 cross-compile (PTY tests need native runner) ([73d6eab](https://github.com/khiops/lasterm/commit/73d6eabf1ca7a601ef1f05fff204910305278a7e))
* split release-sea.yml into reusable build + ci + release workflows ([d3cc927](https://github.com/khiops/lasterm/commit/d3cc92790cde7ad66f4e58537ece60326f715a3f))
* switch to self-hosted runners (Linux WSL + Windows) — zero quota usage ([ec3b8df](https://github.com/khiops/lasterm/commit/ec3b8df7116c27f0e57e3cc3e6ac32f8fd9ee4aa))
* temp use windows runner for Web UI build (ubuntu runners down) ([b4c0fda](https://github.com/khiops/lasterm/commit/b4c0fda66c557e9bbd02d9561aa7f61c1e22c29d))
* update GHA to Node 24 compatible versions (checkout v6, setup-node v6, artifacts v7, pnpm v5, github-script v8) ([f279f18](https://github.com/khiops/lasterm/commit/f279f18a2b6bf8ef8c206fb63622630235cf2e71))
* use jq for tauri version patching (simpler) ([ede3712](https://github.com/khiops/lasterm/commit/ede3712b57cff5e54734264be8714c8d2a435643))
* use ubuntu-22.04 for Web UI build (ubuntu-latest runners failing) ([ccf1e96](https://github.com/khiops/lasterm/commit/ccf1e962282e9115889a736fc44d6d8d63c64864))
* use windows-latest for Web UI build (ubuntu runners unreliable) ([488c635](https://github.com/khiops/lasterm/commit/488c6358127ba4f9a41b3a5dd327005a9345ae21))

## [0.3.2](https://github.com/khiops/lasterm/compare/v0.3.1...v0.3.2) (2026-06-06)


### Bug Fixes

* **hub,web:** harden host-group input validation and useLogs request races ([960aa2d](https://github.com/khiops/lasterm/commit/960aa2df37125dd988fce13669bf98f6980f14b8))

## [0.3.1](https://github.com/khiops/lasterm/compare/v0.3.0...v0.3.1) (2026-06-05)


### Bug Fixes

* **agent:** emit SPAWN_OK before starting the PTY reader task ([ee95f84](https://github.com/khiops/lasterm/commit/ee95f84597956c884197a29c93c71087abe8bd86))
* **hub,agent:** create socket parent dir before bind so the daemon starts under WSL ([72cf1ed](https://github.com/khiops/lasterm/commit/72cf1eddbb97dd58508aff71eefdd61bc71f7238))

## [0.3.0](https://github.com/khiops/lasterm/compare/v0.2.9...v0.3.0) (2026-06-05)


### Features

* **hub:** per-host launch profiles from remote agent HELLO shells + SSH fallback ([c34f3c6](https://github.com/khiops/lasterm/commit/c34f3c620ad03d8aa8d751a1f96a266616168734))


### Bug Fixes

* **ci:** use --target for cross-compile — aarch64 agent was built as x86_64 ([9c6a506](https://github.com/khiops/lasterm/commit/9c6a5064cefc265d0a9a4ff14c66e9da5ff11d62))
* **web,hub:** multi-client channel sync + SSH reconnect for encrypted keys ([930a299](https://github.com/khiops/lasterm/commit/930a299ce5f2fc906594e1c91e4354a531f8507e))
* **web:** write-lock takeover now visible on observer clients ([81c2c0a](https://github.com/khiops/lasterm/commit/81c2c0adf8bbc39babdd6153d26cd8ace8b6358e))


### Performance Improvements

* **hub:** stream log-search reads instead of slurping whole file ([80f8db3](https://github.com/khiops/lasterm/commit/80f8db39038ee362fc3d2e037017858163594e08))

## [0.2.0](https://github.com/khiops/lasterm/compare/v0.1.0...v0.2.0) (2026-04-03)


### Features

* **all:** build versioning — /api/health version field + About modal ([c49eb3b](https://github.com/khiops/lasterm/commit/c49eb3b0e8f746656aedddddfd0d31b5a597130e))
