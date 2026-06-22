import { getBotConfig } from "./bot-config";

export interface TimeParts {
  hour: number;
  minute: number;
}

export function getZonedTimeParts(
  date: Date,
  timeZone = getBotConfig().strategy.timezone,
): TimeParts {
  const formatter = new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    hour12: false,
    minute: "2-digit",
    timeZone,
  });
  const parts = formatter.formatToParts(date);
  const hour = Number(parts.find((part) => part.type === "hour")?.value);
  const minute = Number(parts.find((part) => part.type === "minute")?.value);

  return {
    hour: hour === 24 ? 0 : hour,
    minute,
  };
}

export function getPacificMinutes(date: Date): number {
  const { hour, minute } = getZonedTimeParts(date, "America/Los_Angeles");
  return hour * 60 + minute;
}

export function getConfiguredTradingMinutes(date: Date): number {
  const { hour, minute } = getZonedTimeParts(date);
  return hour * 60 + minute;
}
