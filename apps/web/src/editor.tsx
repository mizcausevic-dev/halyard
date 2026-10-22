import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  Handle,
  Position,
  type Connection,
  type NodeChange,
  type NodeProps,
} from "@xyflow/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  NODE_HELP,
  NODE_TYPES,
  PORTS,
  connectionIssue,
  defaultNode,
  labelFor,
  layoutDocument,
  publishIssues,
  type NodeType,
  type WorkflowDocument,
  type WorkflowNode,
} from "@halyard/core";
import { api, errorMessage, previewMode } from "./api";

type SaveState = "saved" | "dirty" | "saving" | "error" | "conflict";

function newId(prefix: string): string {
  return `${prefix}${Math.random().toString(36).slice(2, 8)}`;
}

function HalyardNode({ data, selected }: NodeProps) {
  const node = data.node as WorkflowNode;
  const outputs = PORTS[node.type].filter((port) => port.direction === "out");
  const inputs = PORTS[node.type].filter((port) => port.direction === "in");
  return (
    <article className={selected ? "node is-selected" : "node"}>
      {inputs.map((port) => (
        <Handle key={port.id} id={port.id} type="target" position={Position.Left} />
      ))}
      <header>
        <span>{labelFor(node.type)}</span>
        <strong>{node.name}</strong>
      </header>
      {outputs.map((port, index) => (
        <Handle
          key={port.id}
          id={port.id}
          type="source"
          position={Position.Right}
          style={{ top: outputs.length === 1 ? "50%" : `${32 + index * 18}px` }}
        />
      ))}
    </article>
  );
}

const nodeTypes = { halyard: HalyardNode };

