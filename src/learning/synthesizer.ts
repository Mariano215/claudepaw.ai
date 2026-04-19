import { randomUUID } from 'node:crypto'
import {
  getUnconsumedFeedback,
  markFeedbackConsumed,
  getSkillsByAgent,
  saveSkill,
  updateSkillContent,
  decaySkillEffectiveness,
  type InteractionFeedback,
} from '../db.js'
import { reportFeedItem, reportMetric } from '../dashboard.js'
import { logger } from '../logger.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SynthesisResult {
  new_skills: { title: string; content: string }[]
  update_skills: { uuid: string; content: string }[]
  skip_ids: string[]
}

// ---------------------------------------------------------------------------
// Prompt building (exported for testing)
// ---------------------------------------------------------------------------

export function buildSynthesisPrompt(
  agentLabel: string,
  feedback: InteractionFeedback[],
  existingSkills: { uuid: string; title: string; content: string }[],
): string {
  const feedbackBlock = feedback
    .map((f, i) => {
      return (
        `--- Failure ${i + 1} (${f.feedback_type}) [id: ${f.id}] ---\n` +
        `User asked: ${f.user_message.slice(0, 300)}\n` +
        `Bot responded: ${f.bot_response.slice(0, 300)}\n` +
        `What went wrong: ${f.feedback_note ?? 'No detail provided'}`
      )
    })
    .join('\n\n')

  const skillsBlock =
    existingSkills.length > 0
      ? existingSkills
          .map((s) => `- [${s.uuid}] "${s.title}": ${s.content}`)
          .join('\n')
      : '(none)'

  return `You are reviewing failure patterns for the ${agentLabel} agent.

Here are recent interactions where the user was unhappy:

${feedbackBlock}

Existing skills for this agent:
${skillsBlock}

Your job:
1. Identify recurring patterns or themes across these failures
2. For each pattern, write a concise behavioral instruction (1-2 sentences)
3. If an existing skill already covers a failure, note whether it needs updating
4. If a failure is a one-off with no pattern, skip it
5. Output JSON: { "new_skills": [{"title": "...", "content": "..."}], "update_skills": [{"uuid": "...", "content": "..."}], "skip_ids": ["..."] }

IMPORTANT: Output ONLY the JSON object. No explanation before or after.`
}

// ---------------------------------------------------------------------------
// Result parsing (exported for testing)
// ---------------------------------------------------------------------------

export function parseSynthesisResult(raw: string): SynthesisResult | null {
  try {
    // Try to extract JSON from markdown code block first
    const codeBlockMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/)
    const jsonStr = codeBlockMatch ? codeBlockMatch[1].trim() : raw.trim()

    const parsed = JSON.parse(jsonStr)

    // Validate structure
    if (
      !Array.isArray(parsed.new_skills) ||
      !Array.isArray(parsed.update_skills) ||
      !Array.isArray(parsed.skip_ids)
    ) {
      return null
    }

    return parsed as SynthesisResult
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Main synthesis function
// ---------------------------------------------------------------------------

/**
 * Run the weekly skill synthesis. Called by the scheduler.
 *
 * Returns a summary string for Telegram notification.
 */
export async function runSkillSynthesis(
  runAgent: (prompt: string) => Promise<string | null>,
  send: (chatId: string, text: string) => Promise<void>,
  ownerChatId: string,
): Promise<string> {
  const allFeedback = getUnconsumedFeedback()

  if (allFeedback.length < 2) {
    logger.info({ count: allFeedback.length }, 'Not enough feedback for synthesis, skipping')
    return 'Skipped -- fewer than 2 unconsumed feedback records'
  }

  // Group by agent_id
  const groups = new Map<string, InteractionFeedback[]>()
  for (const f of allFeedback) {
    const key = f.agent_id ?? '__global__'
    const list = groups.get(key) ?? []
    list.push(f)
    groups.set(key, list)
  }

  let totalNew = 0
  let totalUpdated = 0
  let totalRetired = 0
  const processedIds: string[] = []

  for (const [agentKey, feedback] of groups) {
    const agentId = agentKey === '__global__' ? null : agentKey
    const agentLabel = agentId ?? 'main assistant'

    // Get existing skills for context
    const existingSkills = getSkillsByAgent(agentId).map((s) => ({
      uuid: s.uuid,
      title: s.title,
      content: s.content,
    }))

    const prompt = buildSynthesisPrompt(agentLabel, feedback, existingSkills)

    logger.info({ agentId, feedbackCount: feedback.length }, 'Running skill synthesis')

    const result = await runAgent(prompt)
    if (!result) {
      logger.error({ agentId }, 'Synthesis agent returned no result')
      continue
    }

    const parsed = parseSynthesisResult(result)
    if (!parsed) {
      logger.error({ agentId, resultPreview: result.slice(0, 200) }, 'Failed to parse synthesis result')
      continue
    }

    // Create new skills
    for (const skill of parsed.new_skills) {
      saveSkill({
        uuid: randomUUID(),
        agent_id: agentId,
        title: skill.title,
        content: skill.content,
        source_ids: feedback.map((f) => f.id),
      })
      totalNew++
    }

    // Update existing skills
    for (const update of parsed.update_skills) {
      updateSkillContent(update.uuid, update.content)
      totalUpdated++
    }

    // Check for recurring failures against existing skills -- decay effectiveness
    for (const skill of existingSkills) {
      const skillWords = new Set(skill.content.toLowerCase().split(/\s+/))
      for (const f of feedback) {
        const noteWords = (f.feedback_note ?? '').toLowerCase().split(/\s+/)
        const overlap = noteWords.filter((w) => skillWords.has(w) && w.length > 3).length
        if (overlap >= 3) {
          decaySkillEffectiveness(skill.uuid)
          logger.info({ skillUuid: skill.uuid, overlap }, 'Decayed skill effectiveness')
          const updated = getSkillsByAgent(agentId).find((s) => s.uuid === skill.uuid)
          if (updated && updated.status === 'retired') {
            totalRetired++
            await send(
              ownerChatId,
              `\ud83d\udce6 Retired skill for ${agentLabel}: "${skill.title}" -- kept failing, likely needs a different approach.`,
            ).catch(() => {})
          }
          break
        }
      }
    }

    processedIds.push(...feedback.map((f) => f.id))

    reportFeedItem(agentId ?? 'system', 'Skills synthesized', `${parsed.new_skills.length} new, ${parsed.update_skills.length} updated`)
  }

  markFeedbackConsumed(processedIds)

  const summary = `Skill synthesis complete: ${totalNew} new, ${totalUpdated} updated, ${totalRetired} retired. Processed ${processedIds.length} feedback records.`

  reportFeedItem('builder', 'Skills synthesized', summary)
  reportMetric('learning', 'skills_synthesized', totalNew)

  logger.info({ totalNew, totalUpdated, totalRetired, processed: processedIds.length }, 'Skill synthesis complete')

  return summary
}
