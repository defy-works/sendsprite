import { forwardRef, type HTMLAttributes } from "react";
import { cn } from "@/lib/cn";

export type CardProps = HTMLAttributes<HTMLDivElement>;

/** Glass surface. Uses the `.glass` utility registered in globals.css. */
export const Card = forwardRef<HTMLDivElement, CardProps>(function Card(
  { className, ...rest },
  ref,
) {
  return <div ref={ref} className={cn("glass p-5", className)} {...rest} />;
});

export const CardHeader = forwardRef<HTMLDivElement, CardProps>(
  function CardHeader({ className, ...rest }, ref) {
    return (
      <div
        ref={ref}
        className={cn(
          "flex items-baseline justify-between gap-3 pb-4",
          className,
        )}
        {...rest}
      />
    );
  },
);

/** The mono all-caps label that titles every panel. */
export const CardTitle = forwardRef<
  HTMLHeadingElement,
  HTMLAttributes<HTMLHeadingElement>
>(function CardTitle({ className, ...rest }, ref) {
  return <h2 ref={ref} className={cn("num-stamp", className)} {...rest} />;
});

export const CardBody = forwardRef<HTMLDivElement, CardProps>(function CardBody(
  { className, ...rest },
  ref,
) {
  return <div ref={ref} className={cn(className)} {...rest} />;
});
