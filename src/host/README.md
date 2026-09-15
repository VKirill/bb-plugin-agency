# Host file adapters

`host.ts` registers one entry: `documentHostContract` with `materialize` and
`fileOp`.

## Availability vs authorization

`bb.hosts.experimental_client` is on `BbPluginApi` (server factory). Web
`useRpc` and CLI `bb agency` talk to `bb.rpc` at
`POST /api/v1/plugins/<id>/rpc/<method>` — that is a different plane.
`fileOp` is not a plugin RPC method. Core host dispatch is
`plugin.host.call` on the enrolled-daemon online RPC.

Core checks: live plugin, not during factory, method exists on the host
contract, non-empty `hostId`, JSON/size, input/output schemas. Core does
**not** authorize `canonicalRoot`. Handler jail is not a host ACL.

AGY-17 must call `callBoundFileOp` / `resolveBoundFileOp` with a verified
`ProjectBinding`. Missing binding or hostId fails before `client.call`.
Payload root cannot replace `binding.canonicalRoot`.
