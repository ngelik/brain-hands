import type { SafeProgressEvent } from "./events.js";
import { formatProgressEvent } from "./log.js";

export interface ProgressViewReducer {
  push(event: SafeProgressEvent): Promise<void>;
  flush(): Promise<void>;
}

export interface ProgressViewReducerInput {
  emit(row: string): void | Promise<void>;
}

type PendingHeartbeat = {
  key: string;
  count: number;
  first: SafeProgressEvent;
  last: SafeProgressEvent;
};

type PendingWarning = {
  key: string;
  count: number;
  first: SafeProgressEvent;
  last: SafeProgressEvent;
};

function timestamp(value: string): string {
  return `${value.slice(0, 19).replace("T", " ")} UTC`;
}

function coordinate(event: SafeProgressEvent, name: string): string {
  const parts = event.event_key.split(":");
  const index = parts.lastIndexOf(name);
  return index >= 0 && index + 1 < parts.length ? parts[index + 1]! : "";
}

function workItemKey(event: SafeProgressEvent): string {
  return event.work_item
    ? `${event.work_item.index}/${event.work_item.total}/${event.work_item.attempt}/${event.work_item.final}`
    : "";
}

function heartbeatKey(event: SafeProgressEvent): string {
  return [
    event.worker_session_id ?? "",
    coordinate(event, "invocation"),
    event.source,
    workItemKey(event),
  ].join("|");
}

function warningKey(event: SafeProgressEvent): string {
  return [
    event.source,
    coordinate(event, "invocation"),
    coordinate(event, "warning") || "generic",
  ].join("|");
}

function isHeartbeat(event: SafeProgressEvent): boolean {
  return event.event_key.includes(":heartbeat:");
}

function isProgressWarning(event: SafeProgressEvent): boolean {
  return event.event_key.split(":")[1] === "progress_warning";
}

function heartbeatRow(pending: PendingHeartbeat): string {
  const noun = pending.count === 1 ? "heartbeat" : "heartbeats";
  const label = pending.last.safe_label.replace(" is still running", " still running");
  return `${timestamp(pending.last.timestamp)}  ${label} (${pending.count} ${noun}, last activity ${timestamp(pending.last.timestamp)})`;
}

function warningRow(pending: PendingWarning): string {
  if (pending.count === 1) return formatProgressEvent(pending.last);
  return `${timestamp(pending.last.timestamp)}  ${pending.last.safe_label} (${pending.count} identical warnings)`;
}

export function createProgressViewReducer(input: ProgressViewReducerInput): ProgressViewReducer {
  let heartbeat: PendingHeartbeat | null = null;
  let warning: PendingWarning | null = null;

  const flushHeartbeat = async (): Promise<void> => {
    if (!heartbeat) return;
    const row = heartbeatRow(heartbeat);
    heartbeat = null;
    await input.emit(row);
  };
  const flushWarning = async (): Promise<void> => {
    if (!warning) return;
    const row = warningRow(warning);
    warning = null;
    await input.emit(row);
  };

  return {
    async push(event): Promise<void> {
      if (isHeartbeat(event)) {
        await flushWarning();
        const key = heartbeatKey(event);
        if (heartbeat && heartbeat.key === key) {
          heartbeat = { ...heartbeat, count: heartbeat.count + 1, last: event };
          return;
        }
        await flushHeartbeat();
        heartbeat = { key, count: 1, first: event, last: event };
        return;
      }
      if (isProgressWarning(event)) {
        await flushHeartbeat();
        const key = warningKey(event);
        if (warning && warning.key === key) {
          warning = { ...warning, count: warning.count + 1, last: event };
          return;
        }
        await flushWarning();
        warning = { key, count: 1, first: event, last: event };
        return;
      }
      await flushHeartbeat();
      await flushWarning();
      await input.emit(formatProgressEvent(event));
    },
    async flush(): Promise<void> {
      await flushHeartbeat();
      await flushWarning();
    },
  };
}
