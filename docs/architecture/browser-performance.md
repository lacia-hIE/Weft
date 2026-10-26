# Browser performance boundaries

Weft optimizes delivery and scheduling around the native DSH runtime. The
original UI components, Boot Graph, Cordis fibers and plugin approvals remain
the owners of rendering, activation and permissions.

- The home catalogue receives its own HTML without workbench preloads. Only
  an environment document preloads the revisioned native modules. The baseline
  build advertised 67 modules totaling about 7.7 MB before compression on both
  routes; the catalogue now requests none of those modules.
- The catalogue's UI and YAML editor code load only on the home route. Identity
  lookup and that module download run concurrently. The native workbench
  retains its existing module loader and recovery entry.
- A local environment card opens its existing native Host mount directly. It
  avoids loading the cloud workbench only to redirect to local DSH. The relay
  still checks current identity and environment state for every request; old
  `/agents/:id` links retain their existing redirect behavior.
- `RefreshQueue` combines same-turn plugin notifications and serializes reads.
  A later notification invalidates an earlier read before it can apply a stale
  composition. It caches no plugin authority or environment state. Native
  Cordis still owns each fiber and disposes its resources.
- The package review page keeps one background read in flight, suspends polling
  when hidden, and aborts reads when unmounted. An event received during a read
  schedules another read instead of opening overlapping requests.
- Worker task details load with at most four concurrent requests per Session.
  Completed details retain the existing cache; closing the cards or changing
  Session aborts the entire group. Requests never share state across Sessions.

Documents, identity and authority responses remain uncached. Only assets whose
content revision matches the current build retain the existing immutable cache.
Mutations and native event delivery are never delayed or combined.

CI checks the home route's native-resource request count, records its script
count and encoded resource bytes, and exercises event bursts, stale grants,
disposal, bounded parallel reads and cancellation. Native browser suites cover
the original plugin approval, Files, Git and terminal workflows. These are
request-count and concurrency improvements, not a claimed latency percentage;
perceived latency still depends on network, device, environment and model.
