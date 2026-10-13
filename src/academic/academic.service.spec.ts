import { HttpException, HttpStatus } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { DniLookupOrigin, DniProvider } from '@prisma/client';
import type { DniLookupService } from '../dni-providers/dni-lookup.service';
import type { UndcApiService } from '../undc-api/undc-api.service';
import { AcademicService } from './academic.service';

/**
 * Configuración falsa: el `ConfigService` real cae a `process.env`, donde el cliente de Prisma ya
 * cargó el `.env` del backend, y las pruebas dejarían de ser herméticas.
 */
function fakeConfig(values: Record<string, string> = {}): ConfigService {
  return { get: (key: string) => values[key] } as unknown as ConfigService;
}

function build(
  lookup: jest.Mock,
  lookupStudent: jest.Mock = jest.fn().mockResolvedValue(null),
) {
  return new AcademicService(
    fakeConfig(),
    { lookup } as unknown as DniLookupService,
    { lookupStudent } as unknown as UndcApiService,
  );
}

describe('AcademicService.findByDni', () => {
  it('no consulta nada si el DNI no tiene 8 dígitos', async () => {
    const lookup = jest.fn();
    const service = build(lookup);
    for (const bad of ['', '1234567', '123456789', '1234567a', ' 76251607']) {
      await expect(service.findByDni(bad)).resolves.toBeNull();
    }
    expect(lookup).not.toHaveBeenCalled();
  });

  it('devuelve la persona que entrega el pool, sin código de estudiante', async () => {
    const lookup = jest.fn().mockResolvedValue({
      person: { dni: '76251607', fullName: 'PEREZ GOMEZ JUAN' },
      source: 'PROVIDER',
      provider: DniProvider.DECOLECTA,
    });
    const person = await build(lookup).findByDni('76251607');
    expect(person).toEqual({
      fullName: 'PEREZ GOMEZ JUAN',
      studentCode: null,
      dni: '76251607',
    });
  });

  it('el origen por defecto es la nómina de equipos; el perfil lo indica aparte', async () => {
    const lookup = jest.fn().mockResolvedValue(null);
    const service = build(lookup);
    await service.findByDni('76251607');
    await service.findByDni('76251607', DniLookupOrigin.PROFILE);
    expect(lookup.mock.calls).toEqual([
      ['76251607', DniLookupOrigin.ROSTER],
      ['76251607', DniLookupOrigin.PROFILE],
    ]);
  });

  it('un DNI que ningún proveedor encuentra es null (el controlador responde 404)', async () => {
    await expect(
      build(jest.fn().mockResolvedValue(null)).findByDni('76251607'),
    ).resolves.toBeNull();
  });

  it('los errores del pool llegan tal cual (503 sin tokens, 502 si todos fallan)', async () => {
    const unavailable = new HttpException(
      'El servicio de consulta por DNI no está configurado',
      HttpStatus.SERVICE_UNAVAILABLE,
    );
    await expect(
      build(jest.fn().mockRejectedValue(unavailable)).findByDni('76251607'),
    ).rejects.toBe(unavailable);
  });
});

describe('AcademicService.findUniqueStudent (DNI automático, spec 006)', () => {
  const lookup = jest.fn();
  let fetchMock: jest.SpyInstance;

  beforeEach(() => {
    fetchMock = jest.spyOn(global, 'fetch');
  });
  afterEach(() => {
    fetchMock.mockRestore();
  });

  const sivireno = (rows: unknown[]) =>
    new Response(JSON.stringify(rows), { status: 200 });

  it('con un código completo usa primero API_UNDC y devuelve el DNI sin tocar SIVIRENO', async () => {
    const lookupStudent = jest.fn().mockResolvedValue({
      fullName: 'PRUEBA UNO PERSONA',
      studentCode: '2401010001',
      dni: '70000001',
    });
    const person = await build(lookup, lookupStudent).findUniqueStudent(
      '2401010001',
    );
    expect(person).toEqual({
      fullName: 'PRUEBA UNO PERSONA',
      studentCode: '2401010001',
      dni: '70000001',
    });
    expect(lookupStudent).toHaveBeenCalledWith('2401010001');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('si API_UNDC no responde o no lo conoce, cae a la búsqueda pública (sin DNI)', async () => {
    fetchMock.mockResolvedValue(
      sivireno([
        {
          id_estu: '9001',
          cod_estu: '2401010001',
          estudiante: 'PRUEBA  UNO PERSONA',
        },
      ]),
    );
    const person = await build(lookup).findUniqueStudent('2401010001');
    expect(person).toEqual({
      fullName: 'PRUEBA UNO PERSONA',
      studentCode: '2401010001',
      dni: null,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('una búsqueda que no es un código completo (nombre, DNI) no consulta a API_UNDC', async () => {
    const lookupStudent = jest.fn();
    fetchMock.mockImplementation(() => Promise.resolve(sivireno([])));
    for (const text of ['perez juan', '7625160', 'ab12345678']) {
      await build(lookup, lookupStudent).findUniqueStudent(text);
    }
    expect(lookupStudent).not.toHaveBeenCalled();
  });

  it('la búsqueda pública solo devuelve a la persona si hay un único resultado', async () => {
    fetchMock.mockResolvedValue(
      sivireno([
        { cod_estu: '2401010001', estudiante: 'UNO' },
        { cod_estu: '2401010002', estudiante: 'DOS' },
      ]),
    );
    await expect(
      build(lookup).findUniqueStudent('2401010001'),
    ).resolves.toBeNull();
  });
});
