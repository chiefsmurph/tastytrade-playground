import tastytradeApi from "./tastytrade-client";

type AnyRecord = Record<string, unknown>;

export interface CurrentEquitiesSession {
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

function readBoolean(record: AnyRecord | null, keys: string[]): boolean | undefined {
  if (!record) {
    return undefined;
  }

  for (const key of keys) {
    const value = record[key];
    if (typeof value === "boolean") {
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

function inferIsOpen(
  explicitIsOpen: boolean | undefined,
  sessionLabel: string | undefined,
  sessionStatus: string | undefined,
  opensAt: string | undefined,
  closesAt: string | undefined,
): boolean {
  if (explicitIsOpen != null) {
    return explicitIsOpen;
  }

  const opensAtMs = parseTimestamp(opensAt);
  const closesAtMs = parseTimestamp(closesAt);
  const now = Date.now();
  if (opensAtMs != null && closesAtMs != null) {
    return now >= opensAtMs && now < closesAtMs;
  }

  const combined = `${sessionLabel ?? ""} ${sessionStatus ?? ""}`.toLowerCase();
  if (!combined.trim()) {
    return false;
  }

  if (
    combined.includes("closed") ||
    combined.includes("holiday") ||
    combined.includes("halt")
  ) {
    return false;
  }

  return (
    combined.includes("regular") ||
    combined.includes("extended") ||
    combined.includes("pre") ||
    combined.includes("post") ||
    combined.includes("open")
  );
}

function inferIsRegularSession(
  sessionLabel: string | undefined,
  sessionStatus: string | undefined,
  opensAt: string | undefined,
  closesAt: string | undefined,
): boolean {
  const combined = `${sessionLabel ?? ""} ${sessionStatus ?? ""}`.toLowerCase();
  if (combined.includes("regular")) {
    return true;
  }

  if (
    combined.includes("extended") ||
    combined.includes("pre") ||
    combined.includes("post")
  ) {
    return false;
  }

  const opensAtMs = parseTimestamp(opensAt);
  const closesAtMs = parseTimestamp(closesAt);
  if (opensAtMs == null || closesAtMs == null) {
    return false;
  }

  const durationMs = closesAtMs - opensAtMs;
  const durationHours = durationMs / (60 * 60 * 1000);
  return durationHours <= 7.5;
}

export async function getCurrentEquitiesSession(): Promise<CurrentEquitiesSession> {
  const response = await tastytradeApi.httpClient.getData(
    "/market-time/equities/sessions/current",
  );
  const unwrapped = unwrapCurrentSession(extractResponseData(response));
  const sessionRecord = asRecord(unwrapped);
  const sessionLabel = readString(sessionRecord, [
    "session-type",
    "sessionType",
    "type",
    "name",
  ]);
  const sessionStatus = readString(sessionRecord, [
    "session-status",
    "sessionStatus",
    "status",
    "market-status",
    "marketStatus",
  ]);
  const opensAt = readString(sessionRecord, [
    "opens-at",
    "opensAt",
    "start-at",
    "startAt",
    "begins-at",
    "beginsAt",
  ]);
  const closesAt = readString(sessionRecord, [
    "closes-at",
    "closesAt",
    "end-at",
    "endAt",
    "ends-at",
    "endsAt",
  ]);
  const explicitIsOpen = readBoolean(sessionRecord, [
    "is-open",
    "isOpen",
    "open",
  ]);
  const isOpen = inferIsOpen(
    explicitIsOpen,
    sessionLabel,
    sessionStatus,
    opensAt,
    closesAt,
  );
  const isRegularSession = inferIsRegularSession(
    sessionLabel,
    sessionStatus,
    opensAt,
    closesAt,
  );

  return {
    closesAt,
    isOpen,
    isRegularSession,
    opensAt,
    raw: unwrapped,
    sessionLabel,
    sessionStatus,
  };
}

export function isEquityOptionsMarketOpen(session: CurrentEquitiesSession): boolean {
  return session.isOpen && session.isRegularSession;
}