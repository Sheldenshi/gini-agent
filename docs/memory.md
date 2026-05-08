# Memory

Gini memory is visible, governable, and local by default.

Memory records live in `~/.gini/instances/<instance>/memory.db` using SQLite. The model cache for local embeddings and reranking lives in `~/.gini/models/`.

## Memory Operations

- **Retain:** write a memory unit with source/provenance metadata.
- **Recall:** retrieve relevant memory with semantic, lexical, graph, and temporal signals.
- **Reflect:** propose higher-level memory from existing evidence.
- **Reinforce:** update strength and relationships as memories are used.
- **Review:** edit, approve, reject, or archive memory records.

## Recall Pipeline

Recall fuses four channels:

- semantic vector search
- BM25/lexical search
- graph spreading activation
- temporal recency and cadence

Results are combined with reciprocal rank fusion, reranked over the top candidates, and packed into a token budget.

## Embeddings

Providers:

- `local` by default: Transformers.js with `Xenova/all-MiniLM-L6-v2`
- `openai`: `text-embedding-3-small`
- `echo`: deterministic test provider

Useful commands:

```sh
bun run gini embedding status
bun run gini embedding reembed
```

Environment overrides:

```sh
GINI_EMBEDDING_PROVIDER=local|openai|echo
GINI_LOCAL_EMBEDDING_MODEL=<hf-id>
```

Different embedding models use different vector spaces. Switching providers does not destroy existing memories, but semantic recall only uses memory units embedded by the active model until they are re-embedded.

## Reranker

Providers:

- `local` by default: Transformers.js with `Xenova/ms-marco-MiniLM-L-6-v2`
- `echo`: deterministic test provider
- `none`: skip cross-encoder reranking

Useful commands:

```sh
bun run gini reranker status
```

Environment overrides:

```sh
GINI_RERANKER_PROVIDER=local|echo|none
GINI_LOCAL_RERANKER_MODEL=<hf-id>
GINI_RERANKER_TOP_N=<int>
```

Smoke tests pin echo providers so parallel smoke runs and CI do not download models.

## Current Surfaces

- `gini memory list/add/edit/approve/reject/archive`
- `/api/memory`
- `/api/banks`
- `/api/memory/recall`
- `/api/memory/reflect`
- `/api/memory/migrate`
- web Memory page

## Direction

Memory should become more useful without becoming hidden magic. Future work should improve contradiction handling, compaction, bank governance, provenance, and review workflows.
