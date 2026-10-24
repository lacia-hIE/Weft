# Weft local Host connector

A native DSH Host plugin for **DSH 0.2.1-rc.2**, installed through the original
`dsh.bundle.patch` mechanism. Run `dsh web` with its loopback listener. The
connector opens an outbound TLS WebSocket to your Weft deployment; no inbound
port or local certificate is needed with the default HTTP loopback listener.

1. In Weft, choose **连接本地 DSH** and generate a connection file.
2. Save it as `~/.dsh/weft-connection.json` with permissions `0600`. Alternatively
   set `WEFT_LOCAL_HOST_CONFIG` to an absolute file path before launching DSH.
3. Download the connector tarball and install its absolute path using the
   native DSH Plugins page. Enable the bundle and reload/restart `dsh web` if
   your profile does not use HMR.
4. Return to Weft. The environment becomes available when DSH connects.

The initial key expires after ten minutes and can be exchanged once. The
connector replaces it with a device token in the same file, written atomically
with permissions `0600`. Do not commit or share this file. Multiple local Hosts
need distinct environments and files. Re-pairing or disconnecting in Weft
revokes the token immediately. Stop DSH or disable this plugin to stop retries.

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
