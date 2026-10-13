import { HttpException, HttpStatus, Injectable } from '@nestjs/common';

interface Bucket {
  failures: number;
  resetAt: number;
}

const WINDOW_MS = 15 * 60 * 1000;
/** Fallos permitidos desde una misma IP contra un mismo correo. */
const MAX_PER_IP_AND_EMAIL = 5;
/**
 * Fallos permitidos contra un mismo correo desde cualquier IP: corta la fuerza bruta aunque el atacante
 * cambie el encabezado `X-Forwarded-For`. Es holgado para que un tercero no pueda bloquear una cuenta
 * con unos pocos intentos.
 */
const MAX_PER_EMAIL = 20;
const MAX_ENTRIES = 5000;

/**
 * Bloqueo temporal por intentos fallidos de contraseña. Vive en memoria (una sola instancia del
 * servidor, igual que `AppRateLimitGuard`); con varias instancias habría que moverlo a la base.
 */
@Injectable()
export class LoginThrottle {
  private readonly buckets = new Map<string, Bucket>();

  /** Lanza 429 si el correo (o la IP con ese correo) ya agotó sus intentos. */
  assertAllowed(ip: string, email: string): void {
    const now = Date.now();
    this.purgeExpired(now);
    const blocked =
      this.failuresOf(this.ipKey(ip, email), now) >= MAX_PER_IP_AND_EMAIL ||
      this.failuresOf(this.emailKey(email), now) >= MAX_PER_EMAIL;
    if (blocked) {
      throw new HttpException(
        'Demasiados intentos fallidos. Espera unos minutos e inténtalo de nuevo.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  recordFailure(ip: string, email: string): void {
    const now = Date.now();
    this.bump(this.ipKey(ip, email), now);
    this.bump(this.emailKey(email), now);
  }

  recordSuccess(ip: string, email: string): void {
    this.buckets.delete(this.ipKey(ip, email));
    this.buckets.delete(this.emailKey(email));
  }

  private ipKey(ip: string, email: string): string {
    return `ip:${ip}|${email.toLowerCase()}`;
  }

  private emailKey(email: string): string {
    return `email:${email.toLowerCase()}`;
  }

  private failuresOf(key: string, now: number): number {
    const bucket = this.buckets.get(key);
    return bucket && bucket.resetAt > now ? bucket.failures : 0;
  }

  private bump(key: string, now: number): void {
    const current = this.buckets.get(key);
    const bucket =
      current && current.resetAt > now
        ? current
        : { failures: 0, resetAt: now + WINDOW_MS };
    bucket.failures += 1;
    this.buckets.set(key, bucket);
  }

  private purgeExpired(now: number): void {
    if (this.buckets.size < MAX_ENTRIES) return;
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key);
    }
    // Si aun así hay demasiadas entradas vigentes, se descartan las más antiguas.
    for (const key of this.buckets.keys()) {
      if (this.buckets.size < MAX_ENTRIES) break;
      this.buckets.delete(key);
    }
  }
}
