# Events (POST_EVENT)

Firebird lets PSQL code signal the outside world with `POST_EVENT` — the
classic pattern for cache invalidation and "something changed" notifications.

```ts
const events = await db.events(['order_placed', 'stock_low']);
events.on('order_placed', (count) => refreshOrders());
events.on('post', (name, count) => console.log(name, count));
// … later
await events.close();
```

Uses Firebird's async event channel (a separate socket), so it never blocks
queries on the connection. The first delivery per event is a silent baseline —
only posts occurring after subscription fire. Firebird's one-shot requests are
re-armed automatically.

::: tip Docker note
The async channel needs a fixed, published `RemoteAuxPort` — see the
repository's `docker/docker-compose.yml` for a working configuration.
:::
