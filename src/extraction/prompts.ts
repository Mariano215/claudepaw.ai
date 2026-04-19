export const BATCH_EXTRACTION_PROMPT = `You are a knowledge extraction agent. Extract structured facts from this conversation that would be useful to recall in future conversations. Skip small talk.

Existing entities in this project (use canonical names, do not duplicate):
{entity_names}

Conversation:
{messages}

Return ONLY valid JSON (no markdown fences, no commentary) matching this schema:
{
  "entities": [{"kind": "person|project|decision|commitment|preference|event|concept","name":"short canonical name (max 50 chars)","summary":"1-2 sentence description"}],
  "observations": [{"entity_name":"matching entity","content":"the fact as a complete sentence","occurred_at": unix_ms_or_null}],
  "relations": [{"from":"entity name","to":"entity name","kind":"owns|worksOn|causedBy|prefers|decided|relatedTo"}]
}

Rules:
- Only include facts useful later. No small talk.
- Prefer canonical names from the existing list.
- occurred_at = null if no temporal context.
- If nothing extractable, return empty arrays.`

export const SUMMARIZATION_PROMPT = `Summarize this conversation episode in 2-4 sentences. Focus on decisions made, commitments, and topics discussed. Skip small talk.

Conversation ({message_count} messages from {date_range}):
{messages}

Return ONLY the summary text, no JSON, no preamble.`
