# How every code-graph MCP tool works, and why Plumbline saves 80% on tokens

Code knowledge graphs are not a new idea. Most of the tools below build one in some form. What actually matters is what each graph stores on its nodes, and how those nodes are connected to each other. That is where the token cost gap comes from when you start running real queries against your codebase.

**Repo:** https://github.com/ByteBell/bytebell-oss

---

## How the other tools do it

### claude-context (Zilliz)

Claude-context takes your code, chunks it up using Tree-sitter, and runs every chunk through an embedding model like OpenAI, Voyage, Gemini, or Ollama. The embeddings get stored in Milvus or Zilliz Cloud, and at query time it does a hybrid BM25 plus dense vector search. It works well when you want to find code that looks similar to some other code. The problem is that chunk embeddings cannot really answer call graph questions or anything that crosses repository boundaries, and in the default setup your code goes out to OpenAI and Zilliz Cloud every time you reindex.

### code-review-graph

This one parses your repository with Tree-sitter and stores the result in a SQLite graph with real call, inheritance, and test edges. It ships with 28 MCP tools, has solid blast-radius analysis built in, and can index 500 files in about ten seconds. For structural questions like who calls what, it is excellent. The README is upfront about the limitation though, which is that each node only carries the function signature, roughly ten tokens of information. So while it knows the structure of your code, it does not really know what any of it is for.

### graphtools

Graphify is a Claude Code skill that takes any folder, whether that is code, documents, PDFs, images, or videos, and turns it into a multi-modal knowledge graph. It uses Tree-sitter for the code, NetworkX for the graph itself, and Leiden community detection to cluster related nodes. It is MIT licensed and local first, and only sends semantic descriptions out to an LLM rather than your actual source. It is genuinely useful when you have a mixed corpus where docs and diagrams sit alongside code. The scope is limited to a single folder, and there is no cross-repository graph.

### GitNexus

GitNexus is interesting because it runs in the browser as WASM, or as a local CLI, and makes zero outbound network calls. It builds a code knowledge graph from Tree-sitter ASTs and stores it in LadybugDB. It is purely structural in the same way code-review-graph is, which means it has the same gap around understanding intent.

### CodeGraphContext

CodeGraphContext is both an MCP server and a CLI tool that indexes code into a graph database. You can pick your backend from Neo4j, LadybugDB, FalkorDB, or Nornic. It supports natural language queries about call chains and class hierarchies across fifteen languages, includes a multi-repo registry, ships with pre-indexed bundles for famous repositories, and has an interactive HTML visualizer. It is AST only though, with no business context layer on top.

### codegraph (colbymchenry)

This is a pre-indexed code knowledge graph for Claude Code that runs fully local and uses SQLite for storage. It auto-syncs through native OS file watchers with a two-second debounce, and ships with both a native module and a WASM fallback. It is lightweight and fast. AST only, no semantic layer.

### Understand-Anything

Understand-Anything is a Claude Code plugin that runs a multi-agent pipeline to extract every file, function, class, and dependency from your project into a JSON knowledge graph. You get a visual dashboard out of it, plus a domain view that maps your code to business processes as a horizontal graph, and auto-generated architecture walkthroughs. It is single project though, and there is no MCP server.

### code-grapher

Code-grapher builds a Neo4j knowledge graph from AST analysis, with an optional AI-powered description pass through Ollama or Gemini. It supports a PRIMER.md file to inject business context, and does surgical diff-based updates via git. Of all the AST tools, this is probably closest in spirit to what Plumbline does. The difference is that business context here is global and opt-in rather than per file and automatic.

### Deep Graph MCP (CodeGPT)

Deep Graph MCP is the hosted version of this idea. You point at any GitHub repository through deepgraph.co and you get a knowledge graph back as an MCP server. It is convenient for one-off exploration. The tradeoff is obvious, which is that your code lives in their cloud.

### Sourcegraph plus Cody

Sourcegraph operates at a completely different scale. They use compiler-level SCIP indexing with cross-repo navigation, and search across millions of repositories. The pricing is enterprise only at $59 per user per month or more, and the Free and Pro tiers were discontinued in 2025. It is precise but also language-bound, meaning every language needs its own SCIP indexer, and there is no semantic enrichment on any of the nodes.

### Augment Context Engine

Augment ships a proprietary semantic indexer with something they call Context Lineage, which tracks your commit history. Their MCP server lets any AI agent tap into the index, and they report 30 to 80 percent quality improvements on PR generation. The catch is that your source code lives on their SaaS infrastructure.

### CLAUDE.md

