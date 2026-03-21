import { describe, expect, it } from "vitest";

import { extractOwnerTokenDebits } from "../src/infra/transactionInspector.js";

describe("transactionInspector", () => {
  it("extracts owner token debits for the tracked mints", () => {
    const summary = extractOwnerTokenDebits(
      [
        {
          owner: "owner-1",
          mint: "mint-a",
          uiTokenAmount: { amount: "1000" }
        },
        {
          owner: "owner-1",
          mint: "mint-b",
          uiTokenAmount: { amount: "500" }
        },
        {
          owner: "someone-else",
          mint: "mint-a",
          uiTokenAmount: { amount: "999" }
        }
      ],
      [
        {
          owner: "owner-1",
          mint: "mint-a",
          uiTokenAmount: { amount: "750" }
        },
        {
          owner: "owner-1",
          mint: "mint-b",
          uiTokenAmount: { amount: "450" }
        }
      ],
      "owner-1",
      ["mint-a", "mint-b"]
    );

    expect(summary).toEqual({
      tokenDebits: {
        "mint-a": 250n,
        "mint-b": 50n
      }
    });
  });

  it("returns null when there is no debit for the tracked owner", () => {
    expect(
      extractOwnerTokenDebits(
        [
          {
            owner: "owner-1",
            mint: "mint-a",
            uiTokenAmount: { amount: "1000" }
          }
        ],
        [
          {
            owner: "owner-1",
            mint: "mint-a",
            uiTokenAmount: { amount: "1000" }
          }
        ],
        "owner-1",
        ["mint-a"]
      )
    ).toBeNull();
  });
});
