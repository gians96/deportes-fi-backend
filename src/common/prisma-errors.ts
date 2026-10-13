/** Código de error de Prisma (p. ej. `P2002` único violado, `P2034` conflicto de transacción). */
export function prismaErrorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null
    ? (error as { code?: string }).code
    : undefined;
}
