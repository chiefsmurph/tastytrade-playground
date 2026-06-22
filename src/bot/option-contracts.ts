import { getBotConfig, OptionSide } from "../core/bot-config";
import {
  OptionChain,
  OptionChainWithVolumes,
  StrikeWithVolumes,
} from "../core/types";

const MIN_DTE = 28; // 4 weeks
const MAX_DTE = 42; // 6 weeks
const STRIKES_AROUND_ATM = 2;

export interface OptionCandidateSelectionOptions {
  allowDteFallback?: boolean;
  maxDTE?: number;
  minDTE?: number;
  preferredDTE?: number;
}

export interface CandidateExpirationSelection {
  expirations: OptionChainWithVolumes["expirations"];
  usedDteFallback: boolean;
}

export interface OptionCandidate extends StrikeWithVolumes {
  dte: number;
  expirationDate: string;
  expirationType: string;
  dayVolume: number;
  meetsLiquidityRequirement?: boolean;
  openInterest: number;
  orderSymbol?: string;
  quoteSymbol?: string;
  side: OptionSide;
  streamerSymbol?: string;
  strike: number;
  symbol?: string;
}

function num(value: string | number): number {
  return typeof value === "number" ? value : Number(value);
}

export function getOptionCandidateVolume(
  candidate: Pick<OptionCandidate, "callDayVolume" | "callVolume" | "dayVolume" | "putDayVolume" | "putVolume">,
  side: OptionSide,
): number {
  if ("dayVolume" in candidate && candidate.dayVolume != null) {
    return Number(candidate.dayVolume || 0);
  }

  return side === "call"
    ? Number(candidate.callDayVolume ?? candidate.callVolume ?? 0)
    : Number(candidate.putDayVolume ?? candidate.putVolume ?? 0);
}

export function getOptionCandidateOpenInterest(
  candidate: Pick<OptionCandidate, "callOpenInterest" | "openInterest" | "putOpenInterest">,
  side: OptionSide,
): number {
  if ("openInterest" in candidate && candidate.openInterest != null) {
    return Number(candidate.openInterest || 0);
  }

  return side === "call"
    ? Number(candidate.callOpenInterest ?? 0)
    : Number(candidate.putOpenInterest ?? 0);
}

export function meetsLiquidityRequirement(candidate: OptionCandidate): boolean {
  const { liquidity } = getBotConfig();
  return (
    candidate.dayVolume >= liquidity.minDayVolume &&
    candidate.openInterest >= liquidity.minOpenInterest
  );
}

export async function getOptionCandidates(
  symbol: string,
  side: OptionSide = "call",
  selectionOptions?: OptionCandidateSelectionOptions,
): Promise<ReturnType<typeof chooseOptionCandidates>> {
  const [{ getUnderlyingPrice }, { fetchOptionChainWithVolume }] =
    await Promise.all([
      import("../core/market-data"),
      import("../core/option-service"),
    ]);
  const optionChain = await fetchOptionChainWithVolume(symbol);
  const underlyingPrice = await getUnderlyingPrice(symbol);
  const optionCandidates = chooseOptionCandidates(
    optionChain,
    underlyingPrice?.underlyingPrice || 0,
    side,
    selectionOptions,
  ).map((candidate) => ({
    ...candidate,
    meetsLiquidityRequirement: meetsLiquidityRequirement(candidate),
  }));
  if (optionCandidates.length === 0) {
    console.log("No option candidates found for", symbol);
    const fallbackOptionChainsByVolume = sortOptionChainByVolume(
      optionChain,
      side,
    );
    console.log(
      "Option chains sorted by volume:",
      JSON.stringify(fallbackOptionChainsByVolume, null, 2),
    );
  }
  return optionCandidates;
}

export function sortOptionChainByVolume(
  optionChain: OptionChainWithVolumes,
  side: OptionSide = "call",
) {
  const sorted = optionChain.expirations
    .map(({ strikes, ...expiration }) =>
      strikes.map((strike) => ({
        ...expiration,
        ...strike,
        meetsLiquidityRequirement:
          Number(strike[`${side}DayVolume`] ?? strike[`${side}Volume`] ?? 0) >=
            getBotConfig().liquidity.minDayVolume &&
          Number(strike[`${side}OpenInterest`] ?? 0) >=
            getBotConfig().liquidity.minOpenInterest,
      })),
    )
    .flat()
    .sort(
      (a, b) =>
        Number(b[`${side}DayVolume`] ?? b[`${side}Volume`] ?? 0) -
        Number(a[`${side}DayVolume`] ?? a[`${side}Volume`] ?? 0),
    );
  return sorted;
}

