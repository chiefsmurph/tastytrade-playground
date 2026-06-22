import tastytradeApi from "../core/tastytrade-client";
import { normalizePositions } from "../core/normalize";
import { CurrentPosition } from "../core/types";
import {
  evaluatePositionGroup,
  groupPositionsByUnderlying,
  PositionGroupEvaluation,
} from "./evaluate-position";

export async function getPositionEvaluations(accountNumber: string): Promise<
  PositionGroupEvaluation[]
> {
  const rawPositions =
    await tastytradeApi.balancesAndPositionsService.getPositionsList(
      accountNumber,
    );
  const currentPositions: CurrentPosition[] = normalizePositions(
    Array.isArray(rawPositions) ? rawPositions : [],
  );

  const groupedPositions = groupPositionsByUnderlying(currentPositions);
  const groupedEvaluations = await Promise.all(
    Array.from(groupedPositions.values()).map((positions) =>
      evaluatePositionGroup(positions),
    ),
  );

  return groupedEvaluations.filter(
    (evaluation): evaluation is PositionGroupEvaluation => evaluation != null,
  );
}

export default getPositionEvaluations;
