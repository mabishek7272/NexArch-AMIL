/**
 * Research Studio access control. Projects are OWNER-ONLY (same pattern as src/research/service.ts): a project not owned by the
 * caller answers 404, never 403, so existence is not disclosed. Dashboard roles admin/operator/clinician may use the feature at
 * all (enforced by requireRole in the route); ownership is enforced here, per project, independent of role.
 */
import { db } from '../db';
import { WorkflowError } from '../documents/workflow';
import { ProjectRow } from './types';

export async function ownProject(projectId: string, userId: string): Promise<ProjectRow> {
  const row = await db.queryOne<ProjectRow>('SELECT * FROM research_studio_projects WHERE id = $1 AND owner_id = $2', [projectId, userId]);
  if (!row) throw new WorkflowError(404, 'not_found', 'Project not found.');
  return row;
}

/** A task's project must be owned by the caller; returns both rows (used by every task-level operation). */
export async function ownTask(taskId: string, userId: string): Promise<{ project: ProjectRow; task: import('./types').TaskRow }> {
  const task = await db.queryOne<import('./types').TaskRow>('SELECT * FROM research_studio_tasks WHERE id = $1', [taskId]);
  if (!task) throw new WorkflowError(404, 'not_found', 'Task not found.');
  const project = await ownProject(task.project_id, userId);
  return { project, task };
}
