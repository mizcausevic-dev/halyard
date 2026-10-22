import { FormEvent, useEffect, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, errorMessage, previewMode } from "./api";

export function Login() {
  const navigate = useNavigate();
  const [email, setEmail] = useState(previewMode ? "ada@halyard.dev" : "");
  const [password, setPassword] = useState(previewMode ? "halyard-dev-password" : "");
  const [error, setError] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    const result = await api<any>("/api/auth/login", { method: "POST", body: { email, password } });
    if (result.status !== 200) {
      setError(errorMessage(result.body, "Sign-in failed."));
      return;
    }
    const me = await api<any>("/api/me");
    const workspace = me.body.workspaces?.[0]?.id;
    if (!workspace) {
      setError("This account has no workspace.");
      return;
    }
    navigate(`/w/${workspace}`);
  }
  return (
    <main className="login">
      <section className="login-copy">
        <p className="kicker">Halyard</p>
        <h1>Directed work, pinned to the version that ran.</h1>
        <p>Publish an acyclic graph. A run keeps that version. Conditions take one branch. Iteration is a bounded node, not a back-edge. HTTP calls are at-least-once unless you turn retries on, and even then the destination has to honor an idempotency key.</p>
        <p className="muted">No user JavaScript runs in this process. Expressions are a closed JSON language with step and depth limits.</p>
      </section>
      <form className="login-form" onSubmit={(event) => void submit(event)}>
        <h2>Sign in</h2>
        {previewMode ? <p className="banner">This GitHub Pages build is a preview. The password below signs into recorded workflows and the in-browser runner. It does not start the PostgreSQL worker.</p> : null}
        <label className="field">Email
          <input data-testid="login-email" autoComplete="username" value={email} onChange={(event) => setEmail(event.target.value)} />
        </label>
        <label className="field">Password
          <input data-testid="login-password" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} />
        </label>
        {error ? <p role="alert">{error}</p> : null}
        <button className="btn btn-primary" data-testid="login-submit" type="submit">Enter workspace</button>
      </form>
    </main>
  );
}

