/**
 * Real PreStocks mints (PreStocks is the issuer; all are Solana Token-2022
 * mints with Token Extensions). These addresses were read live from
 * mainnet and cross-checked against DexScreener market metadata.
 */
export interface PreStockAsset {
  ticker: string;
  name: string;
  mint: string;
  /** Issuer / exposure label (display only). */
  issuer: string;
}

export const PRESTOCK_ASSETS: PreStockAsset[] = [
  {
    ticker: "OPENAI",
    name: "OpenAI PreStocks",
    mint: "PreweJYECqtQwBtpxHL171nL2K6umo692gTm7Q3rpgF",
    issuer: "PreStocks",
  },
  {
    ticker: "ANTHROPIC",
    name: "Anthropic PreStocks",
    mint: "Pren1FvFX6J3E4kXhJuCiAD5aDmGEb7qJRncwA8Lkhw",
    issuer: "PreStocks",
  },
  {
    ticker: "SPACEX",
    name: "SpaceX PreStocks",
    mint: "PreANxuXjsy2pvisWWMNB6YaJNzr7681wJJr2rHsfTh",
    issuer: "PreStocks",
  },
  {
    ticker: "NEURALINK",
    name: "Neuralink PreStocks",
    mint: "PrekqLJvJ3qVdXmBGDiexvwUTF4rLFDa6HWS4HJbw9S",
    issuer: "PreStocks",
  },
  {
    ticker: "ANDURIL",
    name: "Anduril PreStocks",
    mint: "PresTj4Yc2bAR197Er7wz4UUKSfqt6FryBEdAriBoQB",
    issuer: "PreStocks",
  },
];

export const TOKEN_2022_PROGRAM_ID =
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export const TOKEN_LEGACY_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
