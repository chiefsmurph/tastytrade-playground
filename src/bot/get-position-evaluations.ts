import tastytradeApi from "~/core/tastytrade-client";
import {
  evaluatePositionGroup,
  groupPositionsByUnderlying,
  PositionGroupEvaluation,
} from "./evaluate-position";

export async function getPositionEvaluations(
  accountNumber: string,
): Promise<PositionGroupEvaluation[]> {
  const currentPositions =
    await tastytradeApi.balancesAndPositionsService.getPositionsList(
      accountNumber,
    );

  console.log({ currentPositions })

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
