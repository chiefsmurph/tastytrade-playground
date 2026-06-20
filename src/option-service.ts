import axios from 'axios';
import tastytradeApi from './tastytradeClient';

export async function fetchOptionChains(symbol: string) {
  try {
    // Prefer using the client library's InstrumentsService
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    if (tastytradeApi.instrumentsService) {
      // prefer nested (less duplication), then full, then compact
      // @ts-ignore
      if (typeof tastytradeApi.instrumentsService.getNestedOptionChain === 'function') {
        // @ts-ignore
        const data = await tastytradeApi.instrumentsService.getNestedOptionChain(symbol);
        return data;
      }
      // @ts-ignore
      if (typeof tastytradeApi.instrumentsService.getOptionChain === 'function') {
        // @ts-ignore
        const data = await tastytradeApi.instrumentsService.getOptionChain(symbol);
        return data;
      }
    }

    const baseUrl = process.env.BASE_URL || 'https://api.tastytrade.com';
    const url = `${baseUrl.replace(/\/$/, '')}/markets/chains/${encodeURIComponent(symbol)}`;

    const headers: any = {};
    if (process.env.API_ACCESS_TOKEN) {
      headers.Authorization = `Bearer ${process.env.API_ACCESS_TOKEN}`;
    }

    const resp = await axios.get(url, {
      headers,
      params: { includeAllExpirations: true },
    });

    return resp.data;
  } catch (err: any) {
    console.error('Error fetching option chains:', err?.response?.data || err.message || err);
    throw err;
  }
}

export async function fetchOptionVolumes(symbol: string, sampleMs = 5000) {
  try {
    // @ts-ignore
    const nested = await tastytradeApi.instrumentsService.getNestedOptionChain(symbol);

    const streamerSymbols: string[] = [];
    function collect(obj: any) {
      if (!obj || typeof obj !== 'object') return;
      for (const [k, v] of Object.entries(obj)) {
        if (typeof v === 'string' && /streamer-symbol|streamer/.test(k)) {
          streamerSymbols.push(v);
        } else if (typeof v === 'object') {
          collect(v);
        }
      }
    }
    collect(nested);

    if (streamerSymbols.length === 0) {
      console.warn('No streamer symbols found in nested option chain for', symbol);
      return {};
    }

    await tastytradeApi.quoteStreamer.connect();

    const volumes: Record<string, number> = {};
    let rawEventCount = 0;

    function toNumberMaybe(value: any): number | null {
      if (value == null) return null;
      if (typeof value === 'number' && !Number.isNaN(value)) return value;
      if (typeof value === 'string') {
        const n = Number(value);
        return Number.isFinite(n) ? n : null;
      }
      return null;
    }

    function extractVolumeFromEvent(ev: any): { symbol?: string; volume?: number } | null {
      if (!ev) return null;

      const symbol = ev.eventSymbol || ev.symbol || ev.s || ev.t || ev.ticker || ev[1];

      let vol = toNumberMaybe(ev.size ?? ev.volume ?? ev.v ?? ev.tradeVolume ?? null);
      if (vol != null) return { symbol, volume: vol };

      vol = toNumberMaybe(ev.dayVolume ?? ev.prevDayVolume ?? null);
      if (vol != null) return { symbol, volume: vol };

      vol = toNumberMaybe(ev.bidSize ?? ev.askSize ?? null);
      if (vol != null) return { symbol, volume: vol };

      vol = toNumberMaybe(ev.openInterest ?? null);
      if (vol != null) return { symbol, volume: vol };

      if (Array.isArray(ev)) {
        const arrSymbol = ev[1];
        for (const item of ev) {
          if (typeof item === 'number' && Number.isInteger(item) && item > 0 && item < 1e8) {
            return { symbol: arrSymbol, volume: item };
          }
          if (typeof item === 'string') {
            const n = Number(item);
            if (Number.isFinite(n) && Number.isInteger(n) && n > 0 && n < 1e8) {
              return { symbol: arrSymbol, volume: n };
            }
          }
        }
      }

      return null;
    }

    const removeListener = tastytradeApi.quoteStreamer.addEventListener((events: any[]) => {
      const arr = Array.isArray(events) ? events : [events];
      for (const ev of arr) {
        rawEventCount += 1;
        if (rawEventCount <= 10) console.log('raw event:', ev);

        try {
          const parsed = extractVolumeFromEvent(ev);
          if (parsed && parsed.symbol && typeof parsed.volume === 'number') {
            volumes[parsed.symbol] = (volumes[parsed.symbol] || 0) + parsed.volume;
          }
        } catch (e) {
          // ignore parse errors
        }
      }
    });

    tastytradeApi.quoteStreamer.subscribe(streamerSymbols);

    await new Promise((res) => setTimeout(res, sampleMs));

    tastytradeApi.quoteStreamer.unsubscribe(streamerSymbols);
    removeListener();
    tastytradeApi.quoteStreamer.disconnect();

    if (rawEventCount === 0) {
      console.warn('No raw events received from quoteStreamer — check authentication and connectivity.');
    }

    return volumes;
  } catch (err: any) {
    console.error('Error collecting option volumes:', err?.message || err);
    throw err;
  }
}

export function candidateSymbolsFor(raw: string | undefined) {
  if (!raw) return [];
  const out = new Set<string>();
  out.add(raw);
  out.add(raw.replace(/^\.\//, ''));
  out.add(raw.replace(/^\./, ''));
  out.add(raw.replace(/:.+$/, ''));
  out.add(raw.startsWith('.') ? raw : `.${raw}`);
  out.add(raw.startsWith('.') ? raw.slice(1) : raw);
  return Array.from(out);
}

export function mergeVolumesIntoChain(chain: any, volumes: Record<string, number>) {
  if (!chain || typeof chain !== 'object') return chain;

  function merge(obj: any) {
    if (!obj || typeof obj !== 'object') return;
    const keysToCheck = ['call-streamer-symbol', 'put-streamer-symbol', 'callStreamerSymbol', 'putStreamerSymbol', 'call', 'put', 'symbol'];
    let attached = false;
    for (const k of keysToCheck) {
      if (k in obj) {
        const raw = obj[k];
        if (typeof raw === 'string') {
          const candidates = candidateSymbolsFor(raw);
          for (const c of candidates) {
            if (volumes[c]) {
              const short = k.includes('call') ? 'callVolume' : k.includes('put') ? 'putVolume' : 'volume';
              obj[short] = volumes[c];
              attached = true;
              break;
            }
          }
        }
      }
    }

    for (const v of Object.values(obj)) {
      if (typeof v === 'object') merge(v);
    }
    return attached;
  }

  const cloned = JSON.parse(JSON.stringify(chain));
  merge(cloned);
  return cloned;
}

export default { fetchOptionChains, fetchOptionVolumes, mergeVolumesIntoChain };
