import { Router, Response, NextFunction } from 'express';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { perTenantRateLimit, quotaCheck, agentConcurrencyLimit, effectiveLimits } from '../middleware/rate-limit';
import { usageMeter } from '../middleware/usage-meter';
import { runAgent } from '../../container-runner';
import * as fs from 'fs';
import { agentSkillFile, checkSkillAccess, listUsableSkills } from '../../interpretation/skills/registry';

const router = Router();

/**
 * The one place a run request is authorised: the skill must be assigned to the tenant (and enabled, released and
 * within the tenant's tier — see interpretation/skills/registry.ts), be an agent skill, and exist on disk. On success
 * the SKILL.md path is left in `res.locals.skillFile`. Because the id is checked against the registry first, it
 * never reaches the file system unless it is a known skill id.
 *
 * It sits AFTER the cheap per-tenant rate limit (so probing skill ids is still throttled) but BEFORE the monthly
 * quota and the concurrency lease: a refused request must not use up the tenant's quota or hold an agent slot.
 */
function skillGate(skillIdOf: (req: AuthRequest) => unknown) {
  return async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
    const skill = skillIdOf(req);
    if (typeof skill !== 'string' || !skill) {
      res.status(400).json({ error: 'skill is required.', code: 'validation_failed' });
      return;
    }
    const access = await checkSkillAccess(req.tenant!, skill);
    if (!access.ok) {
      res.status(access.status).json({ error: access.message, code: access.code });
      return;
    }
    if (access.skill.kind !== 'agent') {
      res.status(400).json({ error: 'That skill is not an agent skill; use the interpretation API.', code: 'not_an_agent_skill' });
      return;
    }
    const file = agentSkillFile(skill);
    if (!file) {
      res.status(404).json({ error: 'This skill is not available on this server.', code: 'skill_unavailable' });
      return;
    }
    res.locals.skillFile = file;
    next();
  };
}

// ── Routes ────────────────────────────────────────────────────────────────────

/**
 * GET /api/v1/skills
 * List the skills assigned to your account (an administrator assigns them).
 */
router.get('/', requireAuth, async (req: AuthRequest, res: Response) => {
  const skills = await listUsableSkills(req.tenant!.tenant_id, 'agent');
  res.json({ skills: skills.map((s) => ({ name: s.skill_id, description: String(s.manifest.description ?? s.title) })) });
});

/**
 * POST /api/v1/skills/:skill/run
 * Execute a skill with a natural-language prompt.
 *
 * Body:
 *   prompt        {string}  — required. The task/question for the agent.
 *   group_id      {string}  — optional. Persistent session ID (memory is shared across calls with same ID).
 *   max_turns     {number}  — optional, default 5.
 *   stream        {boolean} — optional, default false. Stream newline-delimited JSON chunks.
 */
router.post(
  '/:skill/run',
  requireAuth,
  perTenantRateLimit,
  skillGate((req) => req.params.skill),
  quotaCheck,
  agentConcurrencyLimit,
  usageMeter,
  async (req: AuthRequest, res: Response) => {
    const skill = req.params.skill as string;
    const { prompt, group_id, max_turns = 5, stream = false } = req.body;
    const skillPath = res.locals.skillFile as string;

    if (!prompt) {
      res.status(400).json({ error: 'prompt is required.' });
      return;
    }

    // Build a tenant-scoped group ID so memory is isolated per tenant
    const scopedGroupId = group_id
      ? `api-${req.tenant!.tenant_id}-${group_id}`
      : `api-${req.tenant!.tenant_id}-${Date.now()}`;

    const skillMd = fs.readFileSync(skillPath, 'utf8');
    const fullPrompt = `You are running the ${skill} skill.\n\n${skillMd}\n\n---\n\nTask:\n${prompt}`;

    try {
      if (stream) {
        res.setHeader('Content-Type', 'application/x-ndjson');
        res.setHeader('Transfer-Encoding', 'chunked');

        // Stream chunks as newline-delimited JSON
        const onChunk = (chunk: string) => {
          res.write(JSON.stringify({ type: 'chunk', text: chunk }) + '\n');
        };

        const result = await runAgent({
          groupId: scopedGroupId,
          prompt:  fullPrompt,
          maxTurns: Number(max_turns),
          onChunk,
        });

        res.write(JSON.stringify({ type: 'done', result, skill, group_id: scopedGroupId }) + '\n');
        res.end();
      } else {
        const result = await runAgent({
          groupId:  scopedGroupId,
          prompt:   fullPrompt,
          maxTurns: Number(max_turns),
        });

        // A failed/blocked run is not a success (explicit status for API clients).
        res.status(result.error ? 502 : 200).json({
          skill,
          group_id:   scopedGroupId,
          result,
          tenant_id:  req.tenant!.tenant_id,
          usage_hint: `${req.tenant!.usage_this_month + 1} calls this month (quota: ${effectiveLimits(req.tenant!).quota ?? 'unlimited'})`,
        });
      }
    } catch (err: unknown) {
      void err;
      res.status(500).json({ error: 'Skill execution failed.', skill });
    }
  },
);

/**
 * POST /api/v1/skills/run
 * Run any skill by specifying it in the body (alternative to path param).
 *
 * Body: { skill, prompt, group_id?, max_turns?, stream? }
 */
router.post(
  '/run',
  requireAuth,
  perTenantRateLimit,
  skillGate((req) => req.body?.skill),
  quotaCheck,
  agentConcurrencyLimit,
  usageMeter,
  async (req: AuthRequest, res: Response) => {
    const { skill } = req.body as { skill: string };
    const { prompt, group_id, max_turns = 5 } = req.body;
    const skillPath = res.locals.skillFile as string;

    if (!prompt) { res.status(400).json({ error: 'prompt is required.' }); return; }

    const scopedGroupId = group_id
      ? `api-${req.tenant!.tenant_id}-${group_id}`
      : `api-${req.tenant!.tenant_id}-${Date.now()}`;

    const skillMd = fs.readFileSync(skillPath, 'utf8');
    const fullPrompt = `You are running the ${skill} skill.\n\n${skillMd}\n\n---\n\nTask:\n${prompt}`;

    try {
      const result = await runAgent({ groupId: scopedGroupId, prompt: fullPrompt, maxTurns: Number(max_turns) });
      res.status(result.error ? 502 : 200).json({ skill, group_id: scopedGroupId, result, tenant_id: req.tenant!.tenant_id });
    } catch (err: unknown) {
      void err;
      res.status(500).json({ error: 'Skill execution failed.' });
    }
  },
);

export default router;
