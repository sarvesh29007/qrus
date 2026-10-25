import { useEffect, useRef } from 'react';
import { tokens } from '../api/client.js';

/**
 * Subscribes to the server-sent events stream (`/api/events/slots`) and calls
 * `onChange(payload)` for every `slot_changed` event — book, cancel,
 * reschedule or block — so slot grids and dashboards update in real time
 * instead of polling.
 *
 * EventSource cannot carry an Authorization header, and putting the JWT in the
 * query string would leak it into access logs, so the stream is read with
 * fetch() + ReadableStream and a small SSE parser instead. The connection
 * reconnects with a 3s backoff if the server drops it.
 */

async function* sseEvents(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      let split;
      while ((split = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        let event = 'message';
        let data = '';
        for (const line of block.split('\n')) {
          if (line.startsWith(':')) continue; // heartbeat comment
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data += (data ? '\n' : '') + line.slice(5).trim();
        }
        if (data) yield { event, data };
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export default function useSlotEvents(onChange, { enabled = true } = {}) {
  const handler = useRef(onChange);
  handler.current = onChange;

  useEffect(() => {
    if (!enabled || typeof EventSource === 'undefined') return undefined;
    const access = tokens.access;
    if (!access) return undefined;

    let stopped = false;
    let controller = null;

    (async () => {
      while (!stopped) {
        controller = new AbortController();
        try {
          const res = await fetch('/api/events/slots', {
            headers: { Authorization: `Bearer ${access}`, Accept: 'text/event-stream' },
            signal: controller.signal,
          });
          if (!res.ok || !res.body) return; // 401/403: stop instead of looping
          for await (const message of sseEvents(res.body)) {
            if (stopped) return;
            if (message.event === 'slot_changed') {
              try {
                handler.current?.(JSON.parse(message.data));
              } catch {
                handler.current?.(null);
              }
            }
          }
        } catch (err) {
          if (stopped) return;
        }
        if (!stopped) await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    })();

    return () => {
      stopped = true;
      controller?.abort();
    };
  }, [enabled]);
}
