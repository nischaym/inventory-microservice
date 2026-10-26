export const VIN_LENGTH = 17;

/** VINs compare ignoring surrounding whitespace and letter case (FR-16). */
export function normalizeVin(rawVin: string): string {
  return rawVin.trim().toUpperCase();
}

/** Length check only; check digit and character set are deliberately not enforced (D-9). */
export function hasValidVinLength(rawVin: string): boolean {
  return normalizeVin(rawVin).length === VIN_LENGTH;
}
