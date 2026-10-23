# Security

Weft is under active development. Security fixes target the current main branch; there is no commitment to maintain older releases.

Do not post working exploits, user data, model credentials, Access assertions, cookies or private deployment configuration in public issues. If the repository offers GitHub private vulnerability reporting, use **Security → Report a vulnerability**. Otherwise arrange a private channel with a maintainer before sharing sensitive details.

A useful report describes the affected commit, deployment/runtime mode, minimum reproduction, expected authorization boundary and observed impact. Use synthetic accounts and data where possible.

Deployments must configure their own Cloudflare Access application and allowed users, keep the UI assets Worker private, and store credentials outside Git. Development identity simulation is for loopback development only. Review the exact source, artifact digest and capabilities before approving plugins; Client modules execute in the workbench page.

Before making an existing repository public, review its full Git history and attached artifacts separately. This repository's ignore rules protect common local files; they do not establish that past commits contain no credentials. Rotate any exposed credential rather than relying on file deletion.
