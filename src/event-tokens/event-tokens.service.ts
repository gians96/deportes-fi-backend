import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { RequestUser } from '../common/decorators/current-user.decorator';
import { ApiTokenHasher } from './api-token-hasher.service';
import { EventApiTokenStatus, eventApiTokenStatus } from './api-token.util';
import { CreateEventApiTokenDto } from './dto/create-event-api-token.dto';

/** Vista pública de un token: nunca incluye el valor en claro ni el hash. */
export interface EventApiTokenView {
  id: number;
  eventId: number;
  name: string;
  tokenPrefix: string;
  createdById: number | null;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
  status: EventApiTokenStatus;
}

/** Respuesta de creación: el único momento en que viaja `token`. */
export interface CreatedEventApiToken {
  id: number;
  name: string;
  tokenPrefix: string;
  expiresAt: Date | null;
  createdAt: Date;
  token: string;
}

const TOKEN_VIEW_SELECT = {
  id: true,
  eventId: true,
  name: true,
  tokenPrefix: true,
  createdById: true,
  lastUsedAt: true,
  expiresAt: true,
  revokedAt: true,
  createdAt: true,
} satisfies Prisma.EventApiTokenSelect;

type TokenViewRow = Prisma.EventApiTokenGetPayload<{
  select: typeof TOKEN_VIEW_SELECT;
}>;

/** Reintentos ante colisión (muy improbable) del prefijo o del hash. */
const MAX_GENERATION_ATTEMPTS = 3;

@Injectable()
export class EventTokensService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly hasher: ApiTokenHasher,
  ) {}

  async create(
    eventId: number,
    dto: CreateEventApiTokenDto,
    actor: RequestUser,
  ): Promise<CreatedEventApiToken> {
    this.hasher.assertConfigured();
    await this.ensureEvent(eventId);

    const expiresAt = dto.expiresAt ? new Date(dto.expiresAt) : null;
    if (expiresAt && expiresAt.getTime() <= Date.now()) {
      throw new BadRequestException('La fecha de expiración debe ser futura');
    }

    for (let attempt = 1; ; attempt += 1) {
      const { token, tokenPrefix, tokenHash } = this.hasher.generate();
      try {
        const created = await this.prisma.eventApiToken.create({
          data: {
            eventId,
            name: dto.name.trim(),
            tokenPrefix,
            tokenHash,
            createdById: actor.id,
            expiresAt,
          },
          select: {
            id: true,
            name: true,
            tokenPrefix: true,
            expiresAt: true,
            createdAt: true,
          },
        });
        return { ...created, token };
      } catch (error) {
        if (attempt < MAX_GENERATION_ATTEMPTS && isUniqueViolation(error)) {
          continue;
        }
        throw error;
      }
    }
  }

  async list(eventId: number): Promise<EventApiTokenView[]> {
    await this.ensureEvent(eventId);
    const tokens = await this.prisma.eventApiToken.findMany({
      where: { eventId },
      select: TOKEN_VIEW_SELECT,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    const now = new Date();
    return tokens.map((token) => toView(token, now));
  }

  /** Revoca el token (idempotente). Conserva el registro para auditoría. */
  async revoke(eventId: number, tokenId: number): Promise<EventApiTokenView> {
    const token = await this.prisma.eventApiToken.findFirst({
      where: { id: tokenId, eventId },
      select: { id: true },
    });
    if (!token) {
      throw new NotFoundException('Token no encontrado');
    }

    await this.prisma.eventApiToken.updateMany({
      where: { id: token.id, eventId, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    const revoked = await this.prisma.eventApiToken.findFirst({
      where: { id: token.id, eventId },
      select: TOKEN_VIEW_SELECT,
    });
    if (!revoked) {
      throw new NotFoundException('Token no encontrado');
    }
    return toView(revoked, new Date());
  }

  private async ensureEvent(eventId: number): Promise<void> {
    const event = await this.prisma.sportEvent.findUnique({
      where: { id: eventId },
      select: { id: true },
    });
    if (!event) {
      throw new NotFoundException('Evento no encontrado');
    }
  }
}

function toView(token: TokenViewRow, now: Date): EventApiTokenView {
  return {
    id: token.id,
    eventId: token.eventId,
    name: token.name,
    tokenPrefix: token.tokenPrefix,
    createdById: token.createdById,
    lastUsedAt: token.lastUsedAt,
    expiresAt: token.expiresAt,
    revokedAt: token.revokedAt,
    createdAt: token.createdAt,
    status: eventApiTokenStatus(token, now),
  };
}

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  );
}
