import { authTables } from "@convex-dev/auth/server";
import { defineSchema, defineTable } from "convex/server";
import { Infer, v } from "convex/values";

// default user roles. can add / remove based on the project as needed
export const ROLES = {
  ADMIN: "admin",
  USER: "user",
  MEMBER: "member",
} as const;

export const roleValidator = v.union(
  v.literal(ROLES.ADMIN),
  v.literal(ROLES.USER),
  v.literal(ROLES.MEMBER),
);
export type Role = Infer<typeof roleValidator>;

const schema = defineSchema(
  {
    // default auth tables using convex auth.
    ...authTables, // do not remove or modify

    // the users table is the default users table that is brought in by the authTables
    users: defineTable({
      name: v.optional(v.string()), // name of the user. do not remove
      image: v.optional(v.string()), // image of the user. do not remove
      email: v.optional(v.string()), // email of the user. do not remove
      emailVerificationTime: v.optional(v.number()), // email verification time. do not remove
      isAnonymous: v.optional(v.boolean()), // is the user anonymous. do not remove

      role: v.optional(roleValidator), // role of the user. do not remove
    }).index("email", ["email"]), // index for the email. do not remove or modify

    // ReynaLens: per-user recipient history used by Recipient Shield
    // (previously-used detection + lookalike similarity checks).
    recipientBook: defineTable({
      userId: v.id("users"),
      address: v.string(),
      label: v.optional(v.string()),
      assetSymbol: v.optional(v.string()),
      assetMint: v.optional(v.string()),
      timesUsed: v.number(),
      firstUsedAt: v.number(),
      lastUsedAt: v.optional(v.number()),
    })
      .index("by_user", ["userId"])
      .index("by_user_address", ["userId", "address"]),

    // ReynaLens: receipts of completed transfers (amounts are in base units).
    receipts: defineTable({
      userId: v.id("users"),
      assetSymbol: v.string(),
      assetMint: v.string(),
      mintDecimals: v.number(),
      recipient: v.string(),
      netBaseUnits: v.string(),
      grossBaseUnits: v.string(),
      feeBaseUnits: v.string(),
      signature: v.string(),
      verified: v.boolean(),
      createdAt: v.number(),
    }).index("by_user", ["userId"]),

    // add other tables here

    // tableName: defineTable({
    //   ...
    //   // table fields
    // }).index("by_field", ["field"])
  },
  {
    schemaValidation: false,
  },
);

export default schema;
