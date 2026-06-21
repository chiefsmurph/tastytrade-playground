import { getUnderlyingPrice } from "../core/market-data";
import { fetchOptionChainWithVolume } from "../core/option-service";
import {
  chooseOptionCandidates,
  OptionCandidateSelectionOptions,
} from "./option-contracts";
import { evaluateTradingStrategy } from "./evaluate-trading-strategy";

const DEFAULT_TOP_CANDIDATE_DTE_TOLERANCE = 7;

export interface TopOptionCandidateForSymbolResult {
  "call-streamer-symbol"?: string;
  call?: string;
  dte?: number;
  maxDTE?: number;
  meetsVolumeRequirement?: boolean;
  minDTE?: number;
  preferredDTE?: number;
  "put-streamer-symbol"?: string;
  put?: string;
  requestedSide: "call" | "put";
  strategy?: ReturnType<typeof evaluateTradingStrategy>;
  streamerSymbol?: string;
  symbol?: string;
}

function getDefaultTopCandidateSelection() {
  const currentTime = new Date();
  currentTime.setHours(11, 0, 0, 0); // Set to 11:00 AM
  const strategy = evaluateTradingStrategy({
    currentBidPrice: 1,
    currentAskPrice: 1,
    currentTime,
    lastActionTime: currentTime,
    weightedAverageFill: 1,
  });
  const preferredDTE = strategy.targetDTE;

  return {
    maxDTE: preferredDTE + DEFAULT_TOP_CANDIDATE_DTE_TOLERANCE,
    minDTE: Math.max(0, preferredDTE - DEFAULT_TOP_CANDIDATE_DTE_TOLERANCE),
    preferredDTE,
    strategy,
  };
}

export async function getOptionCandidatesForSymbol(symbol: string) {
  const optionChain = await fetchOptionChainWithVolume(symbol);
  const underlyingPrice = await getUnderlyingPrice(symbol);
  const optionCandidates = chooseOptionCandidates(
    optionChain,
    underlyingPrice?.underlyingPrice || 0,
  );
  console.log(JSON.stringify({ optionChain, optionCandidates }, null, 2));
  return optionCandidates;
}

export async function getTopOptionCandidateForSymbol(
  symbol: string,
  side: "call" | "put" = "call",
  targetDTE?: number,
  selectionOptions?: OptionCandidateSelectionOptions,
): Promise<TopOptionCandidateForSymbolResult | undefined> {
  const defaultSelection =
    targetDTE == null && selectionOptions == null
      ? getDefaultTopCandidateSelection()
      : undefined;
  const preferredDTE =
    selectionOptions?.preferredDTE ?? targetDTE ?? defaultSelection?.preferredDTE;
  const resolvedSelectionOptions =
    selectionOptions ??
    (preferredDTE != null
      ? {
          minDTE: Math.max(0, preferredDTE - DEFAULT_TOP_CANDIDATE_DTE_TOLERANCE),
          maxDTE: preferredDTE + DEFAULT_TOP_CANDIDATE_DTE_TOLERANCE,
          preferredDTE,
        }
      : undefined);
  const optionChain = await fetchOptionChainWithVolume(symbol);
  const underlyingPrice = await getUnderlyingPrice(symbol);
  const optionCandidates = chooseOptionCandidates(
    optionChain,
    underlyingPrice?.underlyingPrice || 0,
    resolvedSelectionOptions,
  ).map((candidate) => ({
    ...candidate,
    meetsVolumeRequirement: (candidate[`${side}Volume`] || 0) > 0,
  }));

  const sortedCandidates = [...optionCandidates].sort((a, b) => {
    const aVolume = Number(a[`${side}Volume`] || 0);
    const bVolume = Number(b[`${side}Volume`] || 0);
    const aDteDelta = preferredDTE == null ? 0 : Math.abs(Number(a.dte) - preferredDTE);
    const bDteDelta = preferredDTE == null ? 0 : Math.abs(Number(b.dte) - preferredDTE);

    if (aDteDelta !== bDteDelta) {
      return aDteDelta - bDteDelta;
    }

    return bVolume - aVolume;
  });

  const topCandidate = sortedCandidates[0];
  console.log(`Top option candidate for ${symbol}:`, topCandidate);
  if (!topCandidate) {
    return {
      maxDTE: resolvedSelectionOptions?.maxDTE,
      minDTE: resolvedSelectionOptions?.minDTE,
      preferredDTE,
      requestedSide: side,
      strategy: defaultSelection?.strategy,
    };
  }

  return {
    ...topCandidate,
    maxDTE: resolvedSelectionOptions?.maxDTE,
    minDTE: resolvedSelectionOptions?.minDTE,
    preferredDTE,
    requestedSide: side,
    strategy: defaultSelection?.strategy,
  };
}
