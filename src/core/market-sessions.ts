type AnyRecord = Record<string, unknown>;

export interface CurrentEquitiesSession {
  closeAtExt?: string;
  closesAt?: string;
  isOpen: boolean;
  isRegularSession: boolean;
  opensAt?: string;
  raw: unknown;
  sessionLabel?: string;
  sessionStatus?: string;
}

function asRecord(value: unknown): AnyRecord | null {
  if (value && typeof value === "object") {
    return value as AnyRecord;
  }

  return null;
}

function extractResponseData(response: unknown): unknown {
  const responseRecord = asRecord(response);
  const responseData = asRecord(responseRecord?.data);
  const nestedData = responseData?.data;

  if (nestedData != null) {
    return nestedData;
  }

  return responseData ?? response;
}

function unwrapCurrentSession(value: unknown): unknown {
  const record = asRecord(value);
  if (!record) {
    return value;
  }

  return record["current-session"] ?? record.currentSession ?? record.session ?? value;
}

function readString(record: AnyRecord | null, keys: string[]): string | undefined {
  if (!record) {
    return undefined;
  }

  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }

  return undefined;
}

function parseTimestamp(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isBetweenRegularSession(
  opensAt: string | undefined,
  closesAt: string | undefined,
  now = new Date(),
): boolean {
  const opensAtMs = parseTimestamp(opensAt);
  const closesAtMs = parseTimestamp(closesAt);
  if (opensAtMs != null && closesAtMs != null) {
    const nowMs = now.getTime();
    return nowMs >= opensAtMs && nowMs < closesAtMs;
  }

  return false;
}

function stateAllowsOpen(state: string | undefined): boolean {
  if (!state) {
    return false;
  }

  const normalized = state.trim().toLowerCase();
  return normalized === "open";
}

export function parseCurrentEquitiesSession(
  response: unknown,
  now = new Date(),
): CurrentEquitiesSession {
  const unwrapped = unwrapCurrentSession(extractResponseData(response));
  const sessionRecord = asRecord(unwrapped);
  const sessionLabel = readString(sessionRecord, [
    "session",
    "session-type",
    "sessionType",
    "type",
    "name",
  ]);
  const sessionStatus = readString(sessionRecord, [
    "state",
    "session-status",
    "sessionStatus",
    "status",
    "market-status",
    "marketStatus",
  ]);
  const opensAt = readString(sessionRecord, [
    "open-at",
    "openAt",
    "start-at",
    "startAt",
  ]);
  const closesAt = readString(sessionRecord, [
    "close-at",
    "closeAt",
    "end-at",
    "endAt",
  ]);
  const closeAtExt = readString(sessionRecord, [
    "close-at-ext",
    "closeAtExt",
    "close_at_ext",
  ]);
  const isOpen =
    stateAllowsOpen(sessionStatus) &&
    isBetweenRegularSession(opensAt, closesAt, now);
  const isRegularSession =
    stateAllowsOpen(sessionStatus) &&
    parseTimestamp(opensAt) != null &&
    parseTimestamp(closesAt) != null;

  return {
    closeAtExt,
    closesAt,
    isOpen,
    isRegularSession,
    opensAt,
    raw: unwrapped,
    sessionLabel,
    sessionStatus,
  };
}

export async function getCurrentEquitiesSession(): Promise<CurrentEquitiesSession> {
  const { default: tastytradeApi } = await import("./tastytrade-client");
  const response = await tastytradeApi.httpClient.getData(
    "/market-time/equities/sessions/current",
  );
  return parseCurrentEquitiesSession(response);
}

export function isEquityOptionsMarketOpen(session: CurrentEquitiesSession): boolean {
  return session.isOpen && session.isRegularSession;
}
