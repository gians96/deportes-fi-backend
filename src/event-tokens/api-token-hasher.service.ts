import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  GeneratedApiToken,
  generateApiToken,
  hashApiToken,
  hashesMatch,
  resolveApiTokenPepper,
} from './api-token.util';

export const TOKENS_NOT_CONFIGURED_MESSAGE =
  'Los tokens de integración no están configurados en el servidor';

const MIN_RECOMMENDED_PEPPER_LENGTH = 32;

/**
 * Genera y hashea tokens de integración con el pepper de entorno
 * (`API_TOKEN_PEPPER`). Nunca registra el pepper ni los tokens.
 */
@Injectable()
export class ApiTokenHasher {
  private readonly logger = new Logger(ApiTokenHasher.name);
  private readonly pepper: string | null;

  constructor(config: ConfigService) {
    const resolution = resolveApiTokenPepper({
      pepper: config.get<string>('API_TOKEN_PEPPER'),
      jwtSecret: config.get<string>('JWT_SECRET'),
      nodeEnv: config.get<string>('NODE_ENV'),
    });
    this.pepper = resolution.pepper;

    if (resolution.source === 'missing') {
      this.logger.error(
        'API_TOKEN_PEPPER no está definido en producción: la creación y validación de tokens de integración responderán 503.',
      );
    } else if (resolution.source === 'derived') {
      this.logger.warn(
        'API_TOKEN_PEPPER no está definido; se usa un pepper derivado de JWT_SECRET (solo para desarrollo y pruebas).',
      );
    } else if (resolution.pepper.length < MIN_RECOMMENDED_PEPPER_LENGTH) {
      this.logger.warn(
        `API_TOKEN_PEPPER tiene menos de ${MIN_RECOMMENDED_PEPPER_LENGTH} caracteres; usa un valor aleatorio más largo.`,
      );
    }
  }

  get isConfigured(): boolean {
    return this.pepper !== null;
  }

  /** Lanza 503 si el servidor no puede operar tokens (producción sin pepper). */
  assertConfigured(): void {
    this.requirePepper();
  }

  /** Genera un token nuevo y su hash. El valor en claro no se persiste. */
  generate(): GeneratedApiToken & { tokenHash: string } {
    const pepper = this.requirePepper();
    const generated = generateApiToken();
    return { ...generated, tokenHash: hashApiToken(generated.token, pepper) };
  }

  hash(token: string): string {
    return hashApiToken(token, this.requirePepper());
  }

  /** Comparación en tiempo constante de dos hashes. */
  matches(expectedHash: string, storedHash: string): boolean {
    return hashesMatch(expectedHash, storedHash);
  }

  private requirePepper(): string {
    if (this.pepper === null) {
      throw new ServiceUnavailableException({
        statusCode: 503,
        message: TOKENS_NOT_CONFIGURED_MESSAGE,
      });
    }
    return this.pepper;
  }
}
