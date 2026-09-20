// Export-only selection. Never alter the stored journal or response fields.
export function selectExportEvents(events, {mode = 'analysis', sessionId = null} = {}) {
  if (mode === 'full') return events.slice();
  if (mode !== 'analysis') throw new Error('Unknown export mode: ' + mode);
  const selected = sessionId ?? events.findLast(
    event => event.type === 'session_start' && typeof event.session_id === 'string' && event.session_id.length > 0
  )?.session_id;
  if (!selected) return [];
  return events.filter(event => event.session_id === selected && event.type !== 'rx_chunk');
}

export function toJsonl(events) {
  return events.length ? events.map(event => JSON.stringify(event)).join('\n') + '\n' : '';
}
