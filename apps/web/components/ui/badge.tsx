import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva("inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider", {
  variants: {
    variant: {
      default: "border-line bg-panel text-muted",
      accent: "border-accent/40 bg-accent/15 text-accent",
      sim: "border-sim/50 bg-sim/15 text-sim",
      danger: "border-danger/50 bg-danger/15 text-danger",
    },
  },
  defaultVariants: { variant: "default" },
});
export function Badge({ className, variant, ...p }: React.HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ variant }), className)} {...p} />;
}
