import type { TypedDocumentString } from "@/src/graphql/graphql";
import type { Address, BranchId, TroveId } from "@/src/types";

import { dnum18 } from "@/src/dnum-utils";
import { SUBGRAPH_URL } from "@/src/env";
import { graphql } from "@/src/graphql";
import { subgraphIndicator } from "@/src/indicators/subgraph-indicator";
import { getPrefixedTroveId } from "@/src/liquity-utils";

type IndexedTrove = {
  id: string;
  borrower: Address;
  closedAt: number | null;
  createdAt: number;
  mightBeLeveraged: boolean;
  status: string;
};

async function tryFetch(...args: Parameters<typeof fetch>) {
  try {
    return await fetch(...args);
  } catch {
    return null;
  }
}

async function graphQuery<TResult, TVariables>(
  query: TypedDocumentString<TResult, TVariables>,
  ...[variables]: TVariables extends Record<string, never> ? [] : [TVariables]
) {
  const response = await tryFetch(SUBGRAPH_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/graphql-response+json",
    },
    body: JSON.stringify(
      { query, variables },
      (_, value) => typeof value === "bigint" ? String(value) : value,
    ),
  });

  if (response === null || !response.ok) {
    subgraphIndicator.setError("Subgraph error: unable to fetch data.");
    throw new Error("Error while fetching data from the subgraph");
  }

  const result = await response.json();

  if (!result.data) {
    console.error(result);
    subgraphIndicator.setError("Subgraph error: invalid response.");
    throw new Error("Invalid response from the subgraph");
  }

  // successful query: clear previous indicator errors
  subgraphIndicator.clearError();

  return result.data as TResult;
}

const BlockNumberQuery = graphql(`
  query BlockNumber {
    _meta {
      block {
        number
      }
    }
  }
`);

export async function getIndexedBlockNumber() {
  const result = await graphQuery(BlockNumberQuery);
  return BigInt(result._meta?.block.number ?? -1);
}

const NextOwnerIndexesByBorrowerQuery = graphql(`
  query NextOwnerIndexesByBorrower($id: ID!) {
    borrowerInfo(id: $id) {
      nextOwnerIndexes
    }
  }
`);

export async function getNextOwnerIndex(
  branchId: BranchId,
  borrower: Address,
): Promise<number> {
  const { borrowerInfo } = await graphQuery(
    NextOwnerIndexesByBorrowerQuery,
    { id: borrower.toLowerCase() },
  );
  return Number(borrowerInfo?.nextOwnerIndexes[branchId] ?? 0);
}

const TrovesByAccountQuery = graphql(`
  query TroveStatusesByAccount($account: Bytes!) {
    troves(
      where: {
        borrower: $account
        status_in: [active, redeemed, liquidated]
      }
      orderBy: updatedAt
      orderDirection: desc
    ) {
      id
      closedAt
      createdAt
      mightBeLeveraged
      status
    }
  }
`);

export async function getIndexedTrovesByAccount(account: Address): Promise<IndexedTrove[]> {
  const { troves } = await graphQuery(TrovesByAccountQuery, {
    account: account.toLowerCase(),
  });
  return troves.map((trove) => ({
    id: trove.id,
    borrower: account,
    closedAt: trove.closedAt === null || trove.closedAt === undefined
      ? null
      : Number(trove.closedAt) * 1000,
    createdAt: Number(trove.createdAt) * 1000,
    mightBeLeveraged: trove.mightBeLeveraged,
    status: trove.status,
  }));
}

const TroveByIdQuery = graphql(`
  query TroveById($id: ID!) {
    trove(id: $id) {
      id
      borrower
      closedAt
      createdAt
      mightBeLeveraged
      status
    }
  }
`);

export async function getIndexedTroveById(
  branchId: BranchId,
  troveId: TroveId,
): Promise<IndexedTrove | null> {
  const prefixedTroveId = getPrefixedTroveId(branchId, troveId);
  const { trove } = await graphQuery(TroveByIdQuery, { id: prefixedTroveId });
  if (!trove) return null;

  return {
    id: trove.id,
    borrower: trove.borrower as Address,   // no more previousOwner logic
    closedAt: trove.closedAt == null ? null : Number(trove.closedAt) * 1000,
    createdAt: Number(trove.createdAt) * 1000,
    mightBeLeveraged: trove.mightBeLeveraged,
    status: trove.status,
  };
}

