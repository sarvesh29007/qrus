import { useCallback, useEffect, useRef, useState } from 'react';
import { api, tokens } from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';

/**
 * Floating "Qrus assistant" chatbot.
 *
 * Behaviour worth knowing:
 *   * The session is created lazily, on the first time the panel is opened,
 *     so loading a portal never spends a request on a widget nobody uses.
 *   * The JWT is attached by the shared `api()` client, which also refreshes
 *     once on a 401 and replays — so a long chat that outlives an access
 *     token keeps working without dumping the patient back to the login page.
 *   * Bot messages can arrive as a numbered list ("reply with a number to
 *     book"). Tapping a chip sends just that digit, which is exactly what the
 *     server's pending-state resolver expects.
 *   * The panel is a dialog with a focus trap and Escape-to-close, because a
 *     floating widget that keyboard users cannot dismiss is a trap.
 */

const GREETING_HINTS = [
  'I have chest pain when I walk upstairs',
  'Where am I in the queue?',
  'Book an appointment',
  'What are your clinic hours?',
];

export default function ChatBot() {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [sessionId, setSessionId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [awaiting, setAwaiting] = useState(null);
  const [unread, setUnread] = useState(0);

  const scrollRef = useRef(null);
  const inputRef = useRef(null);
  const panelRef = useRef(null);
  const sessionRef = useRef(null);

  // Keep the latest session id in a ref so the send handler never closes over
  // a stale one mid-conversation.
  sessionRef.current = sessionId;

  const isOpenRef = useRef(open);
  isOpenRef.current = open;

  /** Create the conversation on first open. */
  const ensureSession = useCallback(async () => {
    if (sessionRef.current) return sessionRef.current;
    const created = await api('/chat/sessions', { method: 'POST', body: {} });
    setSessionId(created.session.id);
    setMessages(created.messages.map(toUiMessage));
    setAwaiting(created.awaiting || null);
    return created.session.id;
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const id = await ensureSession();
        if (!cancelled) inputRef.current?.focus();
        return id;
      } catch (err) {
        if (!cancelled) {
          setMessages((prev) => [
            ...prev,
            {
              id: `err-${Date.now()}`,
              sender: 'bot',
              content:
                err.status === 429
                  ? 'You are sending messages a little too quickly — give it a few seconds.'
                  : 'I could not reach the assistant just now. Please try again in a moment.',
              intent: 'error',
            },
          ]);
        }
        return null;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, ensureSession]);

  // Auto-scroll on new content, and focus the input while open.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, sending, open]);

  useEffect(() => {
    if (!open) return undefined;
    inputRef.current?.focus();

    // Escape closes; Tab cycles inside the panel rather than escaping into the
    // page behind it.
    function onKeyDown(event) {
      if (event.key === 'Escape') {
        event.stopPropagation();
        setOpen(false);
        return;
      }
      if (event.key !== 'Tab' || !panelRef.current) return;
      const focusable = panelRef.current.querySelectorAll(
        'button:not([disabled]), textarea, input, a[href]'
      );
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [open]);

  async function send(text) {
    const content = String(text ?? '').trim();
    if (!content || sending) return;

    setDraft('');
    setMessages((prev) => [
      ...prev,
      { id: `u-${Date.now()}`, sender: 'user', content, intent: null },
    ]);
    setSending(true);

    try {
      const id = sessionRef.current || (await ensureSession());
      const data = await api(`/chat/sessions/${id}/messages`, {
        method: 'POST',
        body: { content },
      });

      setMessages((prev) => [
        ...prev,
        {
          id: data.message.id,
          sender: 'bot',
          content: data.message.content,
          intent: data.message.intent,
          source: data.message.metadata?.source,
        },
      ]);
      setAwaiting(data.awaiting || null);

      if (!isOpenRef.current) setUnread((n) => n + 1);
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        {
          id: `err-${Date.now()}`,
          sender: 'bot',
          content:
            err.code === 'RATE_LIMITED'
              ? 'You are sending messages too quickly — please pause for a moment.'
              : err.status === 401
                ? 'Your session has expired — please sign in again, then reopen the chat.'
                : err.message || 'Something went wrong. Please try again.',
          intent: 'error',
        },
      ]);
    } finally {
      setSending(false);
      inputRef.current?.focus();
    }
  }

  function handleSubmit(event) {
    event.preventDefault();
    send(draft);
  }

  function toggle() {
    setOpen((v) => {
      if (!v) setUnread(0);
      return !v;
    });
  }

  // Signed-out visitors and the login/register screens have no business
  // chatting: the endpoints need a token, so offering the widget would only
  // produce a wall of 401s.
  if (!user || !tokens.access) return null;

  const suggestions = messages.length <= 1 ? GREETING_HINTS : [];

  return (
    <>
      <button
        type="button"
        className="chat-fab"
        onClick={toggle}
        aria-expanded={open}
        aria-controls="qrus-chat-panel"
        aria-label={open ? 'Close the Qrus assistant' : 'Open the Qrus assistant'}
      >
        <span className="chat-fab-icon" aria-hidden="true">{open ? '✕' : '✚'}</span>
        {!open && unread > 0 && <span className="chat-fab-badge">{unread > 9 ? '9+' : unread}</span>}
        {!open && unread === 0 && <span className="chat-fab-label">Assistant</span>}
      </button>

      {open && (
        <div
          className="chat-panel"
          id="qrus-chat-panel"
          role="dialog"
          aria-modal="false"
          aria-label="Qrus assistant"
          ref={panelRef}
        >
          <header className="chat-head">
            <span className="chat-head-mark" aria-hidden="true">✚</span>
            <div className="chat-head-text">
              <strong>Qrus assistant</strong>
              <small>Triage · queues · booking · intake</small>
            </div>
            <button type="button" className="chat-close" onClick={() => setOpen(false)} aria-label="Close chat">
              ✕
            </button>
          </header>

          <div className="chat-body" ref={scrollRef} role="log" aria-live="polite" aria-relevant="additions">
            {messages.map((message) => (
              <Bubble key={message.id} message={message} />
            ))}

            {sending && (
              <div className="chat-row chat-row-bot" aria-label="Assistant is typing">
                <span className="chat-avatar" aria-hidden="true">✚</span>
                <div className="chat-bubble chat-bubble-typing">
                  <span className="chat-dot" />
                  <span className="chat-dot" />
                  <span className="chat-dot" />
                </div>
              </div>
            )}

            {suggestions.length > 0 && !sending && (
              <div className="chat-suggestions">
                {suggestions.map((hint) => (
                  <button key={hint} type="button" className="chat-chip" onClick={() => send(hint)}>
                    {hint}
                  </button>
                ))}
              </div>
            )}
          </div>

          <form className="chat-input" onSubmit={handleSubmit}>
            <textarea
              ref={inputRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                // Enter sends; Shift+Enter is the newline people expect.
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleSubmit(e);
                }
              }}
              rows={1}
              maxLength={2000}
              placeholder={awaiting ? 'Type your answer…' : 'Describe symptoms, book, cancel, check queue…'}
              aria-label="Message the Qrus assistant"
            />
            <button type="submit" className="chat-send" disabled={sending || !draft.trim()}>
              {sending ? '…' : 'Send'}
            </button>
          </form>
        </div>
      )}
    </>
  );
}

function toUiMessage(message) {
  return {
    id: message.id,
    sender: message.sender,
    content: message.content,
    intent: message.intent,
    source: message.metadata?.source,
  };
}

function Bubble({ message }) {
  if (message.sender === 'user') {
    return (
      <div className="chat-row chat-row-user">
        <div className="chat-bubble chat-bubble-user">{message.content}</div>
      </div>
    );
  }

  return (
    <div className="chat-row chat-row-bot">
      <span className="chat-avatar" aria-hidden="true">✚</span>
      {/* Whitespace preserved so the bot's numbered lists and line breaks
          survive; links are never rendered as HTML, only as text. */}
      <div className={`chat-bubble chat-bubble-bot${message.intent === 'error' ? ' is-error' : ''}`}>
        {message.content}
      </div>
    </div>
  );
}
