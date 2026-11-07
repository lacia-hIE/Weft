# Durable Object idle subscriptions

Weft's browser uses hibernatable WebSockets for five passive native feeds:
`$events`, `session/follow`, `session/control`, `workspace/follow` and
`remoteAccess/follow`. The native codecs, service implementations, snapshots,
journals and Client connection supervisor remain owned by DSH. This is a Host
carrier adapter, not a replacement plugin protocol or a second Agent runtime.
The original POST/SSE routes remain available to existing API consumers.

Previously an open browser kept Fetch/SSE requests pending in EnvironmentDO
and SessionDO even while their native iterators waited only for events. An
open HTTP response prevents hibernation. The new carrier uses
`DurableObjectState.acceptWebSocket` and does not retain a passive iterator
pump with `waitUntil`, polling, application heartbeats or timers. Agent work
keeps its existing ownership and execution lifetime.

Native iterators live in memory. On a cold wake the Host closes the previous
physical subscriptions with code 1012. The browser marks this as a carrier
failure using the original Gateway's `dshRemoteStreamFailure` seam; DSH opens
a new generation and restores the canonical baseline/history. A baseline is
never appended twice to the same generation. No page reload or plugin reload
is required, so composer drafts remain mounted. A cold wake can briefly show
the original reconnect indicator. Live output continues over an already warm
connection. Sleeping browsers catch up when they reconnect.

Every upgrade passes the same Access identity, tenant/environment ownership,
same-origin and lifecycle checks as native HTTP requests. The URL contains
only a bounded native subscription descriptor (at most 8192 characters), not
credentials or prompt content. Read-only sockets reject client messages;
native replies continue through authenticated unary RPC. Closing a socket
releases only its iterator. Pausing an environment closes all subscriptions
and rejects new upgrades without resuming it.

This removes one source of idle duration; it does not promise zero DO usage.
Terminal sessions, filesystem watches, active Agent work, plugin network
operations and outbound IM connections can still keep an object awake.
Existing outbound IM connections already share ConnectionGatewayDO shards;
they are not converted into hibernatable inbound sockets by this change.
Third-party callers retaining POST/SSE subscriptions also retain that cost.
Measure namespace duration after deployment before estimating savings.

CI exercises natural workerd idle eviction, forced hibernation with sockets
retained, live journal delivery, snapshot recovery, access/lifecycle boundaries,
and the original browser's history and draft preservation. Cloudflare
production billing must be checked separately; CI does not measure GB-s.

Cloudflare's [WebSocket hibernation guide](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)
describes the platform lifecycle and the conditions that prevent hibernation.
