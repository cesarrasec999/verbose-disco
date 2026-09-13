import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-2xl text-sm font-semibold transition-all duration-150 ease-out active:scale-[0.97] focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-blue-200 disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        default:    "bg-slate-900 text-white shadow-md shadow-slate-900/15 hover:bg-slate-800 hover:shadow-lg",
        primary:    "bg-blue-600 text-white shadow-md shadow-blue-600/20 hover:bg-blue-700 hover:shadow-lg",
        success:    "bg-emerald-600 text-white shadow-md shadow-emerald-600/20 hover:bg-emerald-700 hover:shadow-lg",
        warning:    "bg-amber-500 text-white shadow-md shadow-amber-500/20 hover:bg-amber-600 hover:shadow-lg",
        danger:     "bg-red-600 text-white shadow-md shadow-red-600/20 hover:bg-red-700 hover:shadow-lg",
        outline:    "border-2 border-slate-200 bg-white text-slate-700 shadow-sm hover:bg-slate-50 hover:shadow-md",
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
