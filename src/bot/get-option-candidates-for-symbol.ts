import { getUnderlyingPrice } from "../core/market-data";
import { fetchOptionChainsWithVolume } from "../core/option-service";
import { chooseOptionCandidates } from "./option-contracts";

export async function getOptionCandidatesForSymbol(symbol: string) {
  const optionChains = await fetchOptionChainsWithVolume(symbol);
  const underlyingPrice = await getUnderlyingPrice(symbol);
  const optionCandidates = optionChains.map((chain) =>
    chooseOptionCandidates(chain, underlyingPrice?.underlyingPrice || 0),
  ).flat();
  console.log(JSON.stringify({ optionChains, optionCandidates }, null, 2));
  return optionCandidates;
}

export async function getTopOptionCandidateForSymbol(symbol: string) {
  const optionCandidates = await getOptionCandidatesForSymbol(symbol);
  const topCandidate = optionCandidates[0];
  console.log(`Top option candidate for ${symbol}:`, topCandidate);
  return topCandidate;
}
