import {
  ParticipantType,
  RegistrationStatus,
  VoucherStatus,
} from '@prisma/client';

// Formas de respuesta del Contrato 2 (backend-ciisic/docs/arquitectura-ecosistema.md).
// Los montos son soles con hasta 2 decimales.

export interface IntegrationEvent {
  id: number;
  name: string;
  description: string | null;
  startDate: Date;
  endDate: Date;
  isOpen: boolean;
}

export interface MoneyBucket {
  count: number;
  amount: number;
}

export interface IntegrationSummary {
  event: { id: number; name: string; startDate: Date; endDate: Date };
  currency: 'PEN';
  teams: {
    total: number;
    pending: number;
    approved: number;
    rejected: number;
    cancelled: number;
  };
  participants: { total: number };
  payments: {
    validated: MoneyBucket;
    pending: MoneyBucket;
    rejected: MoneyBucket;
  };
  byDiscipline: IntegrationDisciplineSummary[];
  byParticipantType: IntegrationParticipantTypeSummary[];
  generatedAt: Date;
}

export interface IntegrationDisciplineSummary {
  disciplineId: number;
  name: string;
  participantType: ParticipantType;
  isPaid: boolean;
  cost: number;
  teams: { total: number; approved: number; pending: number };
  validatedAmount: number;
  pendingAmount: number;
}

export interface IntegrationParticipantTypeSummary {
  participantType: ParticipantType;
  teams: number;
  validatedAmount: number;
  pendingAmount: number;
}

export interface IntegrationPayment {
  id: number;
  amount: number;
  status: VoucherStatus;
  operationNumber: string | null;
  uploadedAt: Date;
  updatedAt: Date;
  teamName: string;
  disciplineName: string;
  participantType: ParticipantType;
}

export interface IntegrationRegistration {
  id: number;
  name: string;
  status: RegistrationStatus;
  disciplineName: string;
  participantType: ParticipantType;
  participantsCount: number;
  createdAt: Date;
}

export interface Paginated<T> {
  data: T[];
  meta: { page: number; pageSize: number; total: number };
}
