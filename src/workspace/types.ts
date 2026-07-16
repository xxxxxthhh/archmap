/** Versioned, disposable aggregate of multiple already-scanned Archmap projects. */

export interface WorkspaceMember {
  path: string;
  project_id: string;
  project_name: string;
  snapshot_identity: string;
  dirty: boolean;
  node_count: number;
}

export interface WorkspaceIndex {
  schema_version: 1;
  command: 'workspace index';
  members: WorkspaceMember[];
  summary: {
    member_count: number;
    node_count: number;
  };
}
