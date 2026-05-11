# Order JSON Snapshot v1

Order JSON snapshot is the internal file format for moving one full order
aggregate between ERP databases. It replaces the planned XML transfer because
JSON maps directly to the current NestJS/React/TypeScript stack and is easier
to hash, validate, and keep backward compatible.

## Versions

Every file has two explicit version fields:

- `schema`: format family, currently `erp.order.snapshot.v1`;
- `formatVersion`: file contract version, currently `1.0.0`;
- `exporterService.version`: export service version, currently `1.0.0`.

The exporter service version is part of every exported file name:

```text
order-11151-snapshot-svc-v1.0.0.erp-order.json
orders-created-2026-05-01_2026-05-11-snapshot-svc-v1.0.0.erp-order-batch.zip
```

Import rejects unsupported versions with `UNSUPPORTED_SNAPSHOT_VERSION`.

## Files

Single order export:

```text
.erp-order.json
```

Batch export:

```text
.erp-order-batch.zip
```

The ZIP contains one `.erp-order.json` file per order.

Batch export selects orders by `orders.created_at::date` between `dateFrom`
and `dateTo`, inclusive.

## API

All routes are under the configured API prefix, normally `/api/v1`.

```text
GET  /orders/:orderId/snapshot
GET  /orders/snapshot/batch?dateFrom=YYYY-MM-DD&dateTo=YYYY-MM-DD
POST /orders/snapshot/import
POST /orders/snapshot/import-batch
```

Permissions:

- export routes require `orders.export`;
- import routes require `orders.import`;
- import routes also require `BACKEND_ORDERS_READ_ONLY=false`.

Feature/runtime requirements:

- `DATABASE_URL`;
- `BACKEND_ENABLE_ORDERS=true`;
- migration `backend/db/migrations/005_order_snapshot_import_mapping.sql`.

Batch import posts a base64 ZIP in JSON. The backend body limit is set to
`50mb` in `backend/src/main.ts`.

## Contract

Minimal shape:

```json
{
  "schema": "erp.order.snapshot.v1",
  "formatVersion": "1.0.0",
  "exporterService": {
    "name": "erp-order-snapshot",
    "version": "1.0.0",
    "compatibleImportVersions": ["1.0.0"]
  },
  "source": {
    "sourceInstanceId": "erp-backend:erp_stage",
    "exportedAt": "2026-05-11T10:00:00.000Z",
    "payloadHash": "sha256..."
  },
  "identity": {
    "order": { "sourceId": "11151", "refKey1c": null },
    "client": { "sourceId": "52", "refKey1c": null }
  },
  "data": {
    "client": {},
    "clientPhones": [],
    "order": {},
    "details": [],
    "payments": [],
    "workshops": [],
    "requirements": [],
    "dowelingOrders": [],
    "dowelingLinks": [],
    "productionStatusEvents": [],
    "deadlineInstances": [],
    "deadlineEvents": []
  },
  "references": {}
}
```

`payloadHash` is a SHA-256 hash of canonical JSON with
`source.exportedAt=null` and `source.payloadHash=null`. Import recalculates it
and returns `noop` when the same source order was already imported with the
same hash.

## Idempotency

Import does not reuse source numeric ids as local ids. Every imported entity is
matched by:

```text
sourceInstanceId + entityType + sourceId
```

The local mapping is stored in `order_import_entity_map`.

Repeated import of the same file:

- returns `noop` when `payloadHash` is unchanged;
- updates previously mapped rows when content changed;
- does not create duplicate orders/details/payments/client phones/events.

Concurrent import of the same source order is serialized with
`pg_advisory_xact_lock`.

## Included Data

The snapshot includes:

- `clients`;
- `client_phones`;
- `orders`;
- `order_details`;
- `payments`;
- `order_workshops`;
- `order_resource_requirements`;
- linked `doweling_orders`;
- `order_doweling_links`;
- `production_status_events`;
- `deadline_instances`;
- `deadline_events`.

Audit rows, outbox rows, notifications, and global reference catalogs are not
imported as order-owned data.

## Client Handling

Client is a shared dependency of the order, not a child row. Import resolves a
client in this order:

1. import map;
2. `clients.ref_key_1c`;
3. `clients.client_name`;
4. create a new client.

Client phones are imported idempotently by map/ref/phone number. Existing
unmapped phones of that client are not deleted.

## UI

Order show page:

- `JSON snapshot` downloads one `.erp-order.json`.

Order list page:

- `Выгрузка JSON` opens a date-range modal and downloads a batch ZIP;
- `Загрузка JSON` imports either one `.erp-order.json` or one batch ZIP.
