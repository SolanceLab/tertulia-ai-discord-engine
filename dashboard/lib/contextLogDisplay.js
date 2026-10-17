// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
// Pure helpers that turn one context-log record into what the Context logs page
// shows. Copied from the House frame so the module has no @frame import; the
// House-specific recovery hints (own-name markers, extra transcript tags) come in
// as options instead of being baked in.

export function formatMessageContent(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => part.type === 'text' ? part.text : part.type === 'image_url' ? '[image]' : '[attachment]')
      .join(' ')
  }
  return '[multipart]'
}

/**
 * Older logs kept the Discord transcript only inside the system prompt. Recover it.
 * opts.transcriptTags: tag names that wrap the transcript (default discord_recent_messages).
 * opts.selfNames: author names that mean the bot itself.
 */
export function extractLegacyDiscordContext(systemPrompt, opts = {}) {
  if (typeof systemPrompt !== 'string') return []
  const tags = opts.transcriptTags?.length ? opts.transcriptTags : ['discord_recent_messages']
  const selfNames = opts.selfNames || []

  const taggedTranscript = tags
    .map((tag) => {
      const open = `<${tag}>\n`
      const close = `\n</${tag}>`
      const start = systemPrompt.lastIndexOf(open)
      if (start < 0) return ''
      const contentStart = start + open.length
      const end = systemPrompt.indexOf(close, contentStart)
      return end >= 0 ? systemPrompt.slice(contentStart, end) : ''
    })
    .find(Boolean)
  const recentMarker = 'Recent messages (oldest first):\n'
  const recentStart = systemPrompt.lastIndexOf(recentMarker)
  const recentTail = recentStart >= 0 ? systemPrompt.slice(recentStart + recentMarker.length) : ''
  const recentTranscript = recentTail.split('\n\nReply with ONLY a JSON object')[0]
  const transcript = taggedTranscript || recentTranscript
  if (!transcript) return []

  const messages = []
  for (const line of transcript.split('\n')) {
    const match = line.match(/^([^:]+):\s?(.*)$/)
    if (match) {
      const author = match[1]
      messages.push({
        author_name: author,
        content: match[2],
        is_from_me: selfNames.includes(author),
        legacy_recovered: true,
      })
    } else if (messages.length > 0) {
      messages[messages.length - 1].content += `\n${line}`
    }
  }
  return messages
}

export function isInternalModelInstruction(message) {
  if (typeof message?.content !== 'string') return false
  return message.content === 'Reply to the most recent message addressed to you, in your own voice.' ||
    message.content === 'Speak or stay silent? JSON only.' ||
    /^Write the level \d+ curfew nudge\.$/.test(message.content)
}

export function deriveContextLogDisplay(log, opts = {}) {
  if (!log) return { conversationHistory: [], modelInstructions: [] }

  const recoveredDiscordContext = extractLegacyDiscordContext(log.system_prompt, opts)
  const directDiscordContext = log.discord_context?.length > 0
    ? log.discord_context
    : recoveredDiscordContext
  const fallbackConversationHistory = log.conversation_history?.some((m) => !isInternalModelInstruction(m))
    ? log.conversation_history.map((m) => ({
        author_name: m.role,
        content: m.content,
        is_from_me: m.role === 'assistant',
      }))
    : []

  return {
    conversationHistory: directDiscordContext.length > 0 ? directDiscordContext : fallbackConversationHistory,
    modelInstructions: log.conversation_history?.filter(isInternalModelInstruction) || [],
  }
}
