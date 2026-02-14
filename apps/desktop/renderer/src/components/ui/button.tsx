import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center rounded-[var(--oc-radius)] text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--oc-border-strong)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--oc-bg)] disabled:opacity-50 disabled:pointer-events-none",
  {
    variants: {
      variant: {
        default:
          "bg-[var(--oc-accent)] text-[var(--oc-bg)] hover:bg-[var(--oc-accent-hover)]",
        secondary:
          "bg-[var(--oc-bg-elevated)] text-[var(--oc-ink)] border border-[var(--oc-border)] hover:bg-[var(--oc-border)]",
        outline:
          "border border-[var(--oc-border)] bg-transparent hover:bg-[var(--oc-bg-elevated)]",
        ghost: "hover:bg-[var(--oc-bg-elevated)]",
      },
      size: {
        sm: "h-8 px-3 text-xs",
        md: "h-9 px-4",
        lg: "h-10 px-5 text-[0.95rem]",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "md",
    },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, ...props }, ref) => (
    <button
      ref={ref}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
);
Button.displayName = "Button";

export { Button, buttonVariants };