export function Editor({ workspaceId, workflowId }: { workspaceId: string; workflowId: string }) {
  const navigate = useNavigate();
  const [doc, setDoc] = useState<WorkflowDocument | null>(null);
  const [past, setPast] = useState<WorkflowDocument[]>([]);
  const [future, setFuture] = useState<WorkflowDocument[]>([]);
  const [revision, setRevision] = useState(1);
  const [save, setSave] = useState<SaveState>("saved");
  const [saveError, setSaveError] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [versions, setVersions] = useState<Array<Record<string, unknown>>>([]);
  const [runBody, setRunBody] = useState("{\n}\n");
  const [credentials, setCredentials] = useState<Array<{ id: string; name: string }>>([]);
  const dragOrigin = useRef<WorkflowDocument | null>(null);
  const revisionRef = useRef(1);
  const skipSave = useRef(true);

  useEffect(() => {
    void (async () => {
      const [workflow, creds] = await Promise.all([
        api<any>(`/api/workspaces/${workspaceId}/workflows/${workflowId}`),
        api<any>(`/api/workspaces/${workspaceId}/credentials`),
      ]);
      if (workflow.status !== 200) return;
      setDoc(workflow.body.draft.document);
      setRevision(workflow.body.draft.revision);
      revisionRef.current = workflow.body.draft.revision;
      const sample = workflow.body.draft.document.nodes.find((node: WorkflowNode) => node.type === "manual_trigger")?.config?.samplePayload;
      if (sample) setRunBody(JSON.stringify(sample, null, 2));
      if (creds.status === 200) setCredentials(creds.body.credentials ?? []);
      skipSave.current = true;
    })();
  }, [workspaceId, workflowId]);

  function commit(next: WorkflowDocument) {
    if (!doc) return;
    setPast((items) => [...items, doc].slice(-50));
    setFuture([]);
    setDoc(next);
    setSave("dirty");
  }

  useEffect(() => {
    if (!doc || skipSave.current) {
      skipSave.current = false;
      return;
    }
    if (save !== "dirty") return;
    const handle = window.setTimeout(() => {
      void (async () => {
        setSave("saving");
        const result = await api<any>(`/api/workspaces/${workspaceId}/workflows/${workflowId}/draft`, {
          method: "PUT",
          body: { document: doc, expectedRevision: revisionRef.current },
        });
        if (result.status === 200) {
          revisionRef.current = result.body.revision;
          setRevision(result.body.revision);
          setSave("saved");
          setSaveError("");
          return;
        }
        if (result.status === 409) {
          setSave("conflict");
          setSaveError(errorMessage(result.body, "The draft changed somewhere else."));
          return;
        }
        setSave("error");
        setSaveError(errorMessage(result.body, "Save failed."));
      })();
    }, 700);
    return () => window.clearTimeout(handle);
  }, [doc, save, workspaceId, workflowId]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;
      const meta = event.metaKey || event.ctrlKey;
      if (meta && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
      } else if (meta && event.key.toLowerCase() === "s") {
        event.preventDefault();
        setSave("dirty");
      } else if ((event.key === "Delete" || event.key === "Backspace") && selected) {
        event.preventDefault();
        removeNode(selected);
      } else if (selected && ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key) && doc) {
        event.preventDefault();
        const delta = event.shiftKey ? 20 : 8;
        const dx = event.key === "ArrowLeft" ? -delta : event.key === "ArrowRight" ? delta : 0;
        const dy = event.key === "ArrowUp" ? -delta : event.key === "ArrowDown" ? delta : 0;
        commit({
          ...doc,
          nodes: doc.nodes.map((node) => node.id === selected ? { ...node, position: { x: node.position.x + dx, y: node.position.y + dy } } : node),
        });
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  function undo() {
    setPast((items) => {
      const previous = items[items.length - 1];
      if (!previous || !doc) return items;
      setFuture((next) => [doc, ...next]);
      setDoc(previous);
      setSave("dirty");
      return items.slice(0, -1);
    });
  }
  function redo() {
    setFuture((items) => {
      const next = items[0];
      if (!next || !doc) return items;
      setPast((history) => [...history, doc]);
      setDoc(next);
      setSave("dirty");
      return items.slice(1);
    });
  }

  const issues = useMemo(() => (doc ? publishIssues(doc) : []), [doc]);
  const selectedNode = doc?.nodes.find((node) => node.id === selected) ?? null;

  function patchNode(id: string, updater: (node: WorkflowNode) => WorkflowNode) {
    if (!doc) return;
    commit({ ...doc, nodes: doc.nodes.map((node) => (node.id === id ? updater(node) : node)) });
  }
  function removeNode(id: string) {
    if (!doc) return;
    commit({
      ...doc,
      nodes: doc.nodes.filter((node) => node.id !== id && node.iterationParent !== id),
      edges: doc.edges.filter((edge) => edge.source !== id && edge.target !== id),
    });
    setSelected(null);
  }
  function addNode(type: NodeType) {
    if (!doc) return;
    const id = newId("n");
    const node = defaultNode(type, id, { x: 80 + doc.nodes.length * 24, y: 80 + doc.nodes.length * 16 });
    commit({ ...doc, nodes: [...doc.nodes, node] });
    setSelected(id);
  }
  function connect(source: string, sourcePort: string, target: string, targetPort: string) {
    if (!doc) return;
    const issue = connectionIssue(doc, { source, sourcePort, target, targetPort });
    if (issue) {
      setNotice(issue.message);
      return;
    }
    commit({ ...doc, edges: [...doc.edges, { id: newId("e"), source, sourcePort, target, targetPort }] });
    setNotice("");
  }

  if (!doc) return <p className="page">Loading draft…</p>;

  const flowNodes = doc.nodes.map((node) => ({
    id: node.id,
    type: "halyard",
    position: node.position,
    data: { node },
    selected: node.id === selected,
  }));
  const flowEdges = doc.edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    sourceHandle: edge.sourcePort,
    targetHandle: edge.targetPort,
    label: edge.sourcePort === "true" || edge.sourcePort === "false" ? edge.sourcePort : undefined,
  }));

  return (
    <section className="editor">
      <div className="toolbar">
        <input aria-label="Workflow name" value={doc.name} onChange={(event) => commit({ ...doc, name: event.target.value })} />
        <span className={`pill ${save}`} role="status">{save === "saved" ? `Saved r${revision}` : save === "saving" ? "Saving" : save === "conflict" ? "Conflict" : save === "error" ? "Save failed" : "Unsaved"}</span>
        <button className="btn" type="button" onClick={undo} disabled={past.length === 0}>Undo</button>
        <button className="btn" type="button" onClick={redo} disabled={future.length === 0}>Redo</button>
        <button className="btn" type="button" onClick={() => commit(layoutDocument(doc))}>Auto layout</button>
        <button className="btn" type="button" onClick={() => void loadVersions()}>Versions</button>
        <button className="btn-primary btn" type="button" onClick={() => void publish()}>Publish</button>
        <button className="btn" type="button" onClick={() => void run()}>Run now</button>
        <Link to={`/w/${workspaceId}/workflows`}>Directory</Link>
      </div>
      <ReactFlowProvider>
        <div className="canvas">
          <ReactFlow
            nodes={flowNodes}
            edges={flowEdges}
            nodeTypes={nodeTypes}
            fitView
            minZoom={0.25}
            maxZoom={1.6}
            onNodeClick={(_, node) => setSelected(node.id)}
            onPaneClick={() => setSelected(null)}
            onNodeDragStart={() => { dragOrigin.current = doc; }}
            onNodesChange={(changes: NodeChange[]) => {
              const positions = changes.flatMap((change) => (change.type === "position" && change.position ? [change] : []));
              if (positions.length === 0) return;
              setDoc({
                ...doc,
                nodes: doc.nodes.map((node) => {
                  const change = positions.find((item) => item.id === node.id);
                  return change?.position ? { ...node, position: change.position } : node;
                }),
              });
            }}
            onNodeDragStop={() => {
              if (!dragOrigin.current) return;
              setPast((items) => [...items, dragOrigin.current as WorkflowDocument].slice(-50));
              setFuture([]);
              setSave("dirty");
              dragOrigin.current = null;
            }}
            onConnect={(connection: Connection) => {
              if (!connection.source || !connection.target || !connection.sourceHandle || !connection.targetHandle) return;
              connect(connection.source, connection.sourceHandle, connection.target, connection.targetHandle);
            }}
            isValidConnection={(connection) => {
              if (!connection.source || !connection.target || !connection.sourceHandle || !connection.targetHandle) return false;
              return connectionIssue(doc, {
                source: connection.source,
                sourcePort: connection.sourceHandle,
                target: connection.target,
                targetPort: connection.targetHandle,
              }) === null;
            }}
          >
            <Background />
            <Controls showInteractive={false} />
            <MiniMap pannable zoomable />
          </ReactFlow>
        </div>
      </ReactFlowProvider>
      <aside className="inspector">
        <div className="stack">
          {previewMode ? <p className="banner">Preview runs use the in-browser semantic runner. They are not durable jobs. The PostgreSQL worker is what survives a restart.</p> : null}
          {saveError ? <p className="banner" role="alert">{saveError} <button className="btn" type="button" onClick={() => window.location.reload()}>Reload server draft</button></p> : null}
          {notice ? <p className="banner" role="status">{notice}</p> : null}
          <div className="issues">
            {issues.length === 0 ? <p className="muted">Publish checks are clear.</p> : issues.map((issue, index) => (
              <button key={`${issue.code}-${index}`} type="button" onClick={() => issue.nodeId && setSelected(issue.nodeId)}>
                {issue.level}: {issue.message}
              </button>
            ))}
          </div>
          {selectedNode ? (
            <NodeForm
              node={selectedNode}
              credentials={credentials}
              onChange={(node) => patchNode(node.id, () => node)}
              onDelete={() => removeNode(selectedNode.id)}
            />
          ) : <p className="muted">Select a node, or use the keyboard panel to add and connect without dragging.</p>}
          {versions.length > 0 ? (
            <div className="stack">
              <strong>Versions</strong>
              {versions.map((version) => (
                <div key={String(version.id)} className="row">
                  <span className="mono">{String(version.status)} {String(version.version_number)}</span>
                  {version.status === "published" ? <button className="btn" type="button" onClick={() => void restore(String(version.id))}>Restore into draft</button> : null}
                </div>
              ))}
            </div>
          ) : null}
          <label className="field">Run payload
            <textarea aria-label="Run payload" rows={8} value={runBody} onChange={(event) => setRunBody(event.target.value)} />
          </label>
        </div>
      </aside>
      <div className="keyboard">
        <KeyboardBar
          doc={doc}
          selected={selected}
          onAdd={addNode}
          onConnect={connect}
          onDelete={() => selected && removeNode(selected)}
          onNudge={(dx, dy) => selected && commit({
            ...doc,
            nodes: doc.nodes.map((node) => node.id === selected ? { ...node, position: { x: node.position.x + dx, y: node.position.y + dy } } : node),
          })}
        />
      </div>
    </section>
  );

  async function loadVersions() {
    const result = await api<any>(`/api/workspaces/${workspaceId}/workflows/${workflowId}/versions`);
    if (result.status === 200) setVersions(result.body.versions);
  }
  async function restore(versionId: string) {
    const result = await api<any>(`/api/workspaces/${workspaceId}/workflows/${workflowId}/restore`, {
      method: "POST",
      body: { versionId, expectedRevision: revisionRef.current },
    });
    if (result.status === 200) {
      skipSave.current = true;
      setDoc(result.body.document);
      revisionRef.current = result.body.revision;
      setRevision(result.body.revision);
      setSave("saved");
    } else setNotice(errorMessage(result.body, "Restore failed."));
  }
  async function publish() {
    const result = await api<any>(`/api/workspaces/${workspaceId}/workflows/${workflowId}/publish`, { method: "POST", body: {} });
    if (result.status === 200) {
      const warnings = (result.body.warnings ?? []).map((issue: { message: string }) => issue.message).join(" ");
      setNotice(warnings ? `Published version ${result.body.versionNumber}. ${warnings}` : `Published version ${result.body.versionNumber}.`);
      return;
    }
    setNotice(errorMessage(result.body, "Publish failed."));
  }
  async function run() {
    let payload: unknown = {};
    try {
      payload = runBody.trim() ? JSON.parse(runBody) : {};
    } catch {
      setNotice("Run payload is not valid JSON.");
      return;
    }
    const result = await api<any>(`/api/workspaces/${workspaceId}/workflows/${workflowId}/run`, { method: "POST", body: { payload } });
    if (result.status === 202) navigate(`/w/${workspaceId}/runs/${result.body.runId}`);
    else setNotice(errorMessage(result.body, "Run did not start."));
  }
}

