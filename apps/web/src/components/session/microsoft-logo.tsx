// The four-square Microsoft logo, as Microsoft's sign-in branding guidelines require on a "Sign in with Microsoft"
// button. Fixed brand colours — they stay the same in light and dark themes.

import { cn } from '@/lib/utils'

export function MicrosoftLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 21 21" aria-hidden="true" className={cn('size-4 shrink-0', className)}>
      <rect x="1" y="1" width="9" height="9" fill="#f25022" />
      <rect x="11" y="1" width="9" height="9" fill="#7fba00" />
      <rect x="1" y="11" width="9" height="9" fill="#00a4ef" />
      <rect x="11" y="11" width="9" height="9" fill="#ffb900" />
    </svg>
  )
}
