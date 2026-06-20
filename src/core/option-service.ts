import tastytradeApi from "./tastytrade-client";
import { OptionChain, OptionChains, OptionChainWithVolumes } from "./types";

export async function fetchOptionChains(symbol: string): Promise<OptionChains> {
  const data =
    await tastytradeApi.instrumentsService.getNestedOptionChain(symbol);
  return data;
}

export async function fetchOptionVolumes(symbol: string, sampleMs = 5000) {
  try {
    // @ts-ignore
    const nested = await fetchOptionChains(symbol);
    console.log(JSON.stringify({ nested }, null, 2));
    const streamerSymbols: string[] = [];
    function collect(obj: any) {
      if (!obj || typeof obj !== "object") return;
      for (const [k, v] of Object.entries(obj)) {
        if (typeof v === "string" && /streamer-symbol|streamer/.test(k)) {
          streamerSymbols.push(v);
        } else if (typeof v === "object") {
          collect(v);
        }
      }
    }
    collect(nested);
    console.log({ streamerSymbols });

    if (streamerSymbols.length === 0) {
      console.warn(
        "No streamer symbols found in nested option chain for",
        symbol,
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
          } catch (e) {
          }
        }
      },
    );

    tastytradeApi.quoteStreamer.subscribe(streamerSymbols);

    await new Promise((res) => setTimeout(res, sampleMs));

    tastytradeApi.quoteStreamer.unsubscribe(streamerSymbols);
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
  chain: OptionChains,
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
  return cloned as OptionChainWithVolumes[];
}

export async function fetchOptionChainsWithVolume(symbol: string) {
  const optionChains = await fetchOptionChains(symbol);
  console.log(
    `Option chains for ${symbol}`,
    JSON.stringify(optionChains, null, 2),
  );
  const optionVolumes = await fetchOptionVolumes(symbol, 5000);
  const merged = mergeVolumesIntoChain(optionChains, optionVolumes);
  console.log(
    "Merged option chain with volumes:",
    JSON.stringify(merged, null, 2),
  );
  return merged;
}
