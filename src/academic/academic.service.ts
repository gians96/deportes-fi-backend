import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DniLookupOrigin } from '@prisma/client';
import { DniLookupService } from '../dni-providers/dni-lookup.service';
import { UndcApiService } from '../undc-api/undc-api.service';

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
    private readonly dniLookup: DniLookupService,
    private readonly undcApi: UndcApiService,
  ) {
    this.endpoint =
      this.config.get<string>('ACADEMIC_API_URL') ??
      'https://sivireno.undc.edu.pe/tiger/consulta/con_searchEstudiante.php';
  }

  /**
   * Consulta el padrón académico por código de estudiante. Si la conexión con API_UNDC (JP) está
   * configurada, se consulta primero porque devuelve también el DNI; ante cualquier falla, o si no lo
   * conoce, se usa la búsqueda pública de SIVIRENO (sin DNI). Por privacidad, la búsqueda pública solo
   * devuelve a la persona cuando la respuesta contiene un único resultado.
   */
  async findUniqueStudent(buscador: string): Promise<AcademicPerson | null> {
    if (/^\d{8,12}$/.test(buscador)) {
      const student = await this.undcApi.lookupStudent(buscador);
      if (student) {
        return {
          fullName: student.fullName,
          studentCode: student.studentCode,
          dni: student.dni,
        };
      }
    }
    const results = await this.query(buscador);
    if (results.length !== 1) {
      return null;
    }
    return this.normalizeStudent(results[0]);
  }

  /**
   * Consulta los datos de una persona por DNI con el pool de tokens (Admin → Integraciones): caché de 30
   * días, tokens por prioridad con respaldo automático y, si un proveedor no lo encuentra, un token del
   * otro antes de responder que no existe. `origin` solo sirve para la bitácora.
   */
  async findByDni(
    numero: string,
    origin: DniLookupOrigin = DniLookupOrigin.ROSTER,
  ): Promise<AcademicPerson | null> {
    if (!/^\d{8}$/.test(numero)) {
      return null;
    }
    const result = await this.dniLookup.lookup(numero, origin);
    if (!result) return null;
    return {
      fullName: result.person.fullName,
      studentCode: null,
      dni: result.person.dni,
    };
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