export function Dashboard({ workspaceId }: { workspaceId: string }) {
  const [data, setData] = useState<any>(null);
  useEffect(() => {
    void api<any>(`/api/workspaces/${workspaceId}/dashboard`).then((result) => setData(result.body));
  }, [workspaceId]);
  if (!data) return <p>Loading workspace…</p>;
  return (
    <div className="page">
      <div className="cards">
        <article className="card"><span>Workflows</span><strong>{data.workflowCount}</strong></article>
        <article className="card"><span>Runs, 7 days</span><strong>{(data.runCounts ?? []).reduce((sum: number, row: { count: number }) => sum + Number(row.count), 0)}</strong></article>
        <article className="card"><span>Enabled schedules</span><strong>{(data.schedules ?? []).length}</strong></article>
      </div>
      <div className="grid">
        <section className="table-wrap">
          <table>
            <thead><tr><th>Run</th><th>Workflow</th><th>State</th></tr></thead>
            <tbody>
              {(data.recentRuns ?? []).map((run: any) => (
                <tr key={run.id}>
                  <td><Link to={`/w/${workspaceId}/runs/${run.id}`}>{String(run.id).slice(0, 8)}</Link></td>
                  <td>{run.workflowName}</td>
                  <td><span className={`pill ${run.status}`}>{run.status}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
        <section className="panel stack">
          <h2>What this is</h2>
          <p>Halyard is a self-hosted runner for directed workflows. The people using it are developers and operators who need to see the input and output of every step.</p>
          <p>It wins by making the execution rules explicit: one trigger, no cycles, one condition branch, bounded iteration, durable delays, and no promise of exactly-once side effects.</p>
          <p>Structure is a draft, immutable published versions, a Postgres queue, and a worker. Discovery here is the directory. Engagement is the editor. Conversion is publish, then run. This build does not bill anyone.</p>
          <p>Launch it as two processes plus Postgres. After launch, read failed runs and <span className="mono">uncertain_outcome</span> steps before changing retry policy.</p>
        </section>
      </div>
    </div>
  );
}

export function WorkflowList({ workspaceId }: { workspaceId: string }) {
  const [rows, setRows] = useState<any[]>([]);
  const [name, setName] = useState("");
  const [message, setMessage] = useState("");
  async function load() {
    const result = await api<any>(`/api/workspaces/${workspaceId}/workflows`);
    setRows(result.body.workflows ?? []);
  }
  useEffect(() => { void load(); }, [workspaceId]);
  return (
    <div className="page">
      <form className="row" onSubmit={(event) => {
        event.preventDefault();
        void api(`/api/workspaces/${workspaceId}/workflows`, { method: "POST", body: { name, description: "" } }).then(() => { setName(""); return load(); });
      }}>
        <label className="field">New workflow<input aria-label="New workflow name" value={name} onChange={(event) => setName(event.target.value)} /></label>
        <button className="btn btn-primary" type="submit">Create</button>
        <label className="btn">Import JSON
          <input aria-label="Import workflow JSON" type="file" accept="application/json" hidden onChange={(event) => {
            const file = event.target.files?.[0];
            if (!file) return;
            void file.text().then(async (text) => {
              const result = await api<any>(`/api/workspaces/${workspaceId}/workflows/import`, { method: "POST", body: { document: JSON.parse(text) } });
              if (result.status === 201) await load();
              else setMessage(errorMessage(result.body, "Import rejected."));
            });
          }} />
        </label>
      </form>
      {message ? <p role="alert">{message}</p> : null}
      <div className="table-wrap">
        <table>
          <thead><tr><th>Name</th><th>Published</th><th>Draft</th></tr></thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td><Link data-testid={`workflow-${row.slug}`} to={`/w/${workspaceId}/workflows/${row.id}`}>{row.name}</Link><div className="muted">{row.description}</div></td>
                <td>{row.published_version ? `v${row.published_version}` : "Unpublished"}</td>
                <td className="mono">r{row.draft_revision}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function RunList({ workspaceId }: { workspaceId: string }) {
  const [rows, setRows] = useState<any[]>([]);
  useEffect(() => {
    void api<any>(`/api/workspaces/${workspaceId}/runs`).then((result) => setRows(result.body.runs ?? []));
  }, [workspaceId]);
  return (
    <div className="page">
      <div className="table-wrap">
        <table>
          <thead><tr><th>When</th><th>Workflow</th><th>Trigger</th><th>State</th></tr></thead>
          <tbody>
            {rows.map((run) => (
              <tr key={run.id}>
                <td className="mono">{String(run.queuedAt ?? "").slice(0, 19)}</td>
                <td><Link to={`/w/${workspaceId}/runs/${run.id}`}>{run.workflowName}</Link></td>
                <td>{run.triggerType}</td>
                <td><span className={`pill ${run.status}`}>{run.status}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function RunDetail({ workspaceId, runId }: { workspaceId: string; runId: string }) {
  const [data, setData] = useState<any>(null);
  const [selected, setSelected] = useState<string | null>(null);
  async function load() {
    const result = await api<any>(`/api/workspaces/${workspaceId}/runs/${runId}`);
    if (result.status === 200) setData(result.body);
  }
  useEffect(() => { void load(); }, [workspaceId, runId]);
  useEffect(() => {
    if (!data?.run || !["queued", "running", "waiting"].includes(data.run.status)) return;
    const timer = window.setInterval(() => void load(), 1000);
    return () => window.clearInterval(timer);
  }, [data?.run?.status, workspaceId, runId]);
  if (!data) return <p>Loading run…</p>;
  const step = (data.steps ?? []).find((item: { nodeId: string }) => item.nodeId === selected) ?? data.steps?.[0];
  return (
    <div className="page">
      <div className="row">
        <h2 style={{ margin: 0 }}>{data.run.workflowName}</h2>
        <span className={`pill ${data.run.status}`}>{data.run.status}</span>
        <span className="mono">version {data.run.versionNumber}</span>
        {["queued", "running", "waiting"].includes(data.run.status) ? (
          <button className="btn btn-danger" type="button" onClick={() => void api(`/api/workspaces/${workspaceId}/runs/${runId}/cancel`, { method: "POST", body: {} }).then(load)}>Cancel</button>
        ) : null}
      </div>
      {data.run.error ? <p className="banner">{data.run.error.message}</p> : null}
      {data.run.payloadRestricted ? <p className="banner">Your role can see status, not payloads.</p> : null}
      <div className="split">
        <div className="table-wrap">
          <table>
            <thead><tr><th>Node</th><th>State</th><th>Attempts</th></tr></thead>
            <tbody>
              {data.steps.map((item: any) => (
                <tr key={item.id}>
                  <td><button className="btn-ghost" type="button" onClick={() => setSelected(item.nodeId)}>{item.nodeId}</button></td>
                  <td><span className={`pill ${item.status}`}>{item.status}</span></td>
                  <td>{item.attempt}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <article className="panel stack">
          {step ? (
            <>
              <h3 style={{ margin: 0 }}>{step.nodeId}</h3>
              <p className="muted">{step.nodeType} · started {String(step.startedAt ?? "not started")} · finished {String(step.finishedAt ?? "not finished")}</p>
              {step.error ? <p role="alert">{step.error.code}: {step.error.message}</p> : null}
              <strong>Input</strong>
              <pre>{JSON.stringify(step.input, null, 2)}</pre>
              <strong>Output</strong>
              <pre data-testid="step-output">{JSON.stringify(step.output, null, 2)}</pre>
            </>
          ) : <p>No steps were recorded.</p>}
        </article>
      </div>
    </div>
  );
}

export function Credentials({ workspaceId }: { workspaceId: string }) {
  const [rows, setRows] = useState<any[]>([]);
  const [form, setForm] = useState({ name: "", kind: "shared_secret", value: "" });
  const [message, setMessage] = useState("");
  async function load() {
    const result = await api<any>(`/api/workspaces/${workspaceId}/credentials`);
    if (result.status === 200) setRows(result.body.credentials ?? []);
    else setMessage(errorMessage(result.body, "Credentials are restricted."));
  }
  useEffect(() => { void load(); }, [workspaceId]);
  return (
    <div className="page">
      <p>Secrets stay encrypted on the server. Workflow JSON stores the credential id. This screen never shows the secret again.</p>
      <form className="row" onSubmit={(event) => {
        event.preventDefault();
        void api(`/api/workspaces/${workspaceId}/credentials`, { method: "POST", body: form }).then(async (result) => {
          if (result.status === 201) {
            setForm({ name: "", kind: "shared_secret", value: "" });
            await load();
          } else setMessage(errorMessage(result.body, "Could not store the credential."));
        });
      }}>
        <label className="field">Name<input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label>
        <label className="field">Kind
          <select value={form.kind} onChange={(event) => setForm({ ...form, kind: event.target.value })}>
            <option value="shared_secret">shared secret</option>
            <option value="hmac">HMAC</option>
            <option value="bearer">bearer</option>
            <option value="header">header</option>
            <option value="basic">basic</option>
          </select>
        </label>
        <label className="field">Secret<input type="password" value={form.value} onChange={(event) => setForm({ ...form, value: event.target.value })} /></label>
        <button className="btn btn-primary" type="submit">Store</button>
      </form>
      {message ? <p role="alert">{message}</p> : null}
      <div className="table-wrap">
        <table>
          <thead><tr><th>Name</th><th>Kind</th><th>Key version</th></tr></thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}><td>{row.name}</td><td>{row.kind}</td><td className="mono">v{row.key_version}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function Settings({ workspaceId }: { workspaceId: string }) {
  const [hooks, setHooks] = useState<any[]>([]);
  const [schedules, setSchedules] = useState<any[]>([]);
  const [members, setMembers] = useState<any[]>([]);
  const [form, setForm] = useState({ email: "", name: "", password: "", role: "viewer" });
  const [once, setOnce] = useState("");
  useEffect(() => {
    void Promise.all([
      api<any>(`/api/workspaces/${workspaceId}/hooks`),
      api<any>(`/api/workspaces/${workspaceId}/schedules`),
      api<any>(`/api/workspaces/${workspaceId}/members`),
    ]).then(([hookBody, scheduleBody, memberBody]) => {
      setHooks(hookBody.body.hooks ?? []);
      setSchedules(scheduleBody.body.schedules ?? []);
      setMembers(memberBody.body.members ?? []);
    });
  }, [workspaceId]);
  return (
    <div className="page">
      <section className="panel stack">
        <h2>Webhooks</h2>
        <p className="muted">Authentication is checked before a run is created. A repeated event id returns the existing run. Canceling that run does not undo an HTTP call that already succeeded.</p>
        {hooks.map((hook) => (
          <p key={hook.id}><strong>{hook.workflow_name}</strong> <span className="mono">{hook.path}</span> · {hook.auth_mode} · {hook.rate_limit_per_minute}/min</p>
        ))}
      </section>
      <section className="panel stack">
        <h2>Schedules</h2>
        <p className="muted">Cron is evaluated in the saved IANA timezone. Missed ticks follow skip or catch_up_once. A worker must be running for the next fire to happen. Two workers cannot dispatch the same scheduled instant.</p>
        {schedules.map((schedule) => (
          <p key={schedule.id}><strong>{schedule.workflow_name}</strong> <span className="mono">{schedule.cron}</span> {schedule.timezone} · {schedule.missed_policy} · next {String(schedule.next_fire_at).slice(0, 19)}</p>
        ))}
      </section>
      <section className="panel stack">
        <h2>Team</h2>
        <form className="row" onSubmit={(event) => {
          event.preventDefault();
          void api<any>(`/api/workspaces/${workspaceId}/members`, { method: "POST", body: form }).then((result) => {
            if (result.status === 201) {
              setOnce(result.body.passwordOnce);
              setMembers((items) => [...items, result.body.member]);
            }
          });
        }}>
          <input aria-label="Member email" placeholder="Email" value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} />
          <input aria-label="Member name" placeholder="Name" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
          <input aria-label="Temporary password" placeholder="Temporary password" value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} />
          <select aria-label="Role" value={form.role} onChange={(event) => setForm({ ...form, role: event.target.value })}>
            <option>viewer</option><option>operator</option><option>editor</option><option>owner</option>
          </select>
          <button className="btn" type="submit">Add member</button>
        </form>
        {once ? <p className="banner">Temporary password, shown once: <span className="mono">{once}</span></p> : null}
        <ul>{members.map((member) => <li key={member.id}>{member.name} · {member.email} · {member.role}</li>)}</ul>
        <p className="muted">Viewers see run status without payloads. Operators can run and read payloads. Editors change drafts. Owners manage members and can delete credentials.</p>
      </section>
    </div>
  );
}

export function Shell({ workspaceId, title, children }: { workspaceId: string; title: string; children: ReactNode }) {
  const navigate = useNavigate();
  const [theme, setTheme] = useState(document.documentElement.dataset.theme === "dark" ? "dark" : "light");
  return (
    <div className="shell">
      <nav className="nav">
        <Link className="brand" to={`/w/${workspaceId}`}>
          <svg width="28" height="28" viewBox="0 0 28 28" aria-hidden="true">
            <rect x="4" y="3" width="3" height="22" fill="currentColor" />
            <path d="M7 6h12M7 12h9M7 18h14" stroke="currentColor" strokeWidth="2" />
          </svg>
          <span><strong>Halyard</strong><span>Studio</span></span>
        </Link>
        <Link className="item" to={`/w/${workspaceId}`}>Dashboard</Link>
        <Link className="item" to={`/w/${workspaceId}/workflows`}>Workflows</Link>
        <Link className="item" to={`/w/${workspaceId}/runs`}>Runs</Link>
        <Link className="item" to={`/w/${workspaceId}/credentials`}>Credentials</Link>
        <Link className="item" to={`/w/${workspaceId}/settings`}>Webhooks, schedules, team</Link>
        <div className="spacer" />
        <button className="linkish" type="button" onClick={() => {
          const next = theme === "dark" ? "light" : "dark";
          document.documentElement.dataset.theme = next;
          localStorage.setItem("halyard-theme", next);
          setTheme(next);
        }}>{theme === "dark" ? "Light theme" : "Dark theme"}</button>
        <button className="linkish" type="button" onClick={() => void api("/api/auth/logout", { method: "POST", body: {} }).then(() => navigate("/login"))}>Sign out</button>
      </nav>
      <div className="main">
        <div className="topbar"><h1>{title}</h1></div>
        {children}
      </div>
    </div>
  );
}
