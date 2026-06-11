import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-2xl text-sm font-semibold transition-all duration-150 ease-out active:scale-[0.97] disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        default:    "bg-slate-900 text-white shadow hover:bg-slate-800",
        primary:    "bg-blue-600 text-white shadow hover:bg-blue-700",
        success:    "bg-emerald-600 text-white shadow hover:bg-emerald-700",
        warning:    "bg-amber-500 text-white shadow hover:bg-amber-600",
        danger:     "bg-red-600 text-white shadow hover:bg-red-700",
        outline:    "border-2 border-slate-200 bg-white text-slate-700 hover:bg-slate-50",
        ghost:      "text-slate-700 hover:bg-slate-100",
        link:       "text-blue-600 underline-offset-4 hover:underline",
      },
      size: {
        sm:   "h-9  px-4   text-xs",
        md:   "h-11 px-5",
        lg:   "h-13 px-6   text-base font-bold",
        icon: "h-10 w-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size:    "md",
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
