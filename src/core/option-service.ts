import { MarketDataSubscriptionType } from "./tastytrade-sdk";
import { getBotConfig } from "./bot-config";
import { safeJson } from "./logging";
import { getUnderlyingPrice } from "./market-data";
import tastytradeApi from "./tastytrade-client";
import { OptionChain, OptionChains, OptionChainWithVolumes } from "./types";

const MAX_VOLUME_SAMPLE_DTE = 50;
const MAX_STRIKES_PER_EXPIRATION_FOR_VOLUME = 10;
const MAX_STRIKE_DISTANCE_RATIO_FOR_VOLUME = 0.12;

export interface OptionLiquidity {
  dayVolume?: number;
  openInterest?: number;
}

export async function fetchOptionChain(symbol: string): Promise<OptionChain> {
  const data: OptionChains =
    await tastytradeApi.instrumentsService.getNestedOptionChain(symbol);
  if (data.length > 1 && getBotConfig().logging.logRawBrokerPayloads) {
    console.warn(
      `Received multiple option chains for symbol ${symbol}, using the first one. Data:`,
      safeJson(data),
    );
  }
  return data[0];
}

function toNumber(value: string | number | undefined): number {
  if (typeof value === "number") {
    return value;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function filterOptionChainForVolumeSampling(
  optionChain: OptionChain,
  underlyingPrice: number,
): OptionChain {
  const maxStrikeDistance =
    underlyingPrice > 0
      ? underlyingPrice * MAX_STRIKE_DISTANCE_RATIO_FOR_VOLUME
      : Number.POSITIVE_INFINITY;

  return {
    ...optionChain,
    expirations: optionChain.expirations
      .filter(
        (expiration) =>
          toNumber(expiration["days-to-expiration"]) <= MAX_VOLUME_SAMPLE_DTE,
      )
      .map((expiration) => {
        const strikesWithinBand = expiration.strikes.filter((strike) => {
          const strikePrice = toNumber(strike["strike-price"]);
          return Math.abs(strikePrice - underlyingPrice) <= maxStrikeDistance;
        });
        const candidateStrikes =
          strikesWithinBand.length > 0 ? strikesWithinBand : expiration.strikes;
        const strikes = [...candidateStrikes]
          .sort((left, right) => {
            const leftDistance = Math.abs(
              toNumber(left["strike-price"]) - underlyingPrice,
            );
            const rightDistance = Math.abs(
              toNumber(right["strike-price"]) - underlyingPrice,
            );
            return leftDistance - rightDistance;
          })
          .slice(0, MAX_STRIKES_PER_EXPIRATION_FOR_VOLUME);

        return {
          ...expiration,
          strikes,
        };
      })
      .filter((expiration) => expiration.strikes.length > 0),
  };
}

export async function fetchOptionVolumes(
  optionChain: OptionChain,
  sampleMs = 5000,
) {
  try {
    if (getBotConfig().logging.logRawBrokerPayloads) {
      console.log(safeJson({ nested: optionChain }));
    }
    const streamerSymbols = new Set<string>();
    function collect(obj: any) {
      if (!obj || typeof obj !== "object") return;
      for (const [k, v] of Object.entries(obj)) {
        if (typeof v === "string" && /streamer-symbol|streamer/.test(k)) {
          streamerSymbols.add(v);
        } else if (typeof v === "object") {
          collect(v);
        }
      }
    }
    collect(optionChain);
    const resolvedStreamerSymbols = Array.from(streamerSymbols);
    console.log({ streamerSymbols: resolvedStreamerSymbols });

    if (resolvedStreamerSymbols.length === 0) {
      console.warn(
        "No streamer symbols found in nested option chain for",
        optionChain["underlying-symbol"],
      );
      return {};
    }

    if (!tastytradeApi.quoteStreamer.dxLinkFeed) {
      await tastytradeApi.quoteStreamer.connect();
    }

    const liquidityBySymbol: Record<string, OptionLiquidity> = {};
    let rawEventCount = 0;

    function toNumberMaybe(value: any): number | null {
      if (value == null) return null;
      if (typeof value === "number" && !Number.isNaN(value)) return value;
      if (typeof value === "string") {
        const n = Number(value);
        return Number.isFinite(n) ? n : null;
      }
      return null;
    }

    function extractLiquidityFromEvent(
      ev: any,
    ): { symbol?: string; dayVolume?: number; openInterest?: number } | null {
      if (!ev) return null;

      const symbol =
        ev.eventSymbol || ev.symbol || ev.s || ev.t || ev.ticker || ev[1];

      const dayVolume = toNumberMaybe(
        ev.dayVolume ?? ev["day-volume"] ?? ev.volume ?? null,
      );
      const openInterest = toNumberMaybe(
        ev.openInterest ?? ev["open-interest"] ?? null,
      );

      if (dayVolume != null || openInterest != null) {
        return { symbol, dayVolume: dayVolume ?? undefined, openInterest: openInterest ?? undefined };
      }

      return null;
    }

    const removeListener = tastytradeApi.quoteStreamer.addEventListener(
      (events: any[]) => {
        const arr = Array.isArray(events) ? events : [events];
        for (const ev of arr) {
          rawEventCount += 1;
          if (rawEventCount <= 10 && getBotConfig().logging.logRawBrokerPayloads) {
            console.log("raw event:", safeJson(ev));
          }

          try {
            const parsed = extractLiquidityFromEvent(ev);
            if (parsed?.symbol) {
              const existing = liquidityBySymbol[parsed.symbol] ?? {};
              liquidityBySymbol[parsed.symbol] = {
                dayVolume:
                  parsed.dayVolume == null
                    ? existing.dayVolume
                    : Math.max(existing.dayVolume ?? 0, parsed.dayVolume),
                openInterest:
                  parsed.openInterest == null
                    ? existing.openInterest
                    : Math.max(existing.openInterest ?? 0, parsed.openInterest),
              };
            }
          } catch (e) {}
        }
      },
    );

    tastytradeApi.quoteStreamer.subscribe(resolvedStreamerSymbols, [
      MarketDataSubscriptionType.Summary,
      MarketDataSubscriptionType.Profile,
      MarketDataSubscriptionType.Quote,
    ]);

    await new Promise((res) => setTimeout(res, sampleMs));

    tastytradeApi.quoteStreamer.unsubscribe(resolvedStreamerSymbols);
    removeListener();

    if (rawEventCount === 0) {
      console.warn(
        "No raw events received from quoteStreamer — check authentication and connectivity.",
      );
    }

    return liquidityBySymbol;
  } catch (err: any) {
    console.error("Error collecting option volumes:", err?.message || err);
    throw err;
  }
}

export function candidateSymbolsFor(raw: string | undefined) {
  if (!raw) return [];
  const out = new Set<string>();
  out.add(raw);
  out.add(raw.replace(/^\.\//, ""));
  out.add(raw.replace(/^\./, ""));
  out.add(raw.replace(/:.+$/, ""));
  out.add(raw.startsWith(".") ? raw : `.${raw}`);
  out.add(raw.startsWith(".") ? raw.slice(1) : raw);
  return Array.from(out);
}

export function mergeVolumesIntoChain(
  chain: OptionChain,
  volumes: Record<string, OptionLiquidity>,
) {
  if (!chain || typeof chain !== "object") return chain;

  function merge(obj: any) {
    if (!obj || typeof obj !== "object") return;
    const keysToCheck = [
      "call-streamer-symbol",
      "put-streamer-symbol",
      "callStreamerSymbol",
      "putStreamerSymbol",
      "call",
      "put",
      "symbol",
    ];
    let attached = false;
    for (const k of keysToCheck) {
      if (k in obj) {
        const raw = obj[k];
        if (typeof raw === "string") {
          const candidates = candidateSymbolsFor(raw);
          for (const c of candidates) {
            if (volumes[c]) {
              const side = k.includes("call")
                ? "callVolume"
                : k.includes("put")
                  ? "putVolume"
                  : "volume";
              if (side === "callVolume") {
                obj.callDayVolume = volumes[c].dayVolume ?? 0;
                obj.callOpenInterest = volumes[c].openInterest ?? 0;
                obj.callVolume = obj.callDayVolume;
              } else if (side === "putVolume") {
                obj.putDayVolume = volumes[c].dayVolume ?? 0;
                obj.putOpenInterest = volumes[c].openInterest ?? 0;
                obj.putVolume = obj.putDayVolume;
              } else {
                obj.dayVolume = volumes[c].dayVolume ?? 0;
                obj.openInterest = volumes[c].openInterest ?? 0;
                obj.volume = obj.dayVolume;
              }
              attached = true;
              break;
            }
          }
        }
      }
    }

    for (const v of Object.values(obj)) {
      if (typeof v === "object") merge(v);
    }
    return attached;
  }

  const cloned = JSON.parse(JSON.stringify(chain));
  merge(cloned);
  return cloned as OptionChainWithVolumes;
}

export async function fetchOptionChainWithVolume(symbol: string) {
  const optionChain = await fetchOptionChain(symbol);
  const underlyingPrice = await getUnderlyingPrice(symbol);
  const filteredForVolumeSampling = filterOptionChainForVolumeSampling(
    optionChain,
    underlyingPrice?.underlyingPrice || 0,
  );
  const totalStrikeCount = optionChain.expirations.reduce(
    (sum, expiration) => sum + expiration.strikes.length,
    0,
  );
  const sampledStrikeCount = filteredForVolumeSampling.expirations.reduce(
    (sum, expiration) => sum + expiration.strikes.length,
    0,
  );
  if (getBotConfig().logging.logRawBrokerPayloads) {
    console.log(`Option chain for ${symbol}`, safeJson(optionChain));
  }
  console.log(
    JSON.stringify({
      scope: "option-volume-sampling-filter",
      symbol,
      totalExpirations: optionChain.expirations.length,
      sampledExpirations: filteredForVolumeSampling.expirations.length,
      totalStrikes: totalStrikeCount,
      sampledStrikes: sampledStrikeCount,
      maxDte: MAX_VOLUME_SAMPLE_DTE,
      maxStrikeDistanceRatio: MAX_STRIKE_DISTANCE_RATIO_FOR_VOLUME,
      maxStrikesPerExpiration: MAX_STRIKES_PER_EXPIRATION_FOR_VOLUME,
      underlyingPrice: underlyingPrice?.underlyingPrice ?? null,
    }),
  );
  const optionVolumes = await fetchOptionVolumes(filteredForVolumeSampling, 5000);
  const merged = mergeVolumesIntoChain(optionChain, optionVolumes);
  if (getBotConfig().logging.logRawBrokerPayloads) {
    console.log("Merged option chain with volumes:", safeJson(merged));
  }
  return merged;
}