function KeyboardBar({ doc, selected, onAdd, onConnect, onDelete, onNudge }: {
  doc: WorkflowDocument;
  selected: string | null;
  onAdd: (type: NodeType) => void;
  onConnect: (source: string, sourcePort: string, target: string, targetPort: string) => void;
  onDelete: () => void;
  onNudge: (dx: number, dy: number) => void;
}) {
  const [type, setType] = useState<NodeType>("output");
  const [source, setSource] = useState(selected ?? doc.nodes[0]?.id ?? "");
  const [sourcePort, setSourcePort] = useState("out");
  const [target, setTarget] = useState(doc.nodes[1]?.id ?? "");
  const [targetPort, setTargetPort] = useState("in");
  const sourceNode = doc.nodes.find((node) => node.id === source);
  const targetNode = doc.nodes.find((node) => node.id === target);
  return (
    <div className="row" aria-label="Keyboard editing">
      <label className="field">Add node
        <select aria-label="Node type" value={type} onChange={(event) => setType(event.target.value as NodeType)}>
          {NODE_TYPES.map((item) => <option key={item} value={item}>{labelFor(item)}</option>)}
        </select>
      </label>
      <button className="btn" type="button" onClick={() => onAdd(type)}>Add</button>
      <button className="btn" type="button" onClick={() => onNudge(-16, 0)} disabled={!selected}>Left</button>
      <button className="btn" type="button" onClick={() => onNudge(16, 0)} disabled={!selected}>Right</button>
      <button className="btn" type="button" onClick={() => onNudge(0, -16)} disabled={!selected}>Up</button>
      <button className="btn" type="button" onClick={() => onNudge(0, 16)} disabled={!selected}>Down</button>
      <button className="btn-danger btn" type="button" onClick={onDelete} disabled={!selected}>Delete</button>
      <label className="field">From
        <select aria-label="Source node" value={source} onChange={(event) => setSource(event.target.value)}>
          {doc.nodes.map((node) => <option key={node.id} value={node.id}>{node.name}</option>)}
        </select>
      </label>
      <label className="field">Port
        <select aria-label="Source port" value={sourcePort} onChange={(event) => setSourcePort(event.target.value)}>
          {(sourceNode ? PORTS[sourceNode.type] : []).filter((port) => port.direction === "out").map((port) => <option key={port.id}>{port.id}</option>)}
        </select>
      </label>
      <label className="field">To
        <select aria-label="Target node" value={target} onChange={(event) => setTarget(event.target.value)}>
          {doc.nodes.map((node) => <option key={node.id} value={node.id}>{node.name}</option>)}
        </select>
      </label>
      <label className="field">Port
        <select aria-label="Target port" value={targetPort} onChange={(event) => setTargetPort(event.target.value)}>
          {(targetNode ? PORTS[targetNode.type] : []).filter((port) => port.direction === "in").map((port) => <option key={port.id}>{port.id}</option>)}
        </select>
      </label>
      <button className="btn" type="button" onClick={() => onConnect(source, sourcePort, target, targetPort)}>Connect</button>
    </div>
  );
}

