# `worker/` — context

Queue worker registration.

| File          | Responsibility                                                         |
| ------------- | ---------------------------------------------------------------------- |
| `handler.ts`  | Runs `execute → store-graph` for each `BusinessContextProcessing` job. |
| `register.ts` | `registerBusinessContextWorker()` — called once by the deployable.     |

The handler re-reads the persisted analysis from disk between the disk and
graph phases so a future split into two queue jobs produces the same result
as the current inline flow.
