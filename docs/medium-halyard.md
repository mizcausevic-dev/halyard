# Durable Workflow Automation for People Who Have Been Burned by Retries

**Subtitle:** Halyard is a visual editor and a PostgreSQL worker. It will run the graph. It will not promise that a side effect happened once.

If you have ever operated a workflow tool, you already know the bad minute. The HTTP call reached the other system. The process died before the run was marked complete. The queue delivered the job again. The second call also succeeded. Your dashboard says the workflow ran once. The other system's ledger says it ran twice.

That minute is the whole product brief for Halyard.

Halyard is a durable workflow runner. You draw a directed graph, publish an immutable version, and a worker executes that version from PostgreSQL. A run stays pinned to the version it started on. The editor can keep changing. The in-flight run does not follow it.

The public source is [github.com/mizcausevic-dev/halyard](https://github.com/mizcausevic-dev/halyard). The static preview is on the `gh-pages` branch. The preview can show the editor and replay the semantic runner in the browser. It does not start the worker, and it does not open outbound sockets.

Read the full article in this file. The execution contract is in docs/EXECUTION_CONTRACT.md.
