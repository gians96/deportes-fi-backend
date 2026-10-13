import { HttpException, HttpStatus } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { DniLookupOrigin, DniProvider } from '@prisma/client';
import type { DniLookupService } from '../dni-providers/dni-lookup.service';
import { AcademicService } from './academic.service';

/**
 * Configuración falsa: el `ConfigService` real cae a `process.env`, donde el cliente de Prisma ya
 * cargó el `.env` del backend, y las pruebas dejarían de ser herméticas.
 */
function fakeConfig(values: Record<string, string> = {}): ConfigService {
  return { get: (key: string) => values[key] } as unknown as ConfigService;
}

function build(lookup: jest.Mock) {
  return new AcademicService(fakeConfig(), {
    lookup,
  } as unknown as DniLookupService);
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
