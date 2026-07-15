# Architecture view: overall

Nodes 7/7 (collapsed 0), edges 7/7.

- layout: left-to-right
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

### API Handlers `node_api_handlers`

- kind: module
- claims: 1 fact, 0 inference
- knowledge:
  - [fact] (analyzer) Declares per-route handler functions.
    - evidence: src/api/handlers.ts#getUser (sha256:blob-src-api-handlers-ts)
- relations:
  - imports → API Service `node_api` (certainty: known)

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
  - depends-on → Worker Jobs `node_worker_jobs` (certainty: known)

### Worker Jobs `node_worker_jobs`

- kind: module
- claims: 1 fact, 0 inference
- knowledge:
  - [fact] (analyzer) Defines scheduled job units.
    - evidence: src/worker/jobs.ts#reconcile (sha256:blob-src-worker-jobs-ts)
- relations:
  - writes → Primary Store `node_db` (certainty: known)

## Legend

- `fact`: deterministic, analyzer-produced; `inference`: evidence-backed interpretation.
- relation certainty `known` is deterministic; `partial`/`unknown` are not and must not be relied on as facts.
