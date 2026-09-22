import { cn } from "@/lib/utils";
import type { ReactNode } from "react";

export function TermPanel({
  title,
  right,
  children,
  className,
}: {
  title?: string;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "border border-border bg-card shadow-[2px_2px_0_0_rgba(25,27,24,0.06)]",
        className,
      )}
    >
      {title && (
        <div className="flex items-center justify-between border-b border-border bg-secondary px-3 py-2">
          <span className="text-[11px] font-semibold tracking-terminal uppercase text-foreground">
            {title}
          </span>
          {right}
        </div>
      )}
      <div className="p-3">{children}</div>
    </div>
  );
}

export function KV({
  k,
  v,
  mono = true,
  tone,
}: {
  k: string;
  v: ReactNode;
  mono?: boolean;
  tone?: "ok" | "warn" | "bad";
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <span className="shrink-0 text-[11px] uppercase tracking-terminal text-muted-foreground">
        {k}
      </span>
      <span
        className={cn(
          "text-right text-xs tabular-nums",
          mono && "break-all",
          tone === "ok" && "text-status-ok",
          tone === "warn" && "text-status-warn",
          tone === "bad" && "text-status-bad",
        )}
      >
        {v}
      </span>
    </div>
  );
}

export function StatusBar({
  status,
  tone = "ok",
}: {
  status: string;
  tone?: "ok" | "warn" | "bad" | "idle";
}) {
  const color =
    tone === "ok"
      ? "bg-status-ok"
      : tone === "warn"
        ? "bg-status-warn"
        : tone === "bad"
          ? "bg-status-bad"
          : "bg-muted-foreground";
  return (
    <div className="flex items-center gap-2 border border-border bg-card px-3 py-2">
      <span className={cn("size-2 shrink-0", color)} />
      <span className="truncate text-[11px] uppercase tracking-terminal text-foreground">
        {status}
      </span>
      <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">
        <span className="caret-blink">▊</span>
      </span>
    </div>
  );
}