const InterestBatchesQuery = graphql(`
  query InterestBatches($ids: [ID!]!) {
    interestBatches(where: { id_in: $ids }) {
      collateral {
        collIndex
      }
      batchManager
      debt
      coll
      annualInterestRate
      annualManagementFee
    }
  }
`);

export async function getInterestBatches(
  branchId: BranchId,
  batchAddresses: Address[],
) {
  const { interestBatches } = await graphQuery(InterestBatchesQuery, {
    ids: batchAddresses.map((addr) => `${branchId}:${addr.toLowerCase()}`),
  });

  return interestBatches.map((batch) => ({
    batchManager: batch.batchManager as Address,
    debt: dnum18(batch.debt),
    coll: dnum18(batch.coll),
    interestRate: dnum18(batch.annualInterestRate),
    fee: dnum18(batch.annualManagementFee),
  }));
}

const AllInterestRateBracketsQuery = graphql(`
  query AllInterestRateBrackets {
    interestRateBrackets(
      first: 1000
      where: { totalDebt_gt: 0 }
      orderBy: rate
    ) {
      collateral {
        collIndex
      }
      rate
      totalDebt
    }
  }
`);

export async function getInterestRateBrackets(branchId: BranchId) {
  const { interestRateBrackets } = await graphQuery(AllInterestRateBracketsQuery);
  return interestRateBrackets
    .filter((bracket) => bracket.collateral.collIndex === branchId)
    .sort((a, b) => (a.rate > b.rate ? 1 : -1))
    .map((bracket) => ({
      rate: dnum18(bracket.rate),
      totalDebt: dnum18(bracket.totalDebt),
    }));
}

export async function getAllInterestRateBrackets() {
  const { interestRateBrackets } = await graphQuery(AllInterestRateBracketsQuery);

  const debtByRate: Map<string, bigint> = new Map();
  for (const bracket of interestRateBrackets) {
    const key = String(bracket.rate);
    debtByRate.set(key, (debtByRate.get(key) ?? 0n) + BigInt(bracket.totalDebt));
  }

  return interestRateBrackets
    .sort((a, b) => (a.rate > b.rate ? 1 : -1))
    .map((bracket) => {
      const totalDebt = debtByRate.get(String(bracket.rate));
      if (totalDebt === undefined) throw new Error();
      return {
        rate: dnum18(bracket.rate),
        totalDebt: dnum18(totalDebt),
      };
    });
}

const GovernanceInitiativesQuery = graphql(`
  query GovernanceInitiatives {
    governanceInitiatives {
      id
    }
  }
`);

// get all the registered initiatives
export async function getIndexedInitiatives() {
  const { governanceInitiatives } = await graphQuery(GovernanceInitiativesQuery);
  return governanceInitiatives.map((initiative) => initiative.id as Address);
}

const AllocationHistoryQuery = graphql(`
  query AllocationHistory($user: String, $initiative: String) {
    userAllocations: governanceAllocations(
      where: { initiative: $initiative, user: $user }
      orderBy: atEpoch
      orderDirection: desc
    ) {
      atEpoch
      voteLQTY
      vetoLQTY
    }

    totalAllocations: governanceAllocations(
      where: { initiative: $initiative, user: null }
      orderBy: atEpoch
      orderDirection: desc
    ) {
      atEpoch
      voteLQTY
      vetoLQTY
    }
  }
`);

export async function getAllocationHistory(user: Address, initiative: Address) {
  const { userAllocations, totalAllocations } = await graphQuery(
    AllocationHistoryQuery,
    { user: user.toLowerCase(), initiative: initiative.toLowerCase() },
  );

  return {
    userAllocations: userAllocations.map((allocation) => ({
      epoch:    BigInt(allocation.atEpoch),
      voteLQTY: BigInt(allocation.voteLQTY),
      vetoLQTY: BigInt(allocation.vetoLQTY),
    })),

    totalAllocations: totalAllocations.map((allocation) => ({
      epoch:    BigInt(allocation.atEpoch),
      voteLQTY: BigInt(allocation.voteLQTY),
      vetoLQTY: BigInt(allocation.vetoLQTY),
    })),
  };
}
