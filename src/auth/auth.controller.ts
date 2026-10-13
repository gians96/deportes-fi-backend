import {
  Body,
  Controller,
  Get,
  Ip,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { AuthService } from './auth.service';
import { GoogleLoginDto } from './dto/google-login.dto';
import { PasswordLoginDto } from './dto/password-login.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import {
  CurrentUser,
} from '../common/decorators/current-user.decorator';
import type { RequestUser } from '../common/decorators/current-user.decorator';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('google')
  google(@Body() dto: GoogleLoginDto) {
    return this.auth.loginWithGoogle(dto.idToken);
  }

  @Post('login')
  login(
    @Body() dto: PasswordLoginDto,
    @Req() request: Request,
    @Ip() ip: string,
  ) {
    return this.auth.loginWithPassword(
      this.clientIp(request) ?? ip,
      dto.email,
      dto.password,
    );
  }

  /** Misma regla que el límite global: la IP original viene en `X-Forwarded-For` detrás del proxy. */
  private clientIp(request: Request): string | undefined {
    const forwarded = request.headers['x-forwarded-for'];
    const first = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    return first?.split(',')[0]?.trim() || undefined;
  }

  @UseGuards(JwtAuthGuard)
  @Get('me')
  me(@CurrentUser() user: RequestUser) {
    return this.auth.getProfile(user.id);
  }

  @UseGuards(JwtAuthGuard)
  @Patch('me/profile')
  updateProfile(
    @CurrentUser() user: RequestUser,
    @Body() dto: UpdateProfileDto,
  ) {
    return this.auth.updateProfile(
      user.id,
      dto.facultyId,
      dto.schoolId,
      dto.dni,
    );
  }
}
