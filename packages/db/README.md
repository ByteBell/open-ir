# `@bb/db`

Provider registry and facade for the document database layer.

## Responsibilities

Maintains a map of named database providers, exposes a single `getDb()` accessor that delegates to whichever provider is active. Provides convenience facade objects (`knowledgeDb`, `rawDb`, `statsDb`, `activityDb`, `usageDb`, `enrichmentDb`) that proxy to the active provider's methods.

## Public Interfaces

- `registerDbProvider(name, factory)` — register a provider (called at import time by `@bb/sqlite`)
- `connectDb(providerName)` — instantiate and connect a provider
- `closeDb()` — close the active provider
- `getDb()` — returns the active `IDocumentDatabaseProvider`
- `knowledgeDb`, `rawDb`, `statsDb`, `activityDb`, `usageDb`, `enrichmentDb` — facade objects proxying to `getDb()`
- `pingDb()` — health probe

## Data Ownership

None. All I/O is delegated to the active provider.

## Tier

Strategy (consumer of `@bb/db-core`, consumed by domain and queue packages)
