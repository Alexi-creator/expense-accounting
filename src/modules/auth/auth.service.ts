import { createHash, createHmac, randomUUID } from 'node:crypto';
import { ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { compare, hash } from 'bcryptjs';
import { PrismaService } from '../../prisma/prisma.service';
import { UsersService } from '../users/users.service';
import { GoogleAuthDto } from './dto/google-auth.dto';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { REFRESH_TOKEN_TTL_DAYS } from './auth.constants';
import { TelegramAuthDto } from './dto/telegram-auth.dto';

@Injectable()
export class AuthService {
  constructor(
    private readonly usersService: UsersService,
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly config: ConfigService,
  ) {}

  async register(dto: RegisterDto) {
    const existing = await this.usersService.findByEmail(dto.email);
    if (existing) throw new ConflictException('Email already registered');

    const passwordHash = await hash(dto.password, 10);
    const user = await this.prisma.user.create({
      data: { email: dto.email, password: passwordHash },
    });

    return this.issueTokens(user.id);
  }

  async login(dto: LoginDto) {
    const user = await this.usersService.findByEmail(dto.email);
    if (!user?.password) throw new UnauthorizedException('Invalid credentials');

    const valid = await compare(dto.password, user.password);
    if (!valid) throw new UnauthorizedException('Invalid credentials');

    return this.issueTokens(user.id);
  }

  async refresh(refreshToken: string) {
    const record = await this.prisma.refreshToken.findUnique({
      where: { token: refreshToken },
    });

    if (!record || record.expiresAt < new Date()) {
      if (record) await this.prisma.refreshToken.delete({ where: { id: record.id } });
      throw new UnauthorizedException('Refresh token expired or invalid');
    }

    await this.prisma.refreshToken.deleteMany({ where: { id: record.id } });
    return this.issueTokens(record.userId);
  }

  async logout(refreshToken: string) {
    await this.prisma.refreshToken.deleteMany({ where: { token: refreshToken } });
  }

  async loginWithGoogle(dto: GoogleAuthDto) {
    const email = await this.verifyGoogleToken(dto.credential);
    const { user } = await this.usersService.findOrCreateByEmail(email);
    return this.issueTokens(user.id);
  }

  async loginWithTelegram(dto: TelegramAuthDto) {
    this.verifyTelegramHash(dto);
    const { user } = await this.usersService.findOrCreateByTelegramId(BigInt(dto.id));
    return this.issueTokens(user.id);
  }

  async linkGoogle(userId: string, dto: GoogleAuthDto) {
    const email = await this.verifyGoogleToken(dto.credential);
    const existing = await this.usersService.findByEmail(email);
    if (existing && existing.id !== userId) {
      throw new ConflictException('Email already linked to another account');
    }
    await this.usersService.setEmail(userId, email);
    return { success: true };
  }

  async linkTelegram(userId: string, dto: TelegramAuthDto) {
    this.verifyTelegramHash(dto);
    const existing = await this.usersService.findByTelegramId(BigInt(dto.id));
    if (existing && existing.id !== userId) {
      throw new ConflictException('Telegram account already linked to another user');
    }
    await this.usersService.setTelegramId(userId, BigInt(dto.id));
    return { success: true };
  }

  async issueTokens(userId: string) {
    const accessToken = this.jwtService.sign({ sub: userId });

    const token = randomUUID();
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + REFRESH_TOKEN_TTL_DAYS);

    await this.prisma.refreshToken.create({ data: { userId, token, expiresAt } });

    return { accessToken, refreshToken: token };
  }

  private async verifyGoogleToken(credential: string): Promise<string> {
    const clientId = this.config.get<string>('GOOGLE_CLIENT_ID');
    if (!clientId) throw new UnauthorizedException('Google OAuth not configured');

    const response = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${credential}`);
    if (!response.ok) throw new UnauthorizedException('Invalid Google token');

    const data = (await response.json()) as {
      aud?: string;
      email?: string;
      email_verified?: string;
    };

    if (data.aud !== clientId) throw new UnauthorizedException('Token audience mismatch');
    if (!data.email || data.email_verified !== 'true') {
      throw new UnauthorizedException('Email not verified');
    }

    return data.email;
  }

  private verifyTelegramHash(dto: TelegramAuthDto) {
    const { hash: telegramHash, ...fields } = dto;
    const botToken = this.config.get<string>('BOT_TOKEN') ?? '';

    const secretKey = createHash('sha256').update(botToken).digest();
    const dataCheckString = Object.entries(fields)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');

    const expectedHash = createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

    if (telegramHash !== expectedHash)
      throw new UnauthorizedException('Invalid Telegram signature');

    if (Date.now() / 1000 - dto.auth_date > 86400) {
      throw new UnauthorizedException('Telegram auth data expired');
    }
  }
}