CLAUDE.md is not really a code intelligence tool, but a lot of people use it as one, so it is worth covering. It is a markdown file you put at the root of your repository that Claude Code reads at the start of every session. You write down your project conventions, key directories, common commands, and architectural notes, and Claude loads all of it as context. It is genuinely useful for telling Claude how to work on your project. The fundamental limitation is that it cannot scale to a real codebase. Anything over 200 lines starts consuming serious context budget and reduces how well Claude follows instructions. You cannot fit the structure of a 200,000 file repository into a markdown file, and even if you could, Claude would ignore most of it. The HumanLayer team published a detailed analysis showing that Claude Code actually injects a system reminder telling the model to ignore CLAUDE.md content that does not seem relevant to the current task. So you end up with persistent instructions that the model selectively listens to, and no real index of your code.

### Claude Skills

Skills are a different approach again. Instead of always-on context like CLAUDE.md, a skill is a markdown file in a skills folder that only loads when Claude decides it is relevant to your prompt. You can write a skill for any specific task, like database migrations or API design or running your test suite. Skills do solve the context bloat problem that CLAUDE.md has, because they are lazy loaded. But they are still just instructions, not an index. A skill cannot tell Claude where the retry policy lives in your codebase, or what files implement the order pipeline. You would have to know that yourself and write it into the skill. Skills and CLAUDE.md are great for telling Claude how to work, but they are not a substitute for actually understanding what your code does.

---

## How Plumbline does it

Plumbline builds a Neo4j graph too, so the architecture sounds similar on the surface. The difference is in what we put on each node, and how the nodes are connected to each other across repositories.

For every file in your codebase, an LLM generates a structured analysis at index time. You get a one-paragraph purpose explaining why the file exists, a longer summary covering what it does and how it fits into the architecture, a business context line that ties it to the product domain, plus the classes, functions, keywords, internal imports, and external imports it contains. All of that lives on the file node. The imports link to deduplicated module nodes, which means a question like "who imports parse_file" is just one Cypher hop. The semantic nodes for things like ontology concepts, business entities, contracts, and system capabilities are scoped to the entire organisation rather than to a single repository, so when two repos both reference the concept "authentication", they share the same node. That one design choice gives you a cross-repo dependency graph for free, with no special indexer required.

Every node also carries a commit hash and a SHA-256 of the file content. When you run a reindex, Plumbline compares hashes and only re-analyses the files whose content actually changed. The LLM cost ends up proportional to your actual code churn, not to the size of your repository. If you reindex a 200,000 file monorepo where 12 files changed in the last commit, that costs you 12 LLM calls, not 200,000.

This is where the 80 percent token savings actually comes from. Your AI assistant stops re-reading the same files at the start of every session. Instead of burning through roughly 38,900 tokens and 84 tool calls trying to answer a single cross-repo question, it pulls the pre-computed purpose, summary, business context, and import edges from the graph in milliseconds. Most well-formed questions resolve in two to four MCP tool calls and a small fraction of the tokens. On a test corpus of 500,000 files spread across 100 repositories, a complex cross-repo query that costs Claude Code on its own between $6 and $10 and takes three to five minutes will cost Plumbline plus Sonnet about $0.04 and finish in 30 to 40 seconds.

Everything runs on 127.0.0.1. There are no vectors involved, no embedding provider, and no cloud component. The only outbound call is to OpenRouter for the per-file LLM analysis, and if you want to route that to a local model instead, you can.

---

## The bottom line

We did not invent code knowledge graphs. What we built is one that carries business context, structural edges, cross-repo semantic links, and per-commit history on every node. That combination is what brings your AI coding token bill down by 80 percent or more.

**Repo:** https://github.com/ByteBell/bytebell-oss
**Website:** https://bytebell.ai
Free up to 1M tokens. $13 per user per month for 5M tokens.

## Sources

[pageindex]: https://github.com/VectifyAI/PageIndex
[gitnexus]: https://github.com/abhigyanpatwari/GitNexus
[graphrag]: https://github.com/microsoft/graphrag
[sourcegraph]: https://sourcegraph.com/docs/cody
[augment]: https://www.augmentcode.com/context-engine

- PageIndex — <https://github.com/VectifyAI/PageIndex>
- GitNexus — <https://github.com/abhigyanpatwari/GitNexus>
- Microsoft GraphRAG — <https://github.com/microsoft/graphrag>
- Sourcegraph Cody — <https://sourcegraph.com/docs/cody>
- Augment Code Context Engine — <https://www.augmentcode.com/context-engine>
