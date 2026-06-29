import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

// shadcn/ui class-name merge helper (TAC-306). Combines clsx conditional
// joining with tailwind-merge conflict resolution so component-default classes
// can be overridden by caller-passed className without specificity battles.
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
