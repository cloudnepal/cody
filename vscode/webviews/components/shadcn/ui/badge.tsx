import { type VariantProps, cva } from 'class-variance-authority'
import type * as React from 'react'
import { cn } from '../utils'

const badgeVariants = cva(
    'tw-inline-flex tw-items-center tw-rounded-[2px] tw-border-w-1 tw-border-solid tw-px-[5px] tw-py-0 tw-text-xs focus:tw-outline-none focus:tw-ring-2 focus:tw-ring-ring focus:tw-ring-offset-2',
    {
        variants: {
            variant: {
                secondary: 'tw-border-badge-border tw-bg-badge-background tw-text-badge-foreground',
            },
        },
        defaultVariants: {
            variant: 'secondary',
        },
    }
)

export interface BadgeProps
    extends React.HTMLAttributes<HTMLDivElement>,
        VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
    return <div className={cn(badgeVariants({ variant }), className)} {...props} />
}

export { Badge, badgeVariants }
