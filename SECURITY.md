# Security Policy

## Reporting a Vulnerability

If you believe you have found a security issue in Plumbline, please report it privately. **Do not open a public GitHub issue for security problems.**

- **Email**: `team@bytebell.ai`
- **Subject line**: `[security] <short description>`
- **Encryption**: GPG is welcome but not required. If you wish to encrypt, request the public key in your initial email.

## What to include

- A description of the issue and its impact.
- Steps to reproduce (a minimal proof of concept is ideal).
- The version / commit SHA you tested against.
- Your environment (OS, Bun version, `plumbline --version`).
- Whether you have already disclosed this to anyone else.

## Response timeline

- **Acknowledgement**: within **7 days** of your report.
- **Initial assessment** (severity + scope): within **14 days**.
- **Fix or mitigation**: target **30 days** for high/critical, **90 days** for low/moderate.
- **Public disclosure**: after a fix has shipped, or **90 days** from your initial report, whichever comes first. We will coordinate the disclosure date with you.

## Scope

In scope:

- The local `plumbline-server` HTTP daemon (Express routes, MCP transport, queue workers).
- The `plumbline` CLI (Ink TUI + commander subcommands).
- The `@bb/*` workspace packages under `packages/*`.
- Credential handling (`~/.plumbline/config.json`, mode `0600`; logs under `~/.plumbline/logs/`).
- Shell-injection in CLI argument parsing.
- Prompt-injection in indexed repository content that could cause unsafe outputs from the LLM pipeline.

The OSS edition binds the server to `127.0.0.1` and has no remote attack surface by default — focus is on local privilege and credential handling, not network exposure.

## Out of scope

- Third-party services the user runs (Neo4j, Docker, OpenRouter). Report those upstream.
- The user's own environment (their OS, their LLM provider account, their network).
- Theoretical issues without a reproducible impact on Plumbline.
- DDoS or volumetric reports against `bytebell.ai` web properties (this policy covers the OSS code only).

## Recognition

Plumbline is licensed under **AGPL-3.0-only with an additional non-commercial clause**. We do not run a paid bug bounty programme. With your permission, we will credit you in [CHANGELOG.md](CHANGELOG.md) and the release notes when a reported issue is fixed.
