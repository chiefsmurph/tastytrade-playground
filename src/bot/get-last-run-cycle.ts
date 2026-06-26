import { getLastBotRunState } from "./last-run-state";
import { getRecentRunHistory } from "./run-history";

export async function getLastRunCycle(accountNumber?: string): Promise<unknown> {
  const normalizedAccountNumber = String(accountNumber ?? "").trim();
  const hasAccountArg = normalizedAccountNumber.length > 0;
  const inMemoryState = hasAccountArg
    ? getLastBotRunState(normalizedAccountNumber)
    : getLastBotRunState();

  if (hasAccountArg) {
    const scopedState = inMemoryState as {
      updatedAt: string | null;
    };

    if (scopedState.updatedAt) {
      return scopedState;
    }

    const recent = await getRecentRunHistory(1, normalizedAccountNumber);
    return recent[0] ?? scopedState;
  }

  const allState = inMemoryState as Record<string, unknown>;
  if (Object.keys(allState).length > 0) {
    return allState;
  }

  const recentAcrossAccounts = await getRecentRunHistory(200);
  const byAccount = new Map<string, unknown>();

  for (const entry of recentAcrossAccounts) {
    const key = String(entry.accountNumber ?? "").trim();
    if (!key || byAccount.has(key)) {
      continue;
    }

    byAccount.set(key, entry);
  }

  return Object.fromEntries(byAccount.entries());
}

export default getLastRunCycle;