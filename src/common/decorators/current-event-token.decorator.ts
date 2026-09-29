import {
  createParamDecorator,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';

/** Contexto que `EventTokenGuard` adjunta a la solicitud. */
export interface EventTokenContext {
  tokenId: number;
  /** Evento del token: la única fuente del evento en las integraciones. */
  eventId: number;
}

export interface RequestWithEventToken {
  eventToken?: EventTokenContext;
}

export const INVALID_EVENT_TOKEN_MESSAGE = 'Token de integración inválido';

/**
 * 401 con el cuerpo exacto del Contrato 2. Se pasa un objeto para que Nest no
 * agregue el campo `error`.
 */
export function invalidEventTokenException(): UnauthorizedException {
  return new UnauthorizedException({
    statusCode: 401,
    message: INVALID_EVENT_TOKEN_MESSAGE,
  });
}

/** Inyecta `{ tokenId, eventId }`; falla cerrado si el guard no se aplicó. */
export const CurrentEventToken = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): EventTokenContext => {
    const request = ctx.switchToHttp().getRequest<RequestWithEventToken>();
    if (!request.eventToken) {
      throw invalidEventTokenException();
    }
    return request.eventToken;
  },
);
