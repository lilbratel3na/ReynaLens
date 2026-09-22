import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { motion, AnimatePresence } from "framer-motion";
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { KV, TermPanel } from "@/components/terminal/Term";
import { connection as rpc } from "@/lib/solana/connection";
import { PRESTOCK_ASSETS } from "@/lib/solana/prestocks";
import {
  inspectMint,
  type MintInspection,
} from "@/lib/solana/inspectMint";
import {
  calculateExactOut,
  formatBaseUnits,
  parseUiAmountToBaseUnits,
  shortenAddress,
} from "@/lib/solana/exactOut";
import {
  evaluateRecipientShield,
  type ShieldVerdict,
} from "@/lib/solana_shield";
import {
  buildTransferTransaction,
  simulateTransfer,
} from "@/lib/solana_transfer";
import {
  deriveRecipientAta,
  explorerTxUrl,
  readBalanceOrZero,
  verifyDelivery,
  type DeliveryVerification,
} from "@/lib/solana_verify";
import { readWalletBalance, lamportsToSol } from "@/lib/solana_balance";
import { DEMO_LOOKALIKE_TARGET } from "@/lib/demo";
import { PublicKey, Transaction } from "@solana/web3.js";

type ScreenId =
  | "asset"
  | "recipient"
  | "shield"
  | "amount"
  | "preview"
  "preflight"
  | "signing"
  | "receipt";
