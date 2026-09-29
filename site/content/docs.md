---
# Docs, at /docs/. Links to the documents in the repository, never copies of them: a copy here
# would drift from the one the code is checked against.
title: Documentation
description: >-
  Where Lasterm's documentation lives: the README, the architecture, every configuration key, the
  security model, the protocol and the storage, in the repository.
path: /docs/
lead: >-
  Lasterm's documentation lives in its repository, beside the code it describes. These are the
  documents to start from.
---

## Using Lasterm

- [README](https://github.com/khiops/lasterm#readme): what Lasterm does, how to build and run
  it, where it keeps its configuration and its state, and how remote hosts work.
- [Configuration reference](https://github.com/khiops/lasterm/blob/main/docs/CONFIG_REFERENCE.md):
  every key of `config.toml`, its default, and how settings cascade from everywhere to one host to
  one terminal.
- [Changelog](https://github.com/khiops/lasterm/blob/main/CHANGELOG.md): what each release
  changed.
- [Privacy policy](/privacy/): what Lasterm keeps, and every connection it makes.

## How it is built

- [Architecture](https://github.com/khiops/lasterm/blob/main/docs/SPEC.md): the app, the hub and
  the agent, the data flows, the file system layout and the supported platforms.
- [Security](https://github.com/khiops/lasterm/blob/main/docs/SECURITY.md): the threat model,
  authentication, SSH host keys and jump hosts, what is logged and what never is.
- [Protocol](https://github.com/khiops/lasterm/blob/main/docs/PROTOCOL.md): the framing, every
  message between the hub, the agent and the interface, and the REST API.
- [Storage](https://github.com/khiops/lasterm/blob/main/docs/STORAGE.md): the two databases,
  what they hold, and how old output is removed.

## Getting help

- [Issues](https://github.com/khiops/lasterm/issues): report a bug or ask a question. Issues are
  public: leave out anything private.
- [Source](https://github.com/khiops/lasterm): the code, under the AGPL-3.0.
