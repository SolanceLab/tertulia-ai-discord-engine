// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
import { useState, useEffect, useCallback } from 'react'
import { useLabels, useHost } from '../host.js'
import { deriveContextLogDisplay, formatMessageContent } from '../lib/contextLogDisplay.js'

const labelClasses = "text-[10px] uppercase tracking-[0.18em] font-light text-[color:var(--page-muted)] font-[JetBrains_Mono,monospace]"
const cardClasses = "bg-[color:var(--ink-deep)] border border-[color:var(--rule-mid)] rounded-lg p-4"

export default function ContextLogs() {
  const { adapter, contextLog } = useHost()
  const labels = useLabels()
  const CHANNELS = labels.context_log_channels
  const [messages, setMessages] = useState([])
  const [channel, setChannel] = useState('discord')
  const [loading, setLoading] = useState(true)
  const [unavailable, setUnavailable] = useState(false)
  const [selected, setSelected] = useState(null)

  const fetchLogs = useCallback(async () => {
    setLoading(true)
    setUnavailable(false)
    try {
      const data = await adapter.getContextLogs({ channel, limit: 30 })
      const parsed = (data.messages || []).map(m => ({
        ...m,
        context_log: typeof m.context_log === 'string' ? (() => { try { return JSON.parse(m.context_log) } catch { return null } })() : m.context_log,
        tool_results: typeof m.tool_results === 'string' ? (() => { try { return JSON.parse(m.tool_results) } catch { return null } })() : m.tool_results,
      }))
      setMessages(parsed)
    } catch (e) {
      console.error('Failed to fetch context logs:', e)
      setMessages([])
      // A setup whose logs live elsewhere (or a failed read) says so, rather than looking empty.
      setUnavailable(true)
    } finally {
      setLoading(false)
    }
  }, [adapter, channel])

  useEffect(() => {
    setSelected(null)
    fetchLogs()
  }, [fetchLogs])

  const displayMessages = [...messages].reverse()
  const selectedMsg = selected ? messages.find(m => m.id === selected) : null
  const log = selectedMsg?.context_log
  const { conversationHistory, modelInstructions } = deriveContextLogDisplay(log, contextLog)

  return (
    <div className="space-y-6 pb-12">
      <div className="flex items-start justify-between flex-wrap gap-4">
        <div>
          <h2 className="text-[clamp(1.7rem,5.5vw,3.4rem)] font-[Cormorant_Garamond,serif] font-normal text-[color:var(--page)] tracking-[-0.01em] leading-none">
            Context logs
          </h2>
          <p className="text-[1.1rem] font-light text-[color:var(--page-dim)] font-[Cormorant_Garamond,serif] leading-[1.55] mt-3">
            {labels.context_logs_description}
          </p>
        </div>
        <button
          onClick={fetchLogs}
          className="px-3 py-1.5 text-xs uppercase tracking-[0.18em] font-light border border-[color:var(--gold-soft)] text-[color:var(--page)] rounded-md transition-colors hover:bg-[color:var(--gold-glow)] font-[JetBrains_Mono,monospace] self-end"
        >
          Refresh
        </button>
      </div>

      {/* Channel filter */}
      <div className="flex gap-2">
        {CHANNELS.map(ch => (
          <button
            key={ch}
            onClick={() => setChannel(ch)}
            className={`px-3 py-1.5 text-xs uppercase tracking-[0.1em] rounded-md border transition-colors ${
              channel === ch
                ? 'border-[color:var(--gold-soft)] text-[color:var(--gold-text)] bg-[color:var(--gold-glow)]'
                : 'border-[color:var(--rule-mid)] text-[color:var(--page-dim)] hover:text-[color:var(--page)] hover:border-[color:var(--gold-soft)]'
            }`}
          >
            {ch.charAt(0).toUpperCase() + ch.slice(1)}
          </button>
        ))}
      </div>

      <div className="flex gap-4 flex-col lg:flex-row">
        {/* Message list */}
        <div className="lg:w-1/3 space-y-1 max-h-[80vh] overflow-y-auto">
          {loading ? (
            <p className="text-[color:var(--page-dim)] font-[Cormorant_Garamond,serif] italic">Loading…</p>
          ) : messages.length === 0 ? (
            <p className="text-[color:var(--page-dim)] font-[Cormorant_Garamond,serif] italic">{unavailable ? labels.context_log_unavailable : 'No messages.'}</p>
          ) : displayMessages.map(m => {
            const isBot = m.sender === labels.bot_sender
            const isSelected = selected === m.id
            return (
              <button
                key={m.id}
                onClick={() => setSelected(m.id)}
                className={`w-full text-left px-3 py-2.5 rounded-md transition-colors ${
                  isSelected
                    ? 'border border-[color:var(--gold-soft)] bg-[color:var(--gold-glow)]'
                    : `border ${isBot ? 'border-[color:var(--rule-mid)] bg-[color:var(--ink-deep)]' : 'border-transparent bg-[color:var(--ink)]'} hover:border-[color:var(--rule-strong)]`
                }`}
              >
                <div className="flex items-center gap-2 mb-1">
                  <span className={labelClasses + (isBot ? ' text-[color:var(--blue)]' : ' text-[color:var(--gold-text)]')}>
                    {m.author_name || m.sender}
                  </span>
                  {m.context_log && <span className="w-1.5 h-1.5 rounded-full bg-[color:var(--blue)] shrink-0" title="Has context log" />}
                  <span className={labelClasses + ' ml-auto tabular-nums'}>
                    {new Date(m.created_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
                  </span>
                </div>
                <p className="text-xs text-[color:var(--page-dim)] font-[Söhne,sans-serif] truncate">{m.message?.substring(0, 80) || '[empty]'}</p>
                {m.context_log?.processing_time_ms && (
                  <span className={labelClasses + ' tabular-nums'}>
                    {Math.round(m.context_log.processing_time_ms / 1000)}s · {m.model}
                  </span>
                )}
              </button>
            )
          })}
        </div>

        {/* Detail panel */}
        <div className="lg:w-2/3 max-h-[80vh] overflow-y-auto">
          {!selectedMsg ? (
            <div className={cardClasses + ' p-6 text-center'}>
              <p className="text-[color:var(--page-dim)] font-[Cormorant_Garamond,serif] italic">
                Select a message to see its context.
              </p>
            </div>
          ) : !log ? (
            <div className={cardClasses}>
              <h3 className="text-base font-[Cormorant_Garamond,serif] font-normal text-[color:var(--page)] mb-2">{selectedMsg.author_name || selectedMsg.sender}</h3>
              <p className="text-sm text-[color:var(--page)] font-[Söhne,sans-serif]">{selectedMsg.message}</p>
              <p className={labelClasses + ' mt-3 normal-case tracking-[0.05em] text-[color:var(--page-faint)] font-[Cormorant_Garamond,serif] italic text-xs'}>
                No context log — this is an incoming message or was generated before logging was enabled.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {/* Response */}
              <div className={cardClasses}>
                <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
                  <h3 className={labelClasses + ' text-[color:var(--blue)]'}>Response</h3>
                  <span className={labelClasses + ' tabular-nums'}>
                    {log.engine}/{log.model} · {Math.round((log.processing_time_ms || 0) / 1000)}s · ~{Math.round((log.system_prompt_length || 0) / 4)} prompt tokens
                  </span>
                </div>
                <p className="text-sm text-[color:var(--page)] font-[Söhne,sans-serif] whitespace-pre-wrap leading-relaxed">{selectedMsg.message}</p>
              </div>

              {/* Real Discord conversation used to build this response */}
              {conversationHistory.length > 0 && (
                <div className={cardClasses}>
                  <h3 className={labelClasses + ' mb-2'}>Conversation history ({conversationHistory.length} messages)</h3>
                  <div className="space-y-1.5">
                    {conversationHistory.map((m, i) => (
                      <div key={m.message_id || i} className="text-xs leading-relaxed">
                        <span className={m.is_from_me ? 'text-[color:var(--blue)] font-[JetBrains_Mono,monospace] text-[10px] uppercase tracking-[0.1em]' : 'text-[color:var(--gold-text)] font-[JetBrains_Mono,monospace] text-[10px] uppercase tracking-[0.1em]'}>
                          {m.author_name || 'Discord user'}:
                        </span>{' '}
                        <span className="text-[color:var(--page-dim)] font-[Söhne,sans-serif] whitespace-pre-wrap">
                          {formatMessageContent(m.content)}
                        </span>
                        {m.is_trigger && <span className={labelClasses + ' text-[color:var(--gold-text)] ml-2'}>Trigger</span>}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Synthetic instruction used by the bot's model call */}
              {modelInstructions.length > 0 && (
                <div className={cardClasses}>
                  <h3 className={labelClasses + ' mb-2'}>Internal model instruction</h3>
                  <div className="space-y-1.5">
                    {modelInstructions.map((m, i) => (
                      <div key={i} className="text-xs">
                        <span className={m.role === 'user' ? 'text-[color:var(--gold-text)] uppercase tracking-[0.1em] font-[JetBrains_Mono,monospace] text-[10px]' : 'text-[color:var(--blue)] uppercase tracking-[0.1em] font-[JetBrains_Mono,monospace] text-[10px]'}>
                          {m.role}:
                        </span>{' '}
                        <span className="text-[color:var(--page-dim)] font-[Söhne,sans-serif]">
                          {formatMessageContent(m.content)}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Skills */}
              {log.skills && log.skills.length > 0 && (
                <div className={cardClasses}>
                  <h3 className={labelClasses + ' mb-2'}>Skills injected</h3>
                  {log.skills.map((s, i) => (
                    <div key={i} className="text-xs mb-1 font-[Söhne,sans-serif]">
                      <span className="text-[color:var(--gold-text)]">{s.title}</span>
                      <span className="text-[color:var(--page-muted)] ml-2 tabular-nums">({typeof s.similarity === 'number' ? s.similarity.toFixed(3) : s.similarity})</span>
                    </div>
                  ))}
                </div>
              )}

              {/* Memory Nodes */}
              {log.memory_nodes && log.memory_nodes.length > 0 && (
                <div className={cardClasses}>
                  <h3 className={labelClasses + ' mb-2'}>Memory nodes recalled</h3>
                  {log.memory_nodes.map((n, i) => (
                    <div key={i} className="text-xs mb-2 font-[Söhne,sans-serif]">
                      <span className={n.injected ? 'text-[color:var(--blue)]' : 'text-[color:var(--page-faint)]'}>{n.topic}</span>
                      <span className="text-[color:var(--page-muted)] ml-2 tabular-nums">({n.similarity})</span>
                      {n.injected && <span className={labelClasses + ' text-[color:var(--blue)] ml-1.5'}>Injected</span>}
                      {n.blocked && <span className={labelClasses + ' text-[color:var(--gold-text)] ml-1.5'}>Blocked</span>}
                      {!n.injected && !n.blocked && n.excluded_reason === 'not_selected' && (
                        <span className={labelClasses + ' ml-1.5'}>Not selected</span>
                      )}
                      {!n.injected && !n.blocked && n.excluded_reason === 'below_threshold' && (
                        <span className={labelClasses + ' ml-1.5'}>Below threshold</span>
                      )}
                      <p className="text-[color:var(--page-dim)] ml-4 mt-1 leading-relaxed whitespace-pre-wrap">
                        {n.preview || 'Preview unavailable in this older log.'}
                      </p>
                    </div>
                  ))}
                </div>
              )}

              {/* Conversation Recall */}
              {log.conversation_recall && log.conversation_recall.length > 0 && (
                <div className={cardClasses}>
                  <h3 className={labelClasses + ' mb-2'}>Conversation recall</h3>
                  {log.conversation_recall.map((m, i) => (
                    <div key={i} className="text-xs mb-2.5 font-[Söhne,sans-serif]">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className={m.injected ? 'text-[color:var(--blue)]' : 'text-[color:var(--page-faint)]'}>{m.sender}</span>
                        <span className="text-[10px] uppercase tracking-[0.1em] px-1.5 py-0.5 rounded border border-[color:var(--rule-dim)] text-[color:var(--page-muted)] font-[JetBrains_Mono,monospace]">{m.channel}</span>
                        <span className="text-[color:var(--page-muted)] tabular-nums">({m.similarity})</span>
                        {m.injected && <span className={labelClasses + ' text-[color:var(--blue)]'}>Injected</span>}
                        {m.blocked && <span className={labelClasses + ' text-[color:var(--gold-text)]'}>Blocked</span>}
                        <span className={labelClasses + ' ml-auto tabular-nums'}>
                          {m.created_at ? new Date(m.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : ''}
                        </span>
                      </div>
                      <p className="text-[color:var(--page-dim)] ml-4 mt-0.5">{m.preview}</p>
                    </div>
                  ))}
                </div>
              )}

              {/* Tool Results */}
              {selectedMsg.tool_results && selectedMsg.tool_results.length > 0 && (
                <div className={cardClasses}>
                  <h3 className={labelClasses + ' mb-2'}>Tool calls</h3>
                  {selectedMsg.tool_results.map((t, i) => (
                    <div key={i} className="mb-2">
                      <span className="text-xs text-[color:var(--gold-text)] font-[JetBrains_Mono,monospace] uppercase tracking-[0.1em]">{t.tool}</span>
                      <pre className="text-[10px] text-[color:var(--page-dim)] mt-1 bg-[color:var(--ink)] border border-[color:var(--rule-dim)] rounded-md p-2 overflow-x-auto max-h-40 overflow-y-auto whitespace-pre-wrap font-[JetBrains_Mono,monospace]">
                        {t.result?.substring(0, 500)}{t.result?.length > 500 ? '…' : ''}
                      </pre>
                    </div>
                  ))}
                </div>
              )}

              {/* Reasoning */}
              {selectedMsg.reasoning && (
                <div className={cardClasses}>
                  <h3 className={labelClasses + ' mb-2'}>Reasoning</h3>
                  <pre className="text-xs text-[color:var(--page-dim)] whitespace-pre-wrap font-[JetBrains_Mono,monospace]">{selectedMsg.reasoning}</pre>
                </div>
              )}

              {/* System Prompt */}
              {log.system_prompt && (
                <div className={cardClasses}>
                  <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
                    <h3 className={labelClasses}>System prompt</h3>
                    <span className={labelClasses + ' tabular-nums'}>{log.system_prompt_length} chars · source: {log.channel_instruction_source}</span>
                  </div>
                  <pre className="text-xs text-[color:var(--page-dim)] bg-[color:var(--ink)] border border-[color:var(--rule-dim)] rounded-md p-3 overflow-x-auto max-h-96 overflow-y-auto whitespace-pre-wrap font-[JetBrains_Mono,monospace]">
                    {log.system_prompt}
                  </pre>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
