import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { JwtPayload, TokenExpiredError, verify } from 'jsonwebtoken';
import { MessageError, MessageIdentity, UserPublic } from './messages.types';

export class MessageAuthError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }

  toPublic(): MessageError {
    return { code: this.code, message: this.message };
  }
}

const AUTH_TIMEOUT_MS = 3000;

@Injectable()
export class AuthIdentityService {
  private readonly secret: string;
  private readonly baseUrl: string;

  constructor(config: ConfigService) {
    this.secret = config.getOrThrow<string>('JWT_SECRET');
    if (!this.secret.trim()) throw new Error('JWT_SECRET es obligatorio.');

    const url = new URL(config.getOrThrow<string>('AUTH_API_URL'));
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== '/'
    ) {
      throw new Error(
        'AUTH_API_URL debe ser el origen HTTP de mysql-restapi, sin rutas.',
      );
    }
    this.baseUrl = url.origin;
  }

  async authenticate(token: unknown): Promise<MessageIdentity> {
    if (typeof token !== 'string' || !token.trim()) {
      throw new MessageAuthError(
        'TOKEN_REQUIRED',
        'Inicia sesión para conectar el chat.',
      );
    }
    if (token.length > 8192) throw this.invalidToken();

    let claims: JwtPayload | string;
    try {
      claims = verify(token, this.secret, { algorithms: ['HS256'] });
    } catch (error) {
      if (error instanceof TokenExpiredError) {
        throw new MessageAuthError(
          'TOKEN_EXPIRED',
          'Tu sesión caducó. Inicia sesión de nuevo.',
        );
      }
      throw this.invalidToken();
    }
    if (
      !claims ||
      typeof claims !== 'object' ||
      !Number.isSafeInteger(claims.id) ||
      claims.id <= 0 ||
      typeof claims.email !== 'string' ||
      !Number.isFinite(claims.exp) ||
      claims.exp * 1000 <= Date.now() ||
      (claims.tokenVersion !== undefined &&
        (!Number.isSafeInteger(claims.tokenVersion) || claims.tokenVersion < 0))
    ) {
      throw this.invalidToken();
    }

    const body = await this.request('/api/auth/me', token);
    const user = this.parseUser(body?.user);
    if (
      user.id !== claims.id ||
      user.email !== claims.email.trim().toLowerCase() ||
      (claims.role !== undefined && claims.role !== user.role)
    ) {
      throw new MessageAuthError(
        'SESSION_REVOKED',
        'La cuenta cambió. Inicia sesión de nuevo.',
      );
    }
    if (claims.exp * 1000 <= Date.now()) {
      throw new MessageAuthError(
        'TOKEN_EXPIRED',
        'Tu sesión caducó. Inicia sesión de nuevo.',
      );
    }
    return { user, expiresAt: claims.exp * 1000 };
  }

  async contacts(token: string, selfId: number): Promise<UserPublic[]> {
    const body = await this.request('/api/users/contacts', token);
    if (!Array.isArray(body?.users)) throw this.unavailable();
    const users = body.users.map((value: unknown) => this.parseUser(value));
    const ids = new Set<number>();
    for (const user of users) {
      if (ids.has(user.id)) throw this.unavailable();
      ids.add(user.id);
    }
    return users.filter((user: UserPublic) => user.id !== selfId);
  }

  private async request(path: string, token: string): Promise<any> {
    let response;
    try {
      response = await axios.get(`${this.baseUrl}${path}`, {
        headers: { Authorization: `Bearer ${token}` },
        timeout: AUTH_TIMEOUT_MS,
        maxRedirects: 0,
        maxContentLength: 1024 * 1024,
        validateStatus: () => true,
      });
    } catch {
      throw this.unavailable();
    }
    if (response.status === 401 || response.status === 403) {
      if (response.data?.code === 'ACCOUNT_NOT_FOUND') {
        throw new MessageAuthError(
          'ACCOUNT_NOT_FOUND',
          'Esta cuenta ya no está disponible.',
        );
      }
      throw new MessageAuthError(
        'SESSION_REVOKED',
        'La sesión ya no es válida. Inicia sesión de nuevo.',
      );
    }
    if (
      response.status !== 200 ||
      !response.data ||
      typeof response.data !== 'object'
    ) {
      throw this.unavailable();
    }
    return response.data;
  }

  private parseUser(value: unknown): UserPublic {
    if (!value || typeof value !== 'object') throw this.unavailable();
    const user = value as Record<string, unknown>;
    if (
      !Number.isSafeInteger(user.id) ||
      (user.id as number) <= 0 ||
      typeof user.email !== 'string' ||
      !user.email.trim() ||
      user.email.length > 254 ||
      typeof user.first_name !== 'string' ||
      typeof user.last_name !== 'string' ||
      (user.role !== 'player' && user.role !== 'admin')
    ) {
      throw this.unavailable();
    }
    return {
      id: user.id as number,
      email: user.email.trim().toLowerCase(),
      first_name: user.first_name,
      last_name: user.last_name,
      role: user.role,
    };
  }

  private invalidToken(): MessageAuthError {
    return new MessageAuthError('INVALID_TOKEN', 'La sesión no es válida.');
  }

  private unavailable(): MessageAuthError {
    return new MessageAuthError(
      'AUTH_UNAVAILABLE',
      'No se pudo verificar la cuenta. Inténtalo de nuevo.',
    );
  }
}
