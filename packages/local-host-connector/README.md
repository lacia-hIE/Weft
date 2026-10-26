# Weft local Host connector

A native DSH Host plugin for **DSH 0.2.1-rc.2 and 0.2.1-rc.3**, installed through the original
`dsh.bundle.patch` mechanism. Run `dsh web` with its loopback listener. The
connector opens an outbound TLS WebSocket to your Weft deployment; no inbound
port or local certificate is needed with the default HTTP loopback listener.
Install in the `dsh web` profile; a Desktop-only IPC Host is not supported in V1.

Connector 0.2.x supports both releases and adds native connection settings and
fragmented transport. Existing pairing files can be kept. As of 2026-10-25 the
newest published release is rc.3 (`next`); npm `latest` still resolves to rc.2.
Install rc.3 explicitly with `npm install -g @deepseek-ai/dsh@0.2.1-rc.3`.
Untested releases remain rejected by both the native installer and the relay.

1. In Weft, choose **连接本地 DSH**, generate a connection and copy its pairing code.
2. Install `@laciaproject/dsh-local-host` from the native DSH Plugins page.
   Select **Enable now** when installation completes.
   The downloadable tarball remains available for offline installation by absolute path.
   CLI: `dsh plugin --profile web add @laciaproject/dsh-local-host@0.2.3`.
3. Open **Plugins → @laciaproject/dsh-local-host** on the local DSH page, paste the code
   and select **Save and connect**. The plugin saves settings on this computer;
   no JSON download, manual file editing or restart is needed. Settings survive
   a DSH restart. Existing files at `~/.dsh/weft-connection.json` (`0600`), or the
   absolute path in `WEFT_LOCAL_HOST_CONFIG`, remain supported.
   The pairing form is embedded in the installed package's detail page and its
   component configuration page through native `plugins.bundle.config` and
   `plugins.row.config` slots.
4. Return to Weft. The environment becomes available when DSH connects.

Older DSH versions, including `0.1.7-rc.2`, must be upgraded first:
`npm install -g @deepseek-ai/dsh@0.2.1-rc.3`, then restart `dsh web`.
The connector reports an upgrade instruction when the Host cannot publish its release identity.

If an earlier tarball installed `@weft/dsh-local-host`, remove that bundle before
installing the new npm name. Keep the existing pairing file.

The initial key expires after ten minutes and can be exchanged once. The
connector replaces it with a device token in the same file, written atomically
with permissions `0600`. Do not commit or share this file. Multiple local Hosts
need distinct environments and files. Re-pairing or disconnecting in Weft
revokes the token immediately. Stop DSH or disable this plugin to stop retries.
The local settings page distinguishes expired pairing, revoked authorization,
incompatible versions and temporary network failures. **Stop connection** keeps
the token for **Reconnect**. Settings expose no token; remote views are read-only.

The Host owns sessions, presets, credentials, files, Git, processes and installed
plugins. Weft relays native HTTP and Remote Mux traffic, including file bodies
and terminal streams. The local native frontend and Boot Graph are served
through the same environment mount; plugin assets come from that Host.
Cloudflare terminates TLS at the relay; this transport is not end-to-end encrypted.

See `docs/deployment/local-host.md` in the Weft repository for required Access
routing. The Host keeps running when a browser closes. Disconnecting or removing
the environment from Weft does not stop local processes or delete local files.

V1 supports the native `/api/`, `/plugins/` and `/assets/` routes. Plugins with
custom root routes, external origins, HMR endpoints, or absolute root resource
URLs may need mount support. There is no command replay after a disconnect;
the native client re-establishes streams and refreshes authoritative Host state.
Protocol 2 carries native messages up to 8 MiB in acknowledged 32 KiB fragments,
with a 16 MiB aggregate buffer budget per device direction. Slow or overflowing
streams close individually; interrupted messages are discarded. The server also
accepts protocol 1 from older connectors. HTTP file bodies remain streamed.

Releases use the fixed GitHub repository `lacia-hIE/Weft`, workflow
`publish-local-host.yml`, and environment `npm-production` on `main`. The
workflow publishes the same archive that passed CI, using npm trusted publishing
with OIDC and provenance. See the repository’s
[`docs/deployment/npm-publishing.md`](https://github.com/lacia-hIE/Weft/blob/main/docs/deployment/npm-publishing.md)
for bootstrap and trusted publisher setup.
