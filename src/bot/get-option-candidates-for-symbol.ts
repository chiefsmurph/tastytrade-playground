import tastytradeApi from "~/core/tastytrade-client";
import {
  chooseOptionCandidates,
  getOptionCandidateVolume,
  OptionCandidateSelectionOptions,
  resolveCandidateExpirations,
} from "./option-contracts";
import { ProgrammaticAction, evaluateTradingStrategy, PositionMetrics } from "./evaluate-trading-strategy";

const DEFAULT_TOP_CANDIDATE_DTE_TOLERANCE = 7;
const DEFAULT_OPTION_HEALTH_DTES = [7, 14, 30] as const;

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
  strategy?: ProgrammaticAction;
  streamerSymbol?: string;
  symbol?: string;
  usedDteFallback?: boolean;
}

export interface OptionHealthCandidateResult {
  candidate?: TopOptionCandidateForSymbolResult;
  targetDTE: number;
}

export interface OptionHealthSummary {
  fallbackTargets: number[];
  healthyTargets: number[];
  missingTargets: number[];
}

export interface OptionHealthForSymbolResult {
  requestedSide: "call" | "put";
  symbol: string;
  summary: OptionHealthSummary;
  targets: Record<string, TopOptionCandidateForSymbolResult | undefined>;
}

function getDefaultTopCandidateSelection() {
  const currentTime = new Date();
  // currentTime.setHours(11, 0, 0, 0); // Set to 11:00 AM
  const metrics: PositionMetrics = {
    currentBidPrice: 1,
    currentAskPrice: 1,
    currentTime,
    lastActionTime: currentTime,
    weightedAverageFill: 1,
  };
  const strategy = evaluateTradingStrategy(metrics);
  const preferredDTE = 14;

  return {
    maxDTE: preferredDTE + DEFAULT_TOP_CANDIDATE_DTE_TOLERANCE,
    minDTE: Math.max(0, preferredDTE - DEFAULT_TOP_CANDIDATE_DTE_TOLERANCE),
    preferredDTE,
    strategy,
  };
}

function getResolvedSelectionOptions(
  targetDTE?: number,
  selectionOptions?: OptionCandidateSelectionOptions,
) {
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

  return {
    defaultSelection,
    preferredDTE,
    resolvedSelectionOptions,
  };
}

function buildTopOptionCandidateResult(
  symbol: string,
  side: "call" | "put",
  optionChain: Awaited<
    ReturnType<typeof tastytradeApi.johnsService.fetchOptionChainWithVolume>
  >,
  underlyingPrice: number,
  targetDTE?: number,
  selectionOptions?: OptionCandidateSelectionOptions,
): TopOptionCandidateForSymbolResult | undefined {
  const { defaultSelection, preferredDTE, resolvedSelectionOptions } =
    getResolvedSelectionOptions(targetDTE, selectionOptions);
  const { usedDteFallback } = resolveCandidateExpirations(
    optionChain,
    resolvedSelectionOptions,
  );
  const optionCandidates = chooseOptionCandidates(
    optionChain,
    underlyingPrice,
    resolvedSelectionOptions,
  ).map((candidate) => ({
    ...candidate,
    meetsVolumeRequirement: getOptionCandidateVolume(candidate, side) > 40,
  }));

  const sortedCandidates = [...optionCandidates].sort((a, b) => {
    const aVolume = getOptionCandidateVolume(a, side);
    const bVolume = getOptionCandidateVolume(b, side);
    const aDteDelta = preferredDTE == null ? 0 : Math.abs(Number(a.dte) - preferredDTE);
    const bDteDelta = preferredDTE == null ? 0 : Math.abs(Number(b.dte) - preferredDTE);

    if (aDteDelta !== bDteDelta) {
      return aDteDelta - bDteDelta;
    }

    return bVolume - aVolume;
  });

  const topCandidate = sortedCandidates[0];
  console.log(`Top option candidate for ${symbol}:`, {
    ...topCandidate,
    requestedSide: side,
    usedDteFallback,
  });
  if (!topCandidate) {
    return {
      maxDTE: resolvedSelectionOptions?.maxDTE,
      minDTE: resolvedSelectionOptions?.minDTE,
      preferredDTE,
      requestedSide: side,
      strategy: defaultSelection?.strategy,
      usedDteFallback,
    };
  }

  return {
    ...topCandidate,
    maxDTE: resolvedSelectionOptions?.maxDTE,
    minDTE: resolvedSelectionOptions?.minDTE,
    preferredDTE,
    requestedSide: side,
    strategy: defaultSelection?.strategy,
    usedDteFallback,
  };
}

export async function getTopOptionCandidateForSymbol(
  symbol: string,
  side: "call" | "put" = "call",
  targetDTE?: number,
  selectionOptions?: OptionCandidateSelectionOptions,
): Promise<TopOptionCandidateForSymbolResult | undefined> {
  const optionChain = await tastytradeApi.johnsService.fetchOptionChainWithVolume(
    symbol,
  );
  const underlyingPrice = await tastytradeApi.johnsService.getUnderlyingPrice(
    symbol,
  );
  return buildTopOptionCandidateResult(
    symbol,
    side,
    optionChain,
    underlyingPrice?.underlyingPrice || 0,
    targetDTE,
    selectionOptions,
  );
}

export async function getOptionHealthForSymbol(
  symbol: string,
  side: "call" | "put" = "call",
  targetDTEs: readonly number[] = DEFAULT_OPTION_HEALTH_DTES,
): Promise<OptionHealthForSymbolResult> {
  const optionChain = await tastytradeApi.johnsService.fetchOptionChainWithVolume(
    symbol,
  );
  const underlyingPrice = await tastytradeApi.johnsService.getUnderlyingPrice(
    symbol,
  );
  const resolvedUnderlyingPrice = underlyingPrice?.underlyingPrice || 0;
  const normalizedSymbol = symbol.toUpperCase();

  const targets = Object.fromEntries(
    targetDTEs.map((targetDTE) => [
      String(targetDTE),
      buildTopOptionCandidateResult(
        normalizedSymbol,
        side,
        optionChain,
        resolvedUnderlyingPrice,
        targetDTE,
      ),
    ]),
  ) as Record<string, TopOptionCandidateForSymbolResult | undefined>;
  const summary = targetDTEs.reduce<OptionHealthSummary>(
    (result, targetDTE) => {
      const candidate = targets[String(targetDTE)];

      if (!candidate?.symbol) {
        result.missingTargets.push(targetDTE);
        return result;
      }

      result.healthyTargets.push(targetDTE);

      if (candidate.usedDteFallback) {
        result.fallbackTargets.push(targetDTE);
      }

      return result;
    },
    {
      fallbackTargets: [],
      healthyTargets: [],
      missingTargets: [],
    },
  );

  console.log(
    JSON.stringify({
      requestedSide: side,
      scope: "option-health",
      summary,
      symbol: normalizedSymbol,
      targets,
    }),
  );

  return {
    requestedSide: side,
    summary,
    symbol: normalizedSymbol,
    targets,
  };
}
