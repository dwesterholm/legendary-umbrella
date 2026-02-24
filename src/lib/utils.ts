import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Formats a number as Swedish kronor with thousands separator.
 * Example: 4250000 -> "4 250 000 kr"
 */
export function formatSEK(amount: number): string {
  return (
    new Intl.NumberFormat("sv-SE", {
      maximumFractionDigits: 0,
    }).format(amount) + " kr"
  );
}

/**
 * Calculates price per square meter, rounded to nearest integer.
 */
export function calculatePrisPerKvm(price: number, area: number): number {
  if (area <= 0) return 0;
  return Math.round(price / area);
}
