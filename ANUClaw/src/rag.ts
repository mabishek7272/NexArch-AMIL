import * as fs from 'fs';
import * as path from 'path';
import { db } from './db';
import { logger } from './logger';

export async function retrieveContext(prompt: string, groupId: string): Promise<string> {
  const words = prompt
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 3); // only keep keywords

  const uniqueWords = Array.from(new Set(words));
  
  if (uniqueWords.length === 0) return '';

  const results: string[] = [];

  // 1. Patient records — DISABLED (Phase 1 security repair F01, plan.md §14;
  //    docs/SCAN-2026-11-17.md finding 2).
  //
  //    The previous implementation keyword-searched the entire `patients` table
  //    and injected matches into every agent prompt, from every entry point
  //    (chat channels, uploads, pipelines, tasks, API). The table has no tenant
  //    or owner column, so nothing tied a retrieved record to the requesting
  //    user, group, or tenant — a patient-data disclosure path to model egress.
  //
  //    This stays disabled until retrieval is implemented with an explicit,
  //    server-verified authorization: tenant + authorized patient ID + purpose
  //    of use, enforced BEFORE any query. Do not restore it with keyword
  //    filtering, name matching, or model-based access checks. RAG must not
  //    query the `patients` table.

  // 2. Search Skills guidelines
  try {
    const skillsDir = path.resolve('./container/skills');
    const skillMatches: Array<{ skill: string; content: string }> = [];

    if (fs.existsSync(skillsDir)) {
      const skills = fs.readdirSync(skillsDir);
      for (const skill of skills) {
        const skillPath = path.join(skillsDir, skill, 'SKILL.md');
        if (fs.existsSync(skillPath)) {
          const content = fs.readFileSync(skillPath, 'utf8');
          // Check if any keyword matches
          const matchedWords = uniqueWords.filter(w => content.toLowerCase().includes(w));
          if (matchedWords.length >= 2 || (matchedWords.length >= 1 && uniqueWords.length === 1)) {
            // Find relevant lines/sections or return first 1500 chars as reference
            const summary = content.slice(0, 1500);
            skillMatches.push({ skill, content: summary });
          }
        }
      }
    }

    if (skillMatches.length > 0) {
      results.push('<clinical_guidelines>');
      for (const match of skillMatches.slice(0, 2)) { // top 2 matching guidelines
        results.push(`  Source Skill: ${match.skill}`);
        results.push(`  Guideline Excerpt:\n${match.content}\n`);
      }
      results.push('</clinical_guidelines>');
    }
  } catch (err: any) {
    logger.error('RAG skills search failed:', err);
  }

  // 3. Search Historical Facts from memory_facts
  try {
    const facts = await db.query(`
      SELECT key, value, confidence, source 
      FROM memory_facts 
      WHERE group_id = $1 AND superseded_by IS NULL
      LIMIT 10
    `, [groupId]);

    if (facts.length > 0) {
      results.push('<historical_session_facts>');
      for (const f of facts) {
        // filter facts based on keyword overlap
        const overlaps = uniqueWords.some(w => f.key.toLowerCase().includes(w) || f.value.toLowerCase().includes(w));
        if (overlaps || uniqueWords.length < 3) {
          results.push(`  Fact [${f.key}]: ${f.value} (Confidence: ${f.confidence}, Source: ${f.source})`);
        }
      }
      results.push('</historical_session_facts>');
    }
  } catch (err: any) {
    logger.error('RAG facts search failed:', err);
  }

  return results.join('\n');
}