export function chooseOptionCandidates(
  optionChain: OptionChainWithVolumes,
  underlyingPrice: number,
  side: OptionSide = "call",
  selectionOptions: OptionCandidateSelectionOptions = {},
): OptionCandidate[] {
  const { expirations, usedDteFallback } = resolveCandidateExpirations(
    optionChain,
    selectionOptions,
  );

  if (usedDteFallback) {
    console.warn(
      "No expirations found within DTE range for",
      optionChain["underlying-symbol"],
      "falling back to nearest available expiration",
    );
  }

  const candidates: OptionCandidate[] = [];

  for (const exp of expirations) {
    const strikes = exp.strikes
      .map((strike) => {
        const orderSymbol = side === "call" ? strike.call : strike.put;
        const streamerSymbol =
          side === "call"
            ? strike["call-streamer-symbol"]
            : strike["put-streamer-symbol"];
        const dayVolume =
          side === "call"
            ? Number(strike.callDayVolume ?? strike.callVolume ?? 0)
            : Number(strike.putDayVolume ?? strike.putVolume ?? 0);
        const openInterest =
          side === "call"
            ? Number(strike.callOpenInterest ?? 0)
            : Number(strike.putOpenInterest ?? 0);

        return {
          expirationDate: exp["expiration-date"],
          expirationType: exp["expiration-type"],
          dte: num(exp["days-to-expiration"]),
          strike: num(strike["strike-price"]),
          side,
          symbol: orderSymbol,
          orderSymbol,
          quoteSymbol: streamerSymbol ?? orderSymbol,
          streamerSymbol,
          dayVolume,
          openInterest,
          ...strike,
        };
      })
      .sort((a, b) => num(a["strike-price"]) - num(b["strike-price"]));

    const itm = strikes.filter((strike) =>
      side === "call"
        ? strike.strike < underlyingPrice
        : strike.strike > underlyingPrice,
    );

    if (!itm.length) continue;

    const closestItmIndex = side === "call" ? itm.length - 1 : 0;

    if (side === "call") {
      for (
        let i = closestItmIndex;
        i >= Math.max(0, closestItmIndex - STRIKES_AROUND_ATM);
        i--
      ) {
        candidates.push(itm[i]);
      }
    } else {
      for (
        let i = closestItmIndex;
        i <= Math.min(itm.length - 1, closestItmIndex + STRIKES_AROUND_ATM);
        i++
      ) {
        candidates.push(itm[i]);
      }
    }
  }

  return candidates;
}

export function resolveCandidateExpirations(
  optionChain: OptionChainWithVolumes,
  selectionOptions: OptionCandidateSelectionOptions = {},
): CandidateExpirationSelection {
  const minDTE = selectionOptions.minDTE ?? MIN_DTE;
  const maxDTE = selectionOptions.maxDTE ?? MAX_DTE;
  const preferredDTE = selectionOptions.preferredDTE ?? 35;
  const allowDteFallback =
    selectionOptions.allowDteFallback ?? getBotConfig().strategy.allowDteFallback;
  const expirationsInRange = optionChain.expirations
    .filter((exp) => {
      const dte = num(exp["days-to-expiration"]);
      return dte >= minDTE && dte <= maxDTE;
    })
    .sort((a, b) => compareExpirations(a, b, preferredDTE));
  const expirations =
    expirationsInRange.length > 0
      ? expirationsInRange
      : allowDteFallback
        ? [...optionChain.expirations].sort((a, b) =>
            compareExpirations(a, b, preferredDTE),
          )
        : [];

  if (!expirationsInRange.length) {
    if (!expirations.length) {
      console.warn(
        allowDteFallback
          ? "No expirations found for"
          : "No expirations found within DTE range and fallback disabled for",
        optionChain["underlying-symbol"],
      );
      return { expirations: [], usedDteFallback: false };
    }
  }

  return {
    expirations,
    usedDteFallback: expirationsInRange.length === 0 && allowDteFallback,
  };
}

function compareExpirations(
  a: OptionChainWithVolumes["expirations"][number],
  b: OptionChainWithVolumes["expirations"][number],
  preferredDTE: number,
) {
  // Prefer regular monthly expirations, then closer to the preferred DTE.
  const aRegular = a["expiration-type"] === "Regular" ? 0 : 1;
  const bRegular = b["expiration-type"] === "Regular" ? 0 : 1;

  if (aRegular !== bRegular) {
    return aRegular - bRegular;
  }

  return (
    Math.abs(num(a["days-to-expiration"]) - preferredDTE) -
    Math.abs(num(b["days-to-expiration"]) - preferredDTE)
  );
}
