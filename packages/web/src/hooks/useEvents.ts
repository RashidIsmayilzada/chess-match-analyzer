import { useEffect, useRef, useState } from 'react';
import { events, type EventName, type EventPayloads } from '../api/events';

/** Subscribe to one SSE event type for the lifetime of the component. */
export function useEvent<N extends EventName>(
  name: N,
  handler: (payload: EventPayloads[N]) => void,
): void {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => events.subscribe(name, (payload) => ref.current(payload)), [name]);
}

/** Whether the SSE stream is currently open. */
export function useEventsConnected(): boolean {
  const [connected, setConnected] = useState(events.isConnected());
  useEffect(() => events.onConnection(setConnected), []);
  return connected;
}
