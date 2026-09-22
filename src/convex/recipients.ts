import { getAuthUserId } from "@convex-dev/auth/server";
import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

/**
 * Recipient book + receipts for ReynaLens.
 * These are user-scoped records used by Recipient Shield and receipts.
 * All blockchain data itself always comes from live Solana RPC; these tables
 * only store what the user has done inside ReynaLens.
 */

export const listRecipients = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      return null;
    }
    const rows = await ctx.db
      .query("recipientBook")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    rows.sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0));
    return rows.map((r) => ({
      _id: r._id,
      address: r.address,
      label: r.label ?? null,
      assetSymbol: r.assetSymbol ?? null,
      assetMint: r.assetMint ?? null,
      lastUsedAt: r.lastUsedAt ?? null,
      timesUsed: r.timesUsed,
    }));
  },
});

/** Resolve a single address for Recipient Shield: known/unknown for this user. */
export const lookupRecipient = query({
  args: { address: v.string() },
  handler: async (ctx, { address }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      return null;
    }
    const normalized = address.trim();
    const exact = await ctx.db
      .query("recipientBook")
      .withIndex("by_user_address", (q) =>
        q.eq("userId", userId).eq("address", normalized),
      )
      .unique();
    const all = await ctx.db
      .query("recipientBook")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    return {
      known: exact ?? null,
      others: all.filter((r) => r.address !== normalized),
    };
  },
});

/** Insert or update a recipient after a successful, verified transfer. */
export const recordVerifiedRecipient = mutation({
  args: {
    address: v.string(),
    label: v.optional(v.string()),
    assetSymbol: v.optional(v.string()),
    assetMint: v.optional(v.string()),
    now: v.number(),
  },
  handler: async (ctx, { address, label, assetSymbol, assetMint, now }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      throw new Error("Not signed in");
    }
    const normalized = address.trim();
    const existing = await ctx.db
      .query("recipientBook")
      .withIndex("by_user_address", (q) =>
        q.eq("userId", userId).eq("address", normalized),
      )
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, {
        label: label ?? existing.label,
        assetSymbol: assetSymbol ?? existing.assetSymbol,
        assetMint: assetMint ?? existing.assetMint,
        lastUsedAt: now,
        timesUsed: existing.timesUsed + 1,
      });
      return existing._id;
    }
    return await ctx.db.insert("recipientBook", {
      userId,
      address: normalized,
      label,
      assetSymbol,
      assetMint,
      firstUsedAt: now,
      lastUsedAt: now,
      timesUsed: 1,
    });
  },
});

/** Save the final receipt after post-transfer verification. */
export const saveReceipt = mutation({
  args: {
    assetSymbol: v.string(),
    assetMint: v.string(),
    mintDecimals: v.number(),
    recipient: v.string(),
    netBaseUnits: v.string(),
    grossBaseUnits: v.string(),
    feeBaseUnits: v.string(),
    signature: v.string(),
    verified: v.boolean(),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      throw new Error("Not signed in");
    }
    const id = await ctx.db.insert("receipts", {
      userId,
      assetSymbol: args.assetSymbol,
      assetMint: args.assetMint,
      mintDecimals: args.mintDecimals,
      recipient: args.recipient,
      netBaseUnits: args.netBaseUnits,
      grossBaseUnits: args.grossBaseUnits,
      feeBaseUnits: args.feeBaseUnits,
      signature: args.signature,
      verified: args.verified,
      createdAt: args.now,
    });
    return id;
  },
});

export const listReceipts = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      return null;
    }
    const rows = await ctx.db
      .query("receipts")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    rows.sort((a, b) => b.createdAt - a.createdAt);
    return rows.slice(0, 20);
  },
});
