import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

const badgeVariants = cva(
  'inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium tracking-wide',
  {
    variants: {
      variant: {
        default: 'bg-neutral-100 text-neutral-700',
        ok: 'bg-[var(--color-ok-bg)] text-[var(--color-ok)]',
        error: 'bg-[var(--color-err-bg)] text-[var(--color-err)]',
        running: 'bg-[var(--color-run-bg)] text-[var(--color-run)]',
        warn: 'bg-amber-500/20 text-amber-700',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
)

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant, className }))} {...props} />
}
