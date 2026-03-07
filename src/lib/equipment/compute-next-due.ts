/**
 * Compute Next Due Date Utility
 * Calculates the next maintenance due date based on interval and last maintenance date
 */

import { addDays, addWeeks, addMonths, parseISO } from 'date-fns'

export type IntervalUnit = 'days' | 'weeks' | 'months'

/**
 * Compute the next maintenance due date
 * @param lastDate - ISO date string of last maintenance, or null
 * @param intervalValue - Number of intervals
 * @param unit - Unit of interval (days, weeks, months)
 * @returns ISO8601 string of next due date
 */
export function computeNextDue(
  lastDate: string | null | undefined,
  intervalValue: number,
  unit: IntervalUnit
): string {
  if (intervalValue <= 0) {
    throw new Error('intervalValue must be greater than 0')
  }

  const base = lastDate ? parseISO(lastDate) : new Date()

  let next: Date

  switch (unit) {
    case 'days':
      next = addDays(base, intervalValue)
      break
    case 'weeks':
      next = addWeeks(base, intervalValue)
      break
    case 'months':
      // Use addMonths which preserves the day where possible
      next = addMonths(base, intervalValue)
      break
    default:
      throw new Error(`Unsupported interval unit: ${unit}`)
  }

  return next.toISOString()
}

