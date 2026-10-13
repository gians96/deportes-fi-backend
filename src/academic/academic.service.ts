import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { lookupDni } from '../dni-providers/dni-lookup';
import { DniProvidersService } from '../dni-providers/dni-providers.service';

/** Respuesta cruda del padrón académico de sivireno. */
interface RawAcademicStudent {
  idEstu?: string;
  nivel?: string;
  codEstu?: string;
  estudiante?: string;
  egreso?: string | null;
  [key: string]: unknown;
}

/** Persona normalizada que consume el frontend, sin importar la fuente. */
export interface AcademicPerson {
  fullName: string;
  studentCode: string | null;
  dni: string | null;
}

@Injectable()
export class AcademicService {
  private readonly logger = new Logger(AcademicService.name);
  private readonly endpoint: string;

  constructor(
    private readonly config: ConfigService,
    private readonly dniProviders: DniProvidersService,
  ) {
    this.endpoint =
      this.config.get<string>('ACADEMIC_API_URL') ??
      'https://sivireno.undc.edu.pe/tiger/consulta/con_searchEstudiante.php';
  }

  /**
   * Consulta el padrón académico por código de estudiante. Por privacidad,
   * solo devuelve a la persona cuando la respuesta contiene un único resultado.
   */
  async findUniqueStudent(buscador: string): Promise<AcademicPerson | null> {
    const results = await this.query(buscador);
    if (results.length !== 1) {
      return null;
    }
    return this.normalizeStudent(results[0]);
  }

  /**
   * Consulta los datos de una persona por DNI. Recorre los proveedores activos con token (Decolecta,
   * API Perú…) por prioridad: si uno no puede responder prueba el siguiente y solo se detiene ante
   * un resultado definitivo (encontrado o "no existe"). Se configuran en Ajustes → Proveedores de DNI.
   */
  async findByDni(numero: string): Promise<AcademicPerson | null> {
    if (!/^\d{8}$/.test(numero)) {
      return null;
    }
    const chain = await this.dniProviders.resolveChain();
    if (!chain.length) {
      throw new HttpException(
        'El servicio de consulta por DNI no está configurado',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    let someoneRejected = false;
    for (const provider of chain) {
      const outcome = await lookupDni(provider.provider, {
        url: provider.url,
        token: provider.token,
        dni: numero,
      });
      await this.dniProviders.recordOutcome(provider.provider, outcome);

      if (outcome.kind === 'found') {
        return {
          fullName: outcome.person.fullName,
          studentCode: null,
          dni: outcome.person.dni,
        };
      }
      if (outcome.kind === 'not_found') {
        return null;
      }
      if (outcome.kind !== 'unavailable') someoneRejected = true;
      this.logger.warn(
        `Proveedor de DNI ${provider.provider} no pudo responder (${outcome.kind})`,
      );
    }

    throw new HttpException(
      someoneRejected
        ? 'No se pudo consultar el DNI'
        : 'Servicio de consulta por DNI no disponible',
      HttpStatus.BAD_GATEWAY,
    );
  }

  /** Normaliza el registro del padrón a la forma que consume el frontend. */
  private normalizeStudent(raw: RawAcademicStudent): AcademicPerson {
    const code =
      raw.codEstu ??
      (raw['codigo'] as string | undefined) ??
      (raw['cod_estu'] as string | undefined) ??
      null;
    const name =
      raw.estudiante ??
      (raw['nombre'] as string | undefined) ??
      (raw['nombres'] as string | undefined) ??
      '';
    return {
      fullName: name.replace(/\s+/g, ' ').trim(),
      studentCode: code ? String(code).trim() : null,
      dni: (raw['dni'] as string | undefined) ?? null,
    };
  }

  async query(buscador: string): Promise<RawAcademicStudent[]> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ opcion: 7, buscador }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new HttpException(
          'No se pudo consultar el padrón académico',
          HttpStatus.BAD_GATEWAY,
        );
      }

      const data = (await response.json()) as unknown;
      if (!Array.isArray(data)) {
        return [];
      }
      return data as RawAcademicStudent[];
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      this.logger.error(`Error consultando padrón académico: ${String(error)}`);
      throw new HttpException(
        'Servicio académico no disponible',
        HttpStatus.BAD_GATEWAY,
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}
