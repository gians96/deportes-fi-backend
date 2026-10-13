import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UndcApiConfig, UndcApiStatus } from '@prisma/client';
import {
  assertPublicDestination,
  validateOutboundUrl,
} from '../common/outbound-url';
import type { EncryptionKeySource } from '../dni-providers/dni-tokens.service';
import {
  decryptSecret,
  deriveSecretKey,
  encryptSecret,
  parseSecretKey,
} from '../dni-providers/secret-box';
import { PrismaService } from '../prisma/prisma.service';
import { SaveUndcApiDto } from './dto/undc-api.dto';

const CONFIG_ID = 1;
const DEFAULT_TIMEOUT_MS = 8000;
const MAX_BODY_BYTES = 64 * 1024;
/** Código que no corresponde a nadie: sirve para comprobar URL, key y permiso sin tocar datos reales. */
const TEST_CODE = '00000000';

/** Estudiante tal como lo devuelve API_UNDC (`POST /externo/estudiantes/consultar`). */
export interface UndcStudent {
  fullName: string;
  studentCode: string;
  dni: string | null;
}

/** La conexión tal como la ve el panel: nunca incluye la API key, solo su máscara. */
export interface UndcApiView {
  configured: boolean;
  baseUrl: string | null;
  keyMask: string | null;
  timeoutMs: number;
  enabled: boolean;
  lastStatus: UndcApiStatus | null;
  lastError: string | null;
  lastCheckedAt: Date | null;
  updatedAt: Date | null;
  encryptionKey: EncryptionKeySource;
}

type CallResult =
  | { ok: true; student: UndcStudent | null }
  | { ok: false; message: string };

