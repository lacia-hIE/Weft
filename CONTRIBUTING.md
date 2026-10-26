# Contributing

**English** · [简体中文](CONTRIBUTING.zh-CN.md)

Issues and pull requests in English or Chinese are welcome. Use the issue templates to describe a concrete trigger, expected/actual behavior, commit or release, runtime mode and relevant logs. Remove credentials, cookies, Access assertions and user data. Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## Development and design

Use Node.js 22.19+, npm and Git. `npm ci` installs locked dependencies. `npm run dev` fetches the pinned upstream source on the first build and serves loopback development with separate local identity/state. Configure models in **Settings → Models**.

- Keep upstream Harness/Cordis APIs and native UI components authoritative. Implement platform adaptations here; do not edit the generated `deepseek-harness/` checkout.
- Preserve the principle that capabilities are plugins: reuse native bundle declarations, configuration, authorization and lifecycle instead of inventing a parallel registry or author protocol.
- Upstream updates explicitly change `upstream.lock.json` and account for Remote ABI, Boot Graph and compatibility-matrix changes.
- Keep tenant/environment boundaries, cancellation and reconstruction behavior intact. Document defaults, missing-configuration behavior and deployment impact.
- Add ordered D1 migrations when schema changes are needed; do not rewrite applied migrations. Keep environment-owned state in environment storage rather than moving it into the platform catalogue.
- Preserve DSH styling, native components and keyboard/accessibility behavior. Scope extension CSS to its own component.

## Verification

Push candidates to your fork's `ci` branch or open a pull request. [.github/workflows/test.yml](.github/workflows/test.yml) runs builds, types, unit/workerd, browser, offline plugin compiler and real container/process/PTY/Git/FUSE checks. Ordinary CI needs neither Cloudflare credentials nor model API keys. Live model checks require explicit opt-in.

Project verification runs in GitHub Actions. A push to `main` does not run tests; maintainers fast-forward the exact tested candidate to `main`. If a merge/squash changes the SHA, verify the resulting commit on `ci` before release. Cloudflare Workers Builds deployment is separate.

Image source changes require the content-hash tags in `apps/*/image.json` to be updated by the existing scripts' rules. Publish only images exported by a successful matching CI run. See [deployment](docs/deployment.md).

Explain user-visible changes, necessary tradeoffs, validation and limitations in the PR. Behavior fixes should exercise their actual trigger; do not add tests that merely mirror reversible style/documentation edits. Keep English and Chinese READMEs aligned when changing supported features or setup.

## Releases, secrets and licensing

Follow [release policy](docs/releases.md) for independent project/connector tags and exact-commit CI checks. Creating a GitHub Release does not deploy resources or publish npm packages.

Never commit `.weft/`, private `.env`/`.dev.vars` files, credentials, keys, user conversations or generated artifacts. Review Git history as well as the current tree. Revoke exposed credentials; deleting a file does not remove history.

Contributions are provided under the project's MIT license. Preserve third-party copyright/license notices, and explain the purpose and license of new dependencies. Communicate respectfully, focus criticism on the work and avoid personal attacks or publishing other people's private information.
