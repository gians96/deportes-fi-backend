import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
} from '@nestjs/common';
import type { Request } from 'express';
import { PrismaService } from '../../prisma/prisma.service';
import { ApiTokenHasher } from '../../event-tokens/api-token-hasher.service';
import {
  eventApiTokenStatus,
  isWellFormedApiToken,
} from '../../event-tokens/api-token.util';
import {
  invalidEventTokenException,
  RequestWithEventToken,
} from '../decorators/current-event-token.decorator';

/** Frecuencia máxima de escritura de `lastUsedAt` por token. */
export const LAST_USED_THROTTLE_MS = 60_000;

/**
 * Autentica integraciones servidor a servidor con `X-Api-Key: dfi_<token>`.
 * Es independiente del JWT de usuario: no requiere ni usa `Authorization`.
 * Adjunta `request.eventToken = { tokenId, eventId }`.
 */
@Injectable()
export class EventTokenGuard implements CanActivate {
  private readonly logger = new Logger(EventTokenGuard.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly hasher: ApiTokenHasher,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<Request & RequestWithEventToken>();
    const presented = request.headers['x-api-key'];

    // Formato inválido: se rechaza sin consultar la base de datos.
    if (!isWellFormedApiToken(presented)) {
      throw invalidEventTokenException();
    }

    const tokenHash = this.hasher.hash(presented);
    const token = await this.prisma.eventApiToken.findUnique({
      where: { tokenHash },
      select: {
        id: true,
        eventId: true,
        tokenHash: true,
        revokedAt: true,
        expiresAt: true,
        lastUsedAt: true,
      },
    });

    const now = new Date();
    if (
      !token ||
      !this.hasher.matches(tokenHash, token.tokenHash) ||
      eventApiTokenStatus(token, now) !== 'ACTIVE'
    ) {
      throw invalidEventTokenException();
    }

    request.eventToken = { tokenId: token.id, eventId: token.eventId };
    this.touchLastUsed(token.id, token.lastUsedAt, now);
    return true;
  }

  /** Actualiza `lastUsedAt` sin bloquear la respuesta (fire-and-forget). */
  private touchLastUsed(
    tokenId: number,
    lastUsedAt: Date | null,
    now: Date,
  ): void {
    if (
      lastUsedAt &&
      now.getTime() - lastUsedAt.getTime() < LAST_USED_THROTTLE_MS
    ) {
      return;
    }
    this.prisma.eventApiToken
      .updateMany({ where: { id: tokenId }, data: { lastUsedAt: now } })
      .catch((error: unknown) => {
        this.logger.warn(
          `No se pudo actualizar lastUsedAt del token ${tokenId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
  }
}
