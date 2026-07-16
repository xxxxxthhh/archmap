# Architecture view: collapsed

Nodes 5/7 (collapsed 2), edges 4/7.

- layout: left-to-right
- collapse_below: component
- node kinds: system, component, module, external, store
- edge types: calls, reads, writes, imports, publishes, consumes, depends-on

## Nodes

### API Service `node_api`

- kind: component
- claims: 1 fact, 1 inference
- knowledge:
  - [fact] (analyzer) Exposes HTTP route handlers.
    - evidence: src/api/index.ts#registerRoutes (sha256:blob-src-api-index-ts)
  - [inference] (agent) Primary inbound request boundary.
    - evidence: src/api/index.ts#registerRoutes (sha256:blob-src-api-index-ts)
- relations:
  - calls → Payments API `node_payments` (certainty: partial)
  - reads → Primary Store `node_db` (certainty: known)

### Viewer Repo `node_cdb4ee2aea69cc6a`

- kind: system
- claims: 0 fact, 0 inference
- relations:
  - depends-on → API Service `node_api` (certainty: known)

### Primary Store `node_db`

- kind: store
- claims: 1 fact, 0 inference
- knowledge:
  - [fact] (analyzer) Backing relational datastore.
    - evidence: src/db/schema.ts (sha256:blob-src-db-schema-ts)

### Payments API `node_payments`

- kind: external
- claims: 1 fact, 0 inference
- knowledge:
  - [fact] (analyzer) External payment provider dependency.
    - evidence: src/api/index.ts#chargeCard (sha256:blob-src-api-index-ts)

### Background Worker `node_worker`

- kind: component
- claims: 0 fact, 1 inference, 1 stale
- knowledge:
  - [inference, stale] (human) Drains the async job queue.
    - evidence: src/worker/main.ts (sha256:blob-src-worker-main-ts)
- relations:
  - consumes → Payments API `node_payments` (certainty: unknown)

## Legend

- `fact`: deterministic, analyzer-produced; `inference`: evidence-backed interpretation.
- relation certainty `known` is deterministic; `partial`/`unknown` are not and must not be relied on as facts.