@Injectable()
export class UndcApiService {
  private readonly logger = new Logger(UndcApiService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async get(): Promise<UndcApiView> {
    const row = await this.prisma.undcApiConfig.findUnique({
      where: { id: CONFIG_ID },
    });
    return this.toView(row);
  }

  async save(dto: SaveUndcApiDto, actorId: number): Promise<UndcApiView> {
    const baseUrl = validateOutboundUrl(dto.baseUrl, {
      field: 'La URL de API_UNDC',
    });
    const existing = await this.prisma.undcApiConfig.findUnique({
      where: { id: CONFIG_ID },
    });
    const apiKey = (dto.apiKey ?? '').trim().replace(/^bearer\s+/i, '');
    if (!existing && !apiKey) {
      throw new BadRequestException('Escribe la API key de API_UNDC.');
    }
    if (apiKey && apiKey.length < 20) {
      throw new BadRequestException('La API key es demasiado corta.');
    }

    const rotated = apiKey ? this.encryptKey(apiKey) : null;
    const changed = !!rotated || existing?.baseUrl !== baseUrl;
    const data = {
      baseUrl,
      timeoutMs: dto.timeoutMs ?? existing?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      enabled: dto.enabled ?? existing?.enabled ?? true,
      updatedById: actorId,
      // Una URL o key nuevas invalidan el resultado de la última prueba.
      ...(changed
        ? { lastStatus: null, lastError: null, lastCheckedAt: null }
        : {}),
      ...(rotated ?? {}),
    };
    const row = existing
      ? await this.prisma.undcApiConfig.update({
          where: { id: CONFIG_ID },
          data,
        })
      : await this.prisma.undcApiConfig.create({
          data: {
            id: CONFIG_ID,
            ...data,
            ...(rotated as NonNullable<typeof rotated>),
          },
        });
    return this.toView(row);
  }

  async remove(): Promise<void> {
    await this.prisma.undcApiConfig.deleteMany({ where: { id: CONFIG_ID } });
  }

  /** «Probar»: una consulta con un código inexistente; solo informa si la conexión funciona. */
  async test(): Promise<{ ok: boolean; message: string }> {
    const row = await this.prisma.undcApiConfig.findUnique({
      where: { id: CONFIG_ID },
    });
    if (!row) throw new NotFoundException('API_UNDC no está configurada.');
    const keyInfo = this.keyAndSource();
    if (!keyInfo) throw this.noKeyError();

    const result = await this.call(row, keyInfo.key, TEST_CODE);
    await this.prisma.undcApiConfig.update({
      where: { id: CONFIG_ID },
      data: {
        lastStatus: result.ok ? UndcApiStatus.OK : UndcApiStatus.FAILED,
        lastError: result.ok ? null : result.message.slice(0, 300),
        lastCheckedAt: new Date(),
      },
    });
    return {
      ok: result.ok,
      message: result.ok ? 'API_UNDC respondió correctamente.' : result.message,
    };
  }

  /**
   * Nombre y DNI de un estudiante por código. Devuelve `null` si la conexión no está configurada o
   * activa, si falla o si API_UNDC no lo conoce: quien llama sigue con la búsqueda pública de SIVIRENO.
   */
  async lookupStudent(code: string): Promise<UndcStudent | null> {
    const row = await this.prisma.undcApiConfig.findUnique({
      where: { id: CONFIG_ID },
    });
    if (!row?.enabled) return null;
    const keyInfo = this.keyAndSource();
    if (!keyInfo) return null;

    const result = await this.call(row, keyInfo.key, code);
    await this.recordResult(row, result);
    return result.ok ? result.student : null;
  }

  encryptionKeySource(): EncryptionKeySource {
    return this.keyAndSource()?.source ?? 'none';
  }

  private async call(
    row: UndcApiConfig,
    key: Buffer,
    code: string,
  ): Promise<CallResult> {
    let apiKey: string;
    try {
      apiKey = decryptSecret(
        { ciphertext: row.keyCipher, iv: row.keyIv, authTag: row.keyTag },
        key,
      );
    } catch {
      return {
        ok: false,
        message:
          'No se pudo descifrar la API key guardada (cambió la clave de cifrado del servidor): vuelve a guardarla.',
      };
    }

    const url = `${row.baseUrl}/externo/estudiantes/consultar`;
    try {
      await assertPublicDestination(url);
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'X-API-Key': apiKey,
        },
        body: JSON.stringify({ codigo: code }),
        redirect: 'error',
        signal: AbortSignal.timeout(row.timeoutMs),
      });
      if (response.status === 401) {
        return {
          ok: false,
          message:
            'API_UNDC rechazó la API key (inválida, vencida o revocada).',
        };
      }
      if (response.status === 403) {
        return {
          ok: false,
          message: 'La API key no tiene el permiso estudiantes:consultar.',
        };
      }
      if (response.status === 429) {
        return { ok: false, message: 'API_UNDC limitó las solicitudes (429).' };
      }
      if (!response.ok) {
        return {
          ok: false,
          message: `API_UNDC respondió HTTP ${response.status}.`,
        };
      }
      const text = await response.text();
      if (text.length > MAX_BODY_BYTES) {
        return {
          ok: false,
          message: 'La respuesta de API_UNDC es demasiado grande.',
        };
      }
      return this.parse(text);
    } catch (error) {
      return { ok: false, message: this.failureMessage(error) };
    }
  }

  private parse(text: string): CallResult {
    let data: Record<string, unknown> | undefined;
    try {
      data = (JSON.parse(text) as { data?: Record<string, unknown> }).data;
    } catch {
      data = undefined;
    }
    if (!data || typeof data.encontrado !== 'boolean') {
      return { ok: false, message: 'Respuesta de API_UNDC no reconocida.' };
    }
    if (!data.encontrado) return { ok: true, student: null };

    const fullName =
      typeof data.nombre_completo === 'string'
        ? data.nombre_completo.replace(/\s+/g, ' ').trim()
        : '';
    const studentCode =
      typeof data.codigo_estudiante === 'string'
        ? data.codigo_estudiante.trim()
        : '';
    if (!fullName || !studentCode) {
      return { ok: false, message: 'Respuesta de API_UNDC no reconocida.' };
    }
    const dni =
      typeof data.dni === 'string' && /^\d{8}$/.test(data.dni.trim())
        ? data.dni.trim()
        : null;
    return { ok: true, student: { fullName, studentCode, dni } };
  }

  private failureMessage(error: unknown): string {
    if (error instanceof BadRequestException) {
      return error.message;
    }
    const name = (error as { name?: string })?.name;
    if (name === 'TimeoutError' || name === 'AbortError') {
      return 'API_UNDC no respondió a tiempo.';
    }
    return 'No se pudo conectar con API_UNDC. Revisa que la URL sea la de la API y no la de un sitio web.';
  }

  /** Guarda el resultado solo cuando cambia, para no escribir en la base en cada búsqueda. */
  private async recordResult(
    row: UndcApiConfig,
    result: CallResult,
  ): Promise<void> {
    const status = result.ok ? UndcApiStatus.OK : UndcApiStatus.FAILED;
    const error = result.ok ? null : result.message.slice(0, 300);
    if (row.lastStatus === status && row.lastError === error) return;
    if (!result.ok) {
      this.logger.warn(`Consulta a API_UNDC fallida: ${result.message}`);
    }
    await this.prisma.undcApiConfig
      .update({
        where: { id: CONFIG_ID },
        data: {
          lastStatus: status,
          lastError: error,
          lastCheckedAt: new Date(),
        },
      })
      .catch(() => undefined);
  }

  private toView(row: UndcApiConfig | null): UndcApiView {
    return {
      configured: !!row,
      baseUrl: row?.baseUrl ?? null,
      keyMask: row ? `••••${row.keyLast4}` : null,
      timeoutMs: row?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      enabled: row?.enabled ?? false,
      lastStatus: row?.lastStatus ?? null,
      lastError: row?.lastError ?? null,
      lastCheckedAt: row?.lastCheckedAt ?? null,
      updatedAt: row?.updatedAt ?? null,
      encryptionKey: this.encryptionKeySource(),
    };
  }

  private encryptKey(apiKey: string) {
    const keyInfo = this.keyAndSource();
    if (!keyInfo) throw this.noKeyError();
    const encrypted = encryptSecret(apiKey, keyInfo.key);
    return {
      keyCipher: encrypted.ciphertext,
      keyIv: encrypted.iv,
      keyTag: encrypted.authTag,
      keyLast4: apiKey.slice(-4),
    };
  }

  private noKeyError(): HttpException {
    return new HttpException(
      'No hay una clave para cifrar la API key: el servidor no tiene INTEGRATION_SECRET_KEY ni JWT_SECRET.',
      HttpStatus.SERVICE_UNAVAILABLE,
    );
  }

  private keyAndSource(): { key: Buffer; source: EncryptionKeySource } | null {
    const dedicated = parseSecretKey(
      this.config.get<string>('INTEGRATION_SECRET_KEY'),
    );
    if (dedicated) return { key: dedicated, source: 'dedicated' };
    const derived = deriveSecretKey(this.config.get<string>('JWT_SECRET'));
    return derived ? { key: derived, source: 'derived' } : null;
  }
}
