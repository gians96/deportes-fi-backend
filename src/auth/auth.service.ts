import {
  Injectable,
  UnauthorizedException,
  BadRequestException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { OAuth2Client } from 'google-auth-library';
import { DniLookupOrigin, Role, User } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AcademicService } from '../academic/academic.service';
import { LoginThrottle } from './login-throttle';
import {
  hashPassword,
  needsRehash,
  verifyAgainstDummy,
  verifyPassword,
} from './password';

export type SessionUser = Pick<
  User,
  | 'id'
  | 'email'
  | 'fullName'
  | 'role'
  | 'studentCode'
  | 'dni'
  | 'facultyId'
  | 'schoolId'
  | 'avatarUrl'
>;

const INVALID_CREDENTIALS = 'Credenciales incorrectas';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly oauthClient: OAuth2Client;
  private readonly googleClientId: string;
  private readonly ownerEmails: string[];
  private readonly adminEmails: string[];

  constructor(
    private readonly config: ConfigService,
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
    private readonly academic: AcademicService,
    private readonly throttle: LoginThrottle,
  ) {
    this.googleClientId = this.config.get<string>('GOOGLE_CLIENT_ID') ?? '';
    this.oauthClient = new OAuth2Client(this.googleClientId);
    this.ownerEmails = this.parseEmails(
      this.config.get<string>('OWNER_EMAILS'),
    );
    this.adminEmails = this.parseEmails(
      this.config.get<string>('ADMIN_EMAILS'),
    );
  }

  private parseEmails(value?: string): string[] {
    return (value ?? '')
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean);
  }

  async loginWithGoogle(
    idToken: string,
  ): Promise<{ token: string; user: SessionUser }> {
    const payload = await this.verifyGoogleToken(idToken);
    const email = (payload.email ?? '').toLowerCase();

    const code = email.split('@')[0];
    const user = await this.upsertUser(email, code, payload);
    await this.linkParticipants(user);
    return this.sessionOf(user);
  }

  /**
   * Acceso con correo y contraseña (cuentas creadas por un administrador con «Contraseña o Google»).
   * Todo fallo responde igual (cuenta inexistente, sin contraseña, inactiva o clave errónea) y hace el
   * mismo trabajo, para no revelar si el correo existe. Los intentos fallidos se limitan por correo e IP.
   */
  async loginWithPassword(
    ip: string,
    rawEmail: string,
    password: string,
  ): Promise<{ token: string; user: SessionUser }> {
    const email = rawEmail.trim().toLowerCase();
    this.throttle.assertAllowed(ip, email);

    const user = await this.prisma.user.findUnique({ where: { email } });
    const valid = user?.passwordHash
      ? await verifyPassword(password, user.passwordHash)
      : await verifyAgainstDummy(password);

    if (!user || !valid || !user.isActive) {
      this.throttle.recordFailure(ip, email);
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }
    this.throttle.recordSuccess(ip, email);

    if (user.passwordHash && needsRehash(user.passwordHash)) {
      await this.prisma.user
        .update({
          where: { id: user.id },
          data: { passwordHash: await hashPassword(password) },
        })
        .catch(() => undefined);
    }
    await this.linkParticipants(user);
    return this.sessionOf(user);
  }

  private sessionOf(user: User): { token: string; user: SessionUser } {
    return {
      token: this.signToken(user),
      user: {
        id: user.id,
        email: user.email,
        fullName: user.fullName,
        role: user.role,
        studentCode: user.studentCode,
        dni: user.dni,
        facultyId: user.facultyId,
        schoolId: user.schoolId,
        avatarUrl: user.avatarUrl,
      },
    };
  }

  private async verifyGoogleToken(idToken: string) {
    try {
      const ticket = await this.oauthClient.verifyIdToken({
        idToken,
        audience: this.googleClientId,
      });
      const payload = ticket.getPayload();
      if (!payload?.email || !payload.email_verified) {
        throw new UnauthorizedException('Token de Google inválido');
      }
      return payload;
    } catch (error) {
      this.logger.warn(`Fallo verificación Google: ${String(error)}`);
      throw new UnauthorizedException('No se pudo verificar el token de Google');
    }
  }

  private resolveRole(email: string): Role {
    if (this.ownerEmails.includes(email)) return Role.OWNER_SYSTEM;
    if (this.adminEmails.includes(email)) return Role.ADMIN_SYSTEM;
    const [account, domain] = email.split('@');
    return domain === 'undc.edu.pe' && /^\d+$/.test(account ?? '')
      ? Role.STUDENT
      : Role.OTHER;
  }

  private async upsertUser(
    email: string,
    code: string,
    payload: { name?: string; picture?: string; sub: string },
  ): Promise<User> {
    const existing = await this.prisma.user.findUnique({ where: { email } });
    // Roles de personal y cuentas con contraseña (creadas a mano por un administrador) se conservan;
    // solo estudiantes y otros se recalculan a partir del correo de Google.
    const role =
      existing &&
      (existing.passwordHash ||
        (existing.role !== Role.STUDENT && existing.role !== Role.OTHER))
        ? existing.role
        : this.resolveRole(email);

    // Para estudiantes intentamos enriquecer con el padrón académico
    let fullName = payload.name ?? existing?.fullName ?? email;
    let studentCode = existing?.studentCode ?? null;

    if (role === Role.STUDENT) {
      if (/^\d+$/.test(code)) {
        studentCode = studentCode ?? code;
      }
      const academic = await this.academic
        .findUniqueStudent(code)
        .catch(() => null);
      if (academic) {
        fullName = academic.fullName.replace(/\s+/g, ' ').trim();
        studentCode = academic.studentCode;
      }
    }

    return this.prisma.user.upsert({
      where: { email },
      create: {
        email,
        fullName,
        googleSub: payload.sub,
        avatarUrl: payload.picture ?? null,
        role,
        studentCode,
      },
      update: {
        fullName,
        googleSub: payload.sub,
        avatarUrl: payload.picture ?? null,
        role,
        ...(studentCode ? { studentCode } : {}),
      },
    });
  }

  private signToken(user: User): string {
    return this.jwt.sign({
      sub: user.id,
      email: user.email,
      role: user.role,
      tv: user.tokenVersion,
    });
  }

  /**
   * Vincula los integrantes (Participant) que aún no tienen usuario asociado
   * con este usuario, haciendo match por código de estudiante o por DNI.
   */
  private async linkParticipants(user: Pick<User, 'id' | 'studentCode' | 'dni'>) {
    const or: { studentCode?: string; dni?: string }[] = [];
    if (user.studentCode) or.push({ studentCode: user.studentCode });
    if (user.dni) or.push({ dni: user.dni });
    if (!or.length) return;
    await this.prisma.participant.updateMany({
      where: { userId: null, OR: or },
      data: { userId: user.id },
    });
  }

  async getProfile(userId: number) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        fullName: true,
        role: true,
        studentCode: true,
        dni: true,
        facultyId: true,
        schoolId: true,
        avatarUrl: true,
      },
    });
    if (!user) {
      throw new UnauthorizedException('Usuario no encontrado');
    }
    return user;
  }

  async updateProfile(
    userId: number,
    facultyId?: number,
    schoolId?: number,
    dni?: string,
  ) {
    const current = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { role: true },
    });
    if (!current) {
      throw new UnauthorizedException('Usuario no encontrado');
    }

    if (current.role === Role.OTHER) {
      const cleanDni = dni?.trim();
      if (!cleanDni || !/^\d{8}$/.test(cleanDni)) {
        throw new BadRequestException('El DNI debe tener 8 digitos');
      }
      const person = await this.academic.findByDni(
        cleanDni,
        DniLookupOrigin.PROFILE,
      );
      if (!person) {
        throw new BadRequestException('No se pudo validar el DNI');
      }
      const user = await this.prisma.user.update({
        where: { id: userId },
        data: {
          fullName: person.fullName,
          dni: person.dni ?? cleanDni,
          facultyId: null,
          schoolId: null,
        },
        select: { id: true, studentCode: true, dni: true },
      });
      await this.linkParticipants(user);
      return this.getProfile(userId);
    }

    if (!facultyId || !schoolId) {
      throw new BadRequestException('Selecciona facultad y escuela');
    }
    const school = await this.prisma.professionalSchool.findUnique({
      where: { id: schoolId },
    });
    if (!school) {
      throw new NotFoundException('Escuela no encontrada');
    }
    if (school.facultyId !== facultyId) {
      throw new BadRequestException(
        'La escuela no pertenece a la facultad seleccionada',
      );
    }
    const cleanDni = dni?.trim() || undefined;
    const user = await this.prisma.user.update({
      where: { id: userId },
      data: { facultyId, schoolId, ...(cleanDni ? { dni: cleanDni } : {}) },
      select: { id: true, studentCode: true, dni: true },
    });
    await this.linkParticipants(user);
    return this.getProfile(userId);
  }

}
