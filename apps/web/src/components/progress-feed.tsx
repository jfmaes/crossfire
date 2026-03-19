import { useEffect, useState } from "react";

interface ProgressEvent {
  sessionId: string;
  type: string;
  message: string;
  model?: string;
  phase?: string;
  turnNumber?: number;
  elapsedMs?: number;
  disagreements?: number;
}

export function ProgressFeed({ sessionId }: { sessionId: string | null }) {
  const [events, setEvents] = useState<ProgressEvent[]>([]);

  useEffect(() => {
    if (typeof EventSource === "undefined") return;
    const source = new EventSource("/progress");

    source.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data) as ProgressEvent;
        if (!sessionId || event.sessionId === sessionId) {
          setEvents((prev) => [...prev.slice(-30), event]);
        }
      } catch {
        // Ignore malformed events
      }
    };

    return () => source.close();
  }, [sessionId]);

  if (events.length === 0) {
    return null;
  }

  return (
    <div className="progress-feed">
      <h3 className="progress-feed__title">Live progress</h3>
      <div className="progress-feed__log">
        {events.map((e, i) => (
          <div key={i} className={`progress-feed__event progress-feed__event--${e.type}`}>
            {e.model && <span className={`progress-feed__model progress-feed__model--${e.model}`}>{e.model.toUpperCase()}</span>}
            <span className="progress-feed__message">{e.message}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
