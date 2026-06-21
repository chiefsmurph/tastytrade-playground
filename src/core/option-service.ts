import { getUnderlyingPrice } from "./market-data";
import tastytradeApi from "./tastytrade-client";
import { OptionChain, OptionChains, OptionChainWithVolumes } from "./types";

const MAX_VOLUME_SAMPLE_DTE = 50;
const MAX_STRIKES_PER_EXPIRATION_FOR_VOLUME = 10;
const MAX_STRIKE_DISTANCE_RATIO_FOR_VOLUME = 0.12;

export async function fetchOptionChain(symbol: string): Promise<OptionChain> {
  const data: OptionChains =
    await tastytradeApi.instrumentsService.getNestedOptionChain(symbol);
  if (data.length > 1) {
    console.warn(
      `Received multiple option chains for symbol ${symbol}, using the first one. Data:`,
      JSON.stringify(data, null, 2),
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
    console.log(JSON.stringify({ nested: optionChain }, null, 2));
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

    await tastytradeApi.quoteStreamer.connect();

    const volumes: Record<string, number> = {};
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

    function extractVolumeFromEvent(
      ev: any,
    ): { symbol?: string; volume?: number; source?: string } | null {
      if (!ev) return null;

      const symbol =
        ev.eventSymbol || ev.symbol || ev.s || ev.t || ev.ticker || ev[1];

      let vol = toNumberMaybe(
        ev.size ?? ev.volume ?? ev.v ?? ev.tradeVolume ?? null,
      );
      if (vol != null)
        return {
          symbol,
          volume: vol,
          source: "trade.size|volume|v|tradeVolume",
        };

      vol = toNumberMaybe(ev.dayVolume ?? ev.prevDayVolume ?? null);
      if (vol != null)
        return { symbol, volume: vol, source: "dayVolume|prevDayVolume" };

      vol = toNumberMaybe(ev.bidSize ?? ev.askSize ?? null);
      if (vol != null)
        return { symbol, volume: vol, source: "bidSize|askSize" };

      vol = toNumberMaybe(ev.openInterest ?? null);
      if (vol != null) return { symbol, volume: vol, source: "openInterest" };

      if (Array.isArray(ev)) {
        const arrSymbol = ev[1];
        for (const item of ev) {
          if (
            typeof item === "number" &&
            Number.isInteger(item) &&
            item > 0 &&
            item < 1e8
          ) {
            return { symbol: arrSymbol, volume: item, source: "array:number" };
          }
          if (typeof item === "string") {
            const n = Number(item);
            if (Number.isFinite(n) && Number.isInteger(n) && n > 0 && n < 1e8) {
              return { symbol: arrSymbol, volume: n, source: "array:string" };
            }
          }
        }
      }

      return null;
    }

    const removeListener = tastytradeApi.quoteStreamer.addEventListener(
      (events: any[]) => {
        const arr = Array.isArray(events) ? events : [events];
        for (const ev of arr) {
          rawEventCount += 1;
          if (rawEventCount <= 10) console.log("raw event:", ev);

          try {
            const parsed = extractVolumeFromEvent(ev);
            if (parsed && parsed.symbol && typeof parsed.volume === "number") {
              console.log(
                "parsed volume from",
                parsed.source,
                "symbol:",
                parsed.symbol,
                "volume:",
                parsed.volume,
              );
              volumes[parsed.symbol] =
                (volumes[parsed.symbol] || 0) + parsed.volume;
            }
          } catch (e) {}
        }
      },
    );

    tastytradeApi.quoteStreamer.subscribe(resolvedStreamerSymbols);

    await new Promise((res) => setTimeout(res, sampleMs));

    tastytradeApi.quoteStreamer.unsubscribe(resolvedStreamerSymbols);
    removeListener();
    tastytradeApi.quoteStreamer.disconnect();

    if (rawEventCount === 0) {
      console.warn(
        "No raw events received from quoteStreamer — check authentication and connectivity.",
      );
    }

    return volumes;
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
  volumes: Record<string, number>,
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
              const short = k.includes("call")
                ? "callVolume"
                : k.includes("put")
                  ? "putVolume"
                  : "volume";
              obj[short] = volumes[c];
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
  console.log(
    `Option chain for ${symbol}`,
    JSON.stringify(optionChain, null, 2),
  );
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
  console.log(
    "Merged option chain with volumes:",
    JSON.stringify(merged, null, 2),
  );
  return merged;
}