function NodeForm({ node, credentials, onChange, onDelete }: {
  node: WorkflowNode;
  credentials: Array<{ id: string; name: string }>;
  onChange: (node: WorkflowNode) => void;
  onDelete: () => void;
}) {
  function config(next: WorkflowNode["config"]) {
    onChange({ ...node, config: next } as WorkflowNode);
  }
  return (
    <div className="stack">
      <p className="muted">{NODE_HELP[node.type]}</p>
      <label className="field">Name
        <input aria-label="Node name" value={node.name} onChange={(event) => onChange({ ...node, name: event.target.value })} />
      </label>
      {node.type === "manual_trigger" ? (
        <label className="field">Sample payload
          <textarea rows={6} value={JSON.stringify(node.config.samplePayload ?? {}, null, 2)} onChange={(event) => {
            try { config({ samplePayload: JSON.parse(event.target.value) }); } catch { /* keep typing */ }
          }} />
        </label>
      ) : null}
      {node.type === "schedule_trigger" ? (
        <>
          <label className="field">Cron<input value={node.config.cron} onChange={(event) => config({ ...node.config, cron: event.target.value })} /></label>
          <label className="field">IANA timezone<input value={node.config.timezone} onChange={(event) => config({ ...node.config, timezone: event.target.value })} /></label>
          <label className="field">Missed run
            <select value={node.config.missedPolicy} onChange={(event) => config({ ...node.config, missedPolicy: event.target.value as "skip" | "catch_up_once" })}>
              <option value="skip">skip</option>
              <option value="catch_up_once">catch_up_once</option>
            </select>
          </label>
        </>
      ) : null}
      {node.type === "webhook_trigger" ? (
        <>
          <label className="field">Auth
            <select value={node.config.authMode} onChange={(event) => config({ ...node.config, authMode: event.target.value as "none" | "shared_secret" | "hmac_sha256" })}>
              <option value="shared_secret">shared secret</option>
              <option value="hmac_sha256">HMAC SHA-256</option>
              <option value="none">none</option>
            </select>
          </label>
          <CredentialSelect credentials={credentials} value={node.config.credentialId} onChange={(credentialId) => config({ ...node.config, ...(credentialId ? { credentialId } : {}) })} />
          <label className="field">Event id path<input value={node.config.eventIdPath ?? ""} onChange={(event) => config({ ...node.config, eventIdPath: event.target.value })} /></label>
          <label className="field">Rate per minute<input type="number" value={node.config.rateLimitPerMinute ?? 60} onChange={(event) => config({ ...node.config, rateLimitPerMinute: Number(event.target.value) })} /></label>
        </>
      ) : null}
      {node.type === "http_request" ? (
        <>
          <label className="field">Method
            <select value={node.config.method} onChange={(event) => config({ ...node.config, method: event.target.value as "GET" })}>
              {["GET", "POST", "PUT", "PATCH", "DELETE"].map((method) => <option key={method}>{method}</option>)}
            </select>
          </label>
          <label className="field">URL<input value={node.config.url} onChange={(event) => config({ ...node.config, url: event.target.value })} /></label>
          <label className="row"><input type="checkbox" checked={node.config.retryable === true} onChange={(event) => config({ ...node.config, retryable: event.target.checked })} /> Retry on 408, 429, and 5xx</label>
          <p className="muted">Retries can repeat the side effect. An idempotency key only helps when the destination stores it.</p>
          <CredentialSelect credentials={credentials} value={node.config.credentialId} onChange={(credentialId) => config({ ...node.config, ...(credentialId ? { credentialId } : {}) })} />
        </>
      ) : null}
      {node.type === "condition" ? <p className="mono">{JSON.stringify(node.config.expr)}</p> : null}
      {node.type === "iterate" ? (
        <>
          <label className="field">Max items<input type="number" value={node.config.maxItems} onChange={(event) => config({ ...node.config, maxItems: Number(event.target.value) })} /></label>
          <p className="mono">{JSON.stringify(node.config.arrayExpr)}</p>
        </>
      ) : null}
      {node.type === "delay" ? (
        <label className="field">Duration ms<input type="number" value={node.config.durationMs} onChange={(event) => config({ ...node.config, durationMs: Number(event.target.value) })} /></label>
      ) : null}
      {node.type === "merge" ? (
        <label className="field">Mode
          <select value={node.config.mode} onChange={(event) => config({ mode: event.target.value as "all" | "first_success" })}>
            <option value="all">all, including skipped branches</option>
            <option value="first_success">first success in edge order</option>
          </select>
        </label>
      ) : null}
      {node.type === "output" ? (
        <>
          <label className="field">Message<input value={node.config.message} onChange={(event) => config({ ...node.config, message: event.target.value })} /></label>
          <label className="field">Classification
            <select value={node.config.classification ?? "log"} onChange={(event) => config({ ...node.config, classification: event.target.value as "log" })}>
              <option value="log">log</option>
              <option value="accepted">accepted</option>
              <option value="rejected">rejected</option>
            </select>
          </label>
        </>
      ) : null}
      {node.type === "map_fields" ? <p className="mono">{node.config.mappings.map((mapping) => mapping.key).join(", ") || "No mappings"}</p> : null}
      <button className="btn-danger btn" type="button" onClick={onDelete}>Delete node</button>
    </div>
  );
}

function CredentialSelect({ credentials, value, onChange }: { credentials: Array<{ id: string; name: string }>; value?: string; onChange: (id: string) => void }) {
  return (
    <label className="field">Credential
      <select value={value ?? ""} onChange={(event) => onChange(event.target.value)}>
        <option value="">None</option>
        {credentials.map((credential) => <option key={credential.id} value={credential.id}>{credential.name}</option>)}
      </select>
    </label>
  );
}
