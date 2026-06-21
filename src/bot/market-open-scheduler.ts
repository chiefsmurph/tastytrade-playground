import everyFourMinutes from "./every-four-minutes";
import {
  CurrentEquitiesSession,
  getCurrentEquitiesSession,
  isEquityOptionsMarketOpen,
} from "../core/market-sessions";

const OPEN_INTERVAL_MS = 4 * 60 * 1000;
const CLOSED_INTERVAL_MS = 60 * 1000;

type SchedulerMode =
  | "stopped"
  | "waiting-for-open"
  | "waiting-for-next-run"
  | "running";

export interface MarketOpenSchedulerStatus {
  inFlight: boolean;
  lastCheckAt?: string;
  lastError?: string;
  lastRunAt?: string;
  lastSession?: CurrentEquitiesSession;
  mode: SchedulerMode;
  nextCheckAt?: string;
  started: boolean;
}

type SchedulerState = MarketOpenSchedulerStatus & {
  lastRunAtMs?: number;
  timer?: NodeJS.Timeout;
};

const schedulerState: SchedulerState = {
  inFlight: false,
  mode: "stopped",
  started: false,
};

function clearScheduledTick() {
  if (schedulerState.timer) {
    clearTimeout(schedulerState.timer);
    schedulerState.timer = undefined;
  }
}

function scheduleNextTick(delayMs: number) {
  clearScheduledTick();
  const boundedDelay = Math.max(0, delayMs);
  schedulerState.nextCheckAt = new Date(Date.now() + boundedDelay).toISOString();
  schedulerState.timer = setTimeout(() => {
    void runSchedulerTick();
  }, boundedDelay);
}

async function runSchedulerTick() {
  if (!schedulerState.started || schedulerState.inFlight) {
    return;
  }

  schedulerState.inFlight = true;
  schedulerState.lastCheckAt = new Date().toISOString();
  schedulerState.lastError = undefined;

  try {
    const session = await getCurrentEquitiesSession();
    schedulerState.lastSession = session;

    if (!isEquityOptionsMarketOpen(session)) {
      schedulerState.mode = "waiting-for-open";
      scheduleNextTick(CLOSED_INTERVAL_MS);
      return;
    }

    const nowMs = Date.now();
    const shouldRunNow =
      schedulerState.lastRunAtMs == null ||
      nowMs - schedulerState.lastRunAtMs >= OPEN_INTERVAL_MS;

    if (!shouldRunNow) {
      schedulerState.mode = "waiting-for-next-run";
      const lastRunAtMs = schedulerState.lastRunAtMs ?? nowMs;
      scheduleNextTick(OPEN_INTERVAL_MS - (nowMs - lastRunAtMs));
      return;
    }

    schedulerState.mode = "running";
    const runStartedAtMs = Date.now();
    await everyFourMinutes();
    schedulerState.lastRunAtMs = runStartedAtMs;
    schedulerState.lastRunAt = new Date(runStartedAtMs).toISOString();
    schedulerState.mode = "waiting-for-next-run";
    scheduleNextTick(
      Math.max(0, OPEN_INTERVAL_MS - (Date.now() - runStartedAtMs)),
    );
  } catch (error) {
    schedulerState.lastError =
      error instanceof Error ? error.message : String(error);
    schedulerState.mode = "waiting-for-open";
    scheduleNextTick(CLOSED_INTERVAL_MS);
  } finally {
    schedulerState.inFlight = false;
  }
}

export function getMarketOpenSchedulerStatus(): MarketOpenSchedulerStatus {
  return {
    inFlight: schedulerState.inFlight,
    lastCheckAt: schedulerState.lastCheckAt,
    lastError: schedulerState.lastError,
    lastRunAt: schedulerState.lastRunAt,
    lastSession: schedulerState.lastSession,
    mode: schedulerState.mode,
    nextCheckAt: schedulerState.nextCheckAt,
    started: schedulerState.started,
  };
}

export function startMarketOpenScheduler(): MarketOpenSchedulerStatus {
  if (schedulerState.started) {
    return getMarketOpenSchedulerStatus();
  }

  schedulerState.started = true;
  schedulerState.mode = "waiting-for-open";
  scheduleNextTick(0);
  return getMarketOpenSchedulerStatus();
}

export function stopMarketOpenScheduler(): MarketOpenSchedulerStatus {
  clearScheduledTick();
  schedulerState.started = false;
  schedulerState.inFlight = false;
  schedulerState.mode = "stopped";
  schedulerState.nextCheckAt = undefined;
  return getMarketOpenSchedulerStatus();
}