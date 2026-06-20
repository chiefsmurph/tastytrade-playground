import { getUnderlyingPrice } from "../core/market-data";
import { fetchOptionChainWithVolume } from "../core/option-service";
import { chooseOptionCandidates } from "./option-contracts";

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

export async function getTopOptionCandidateForSymbol(symbol: string) {
  const optionCandidates = await getOptionCandidatesForSymbol(symbol);
  const topCandidate = optionCandidates[0];
  console.log(`Top option candidate for ${symbol}:`, topCandidate);
  return topCandidate;
}
