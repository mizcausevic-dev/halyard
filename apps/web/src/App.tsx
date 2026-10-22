import type { ReactNode } from "react";
import { Navigate, Route, Routes, useParams } from "react-router-dom";
import { Editor } from "./editor";
import { Credentials, Dashboard, Login, RunDetail, RunList, Settings, Shell, WorkflowList } from "./pages";

function Workspace({ title, children }: { title: string; children: ReactNode }) {
  const { workspaceId = "" } = useParams();
  return <Shell workspaceId={workspaceId} title={title}>{children}</Shell>;
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/w/:workspaceId" element={<Workspace title="Dashboard"><Dash /></Workspace>} />
      <Route path="/w/:workspaceId/workflows" element={<Workspace title="Workflows"><Flows /></Workspace>} />
      <Route path="/w/:workspaceId/workflows/:workflowId" element={<Edit />} />
      <Route path="/w/:workspaceId/runs" element={<Workspace title="Runs"><Runs /></Workspace>} />
      <Route path="/w/:workspaceId/runs/:runId" element={<Workspace title="Run"><Run /></Workspace>} />
      <Route path="/w/:workspaceId/credentials" element={<Workspace title="Credentials"><Creds /></Workspace>} />
      <Route path="/w/:workspaceId/settings" element={<Workspace title="Settings"><Sets /></Workspace>} />
      <Route path="*" element={<Navigate to="/login" replace />} />
    </Routes>
  );
}

function Dash() {
  const { workspaceId = "" } = useParams();
  return <Dashboard workspaceId={workspaceId} />;
}
function Flows() {
  const { workspaceId = "" } = useParams();
  return <WorkflowList workspaceId={workspaceId} />;
}
function Runs() {
  const { workspaceId = "" } = useParams();
  return <RunList workspaceId={workspaceId} />;
}
function Run() {
  const { workspaceId = "", runId = "" } = useParams();
  return <RunDetail workspaceId={workspaceId} runId={runId} />;
}
function Creds() {
  const { workspaceId = "" } = useParams();
  return <Credentials workspaceId={workspaceId} />;
}
function Sets() {
  const { workspaceId = "" } = useParams();
  return <Settings workspaceId={workspaceId} />;
}
function Edit() {
  const { workspaceId = "", workflowId = "" } = useParams();
  return (
    <Shell workspaceId={workspaceId} title="Editor">
      <Editor workspaceId={workspaceId} workflowId={workflowId} />
    </Shell>
  );
}
