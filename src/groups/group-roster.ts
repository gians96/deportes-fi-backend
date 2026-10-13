import { BadRequestException } from '@nestjs/common';

export interface RosterMember {
  fullName: string;
  studentCode?: string | null;
  dni?: string | null;
  isCaptain?: boolean;
}

const DNI_PATTERN = /^\d{8}$/;

/**
 * Nómina de un equipo de un salón o ciclo: código de estudiante y DNI de 8 dígitos en todos los
 * integrantes, sin DNI repetidos y exactamente un capitán/a. Un mismo alumno puede estar en
 * equipos de distintas disciplinas; el duplicado se valida solo dentro del equipo.
 */
export function assertGroupRoster(members: RosterMember[]): void {
  for (const member of members) {
    if (!member.studentCode?.trim()) {
      throw new BadRequestException(
        `Falta el código de estudiante de ${member.fullName}`,
      );
    }
    if (!DNI_PATTERN.test((member.dni ?? '').trim())) {
      throw new BadRequestException(
        `Falta el DNI (8 dígitos) de ${member.fullName}`,
      );
    }
  }

  const dnis = new Set<string>();
  for (const member of members) {
    const dni = (member.dni ?? '').trim();
    if (dnis.has(dni)) {
      throw new BadRequestException(
        `DNI repetido en el equipo: ${member.fullName}`,
      );
    }
    dnis.add(dni);
  }

  const captains = members.filter((member) => member.isCaptain === true);
  if (captains.length === 0) {
    throw new BadRequestException('Designa un capitán/a del equipo');
  }
  if (captains.length > 1) {
    throw new BadRequestException(
      'Designa exactamente un capitán/a: hay más de uno',
    );
  }
}
