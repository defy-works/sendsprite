import type { HTMLAttributes } from "react";
import { cn } from "@/lib/cn";

export type SkeletonProps = HTMLAttributes<HTMLDivElement>;

export function Skeleton({ className, ...rest }: SkeletonProps) {
  return (
    <div
      className={cn("animate-pulse bg-white/6 rounded", className)}
      aria-hidden
      {...rest}
    />
  );
}
